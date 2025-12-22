// mega-db.js — MEGA-only persistence helpers (customers + credits + sessions + parity)
// ESM module
import crypto from "node:crypto";
import { getSupabaseAdmin } from "./supabase.js";

// ------------------------------------------------------
// Small utils
// ------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t.length ? t : fallback;
}

function intOr(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isNonEmpty(v) {
  return !!safeString(v, "");
}

function newAnonPassId() {
  return `pass:anon:${crypto.randomUUID()}`;
}

function normalizeEmail(email) {
  const e = safeString(email, "").toLowerCase();
  return e || null;
}

function parsePassId(passIdRaw) {
  const passId = safeString(passIdRaw, "");
  if (!passId) return { passId: "", kind: "", value: "" };
  const parts = passId.split(":");
  // pass:<kind>:<value...>
  if (parts.length >= 3 && parts[0] === "pass") {
    return { passId, kind: parts[1], value: parts.slice(2).join(":") };
  }
  return { passId, kind: "", value: "" };
}

function derivePassId({ passId, shopifyCustomerId, userId, email } = {}) {
  const incoming = safeString(passId, "");
  if (incoming && incoming.startsWith("pass:")) return incoming;

  const shop = safeString(shopifyCustomerId, "");
  if (shop && shop !== "anonymous") return `pass:shopify:${shop}`;

  const uid = safeString(userId, "");
  if (uid) return `pass:user:${uid}`;

  const em = normalizeEmail(email);
  if (em) return `pass:email:${em}`;

  return newAnonPassId();
}

function requireSupabase(supabase) {
  const sb = supabase || getSupabaseAdmin();
  if (!sb) throw new Error("SUPABASE_NOT_CONFIGURED");
  return sb;
}

// ------------------------------------------------------
// Public helper: resolve passId from request/body (optional convenience)
// priority: body.customerId → header X-Mina-Pass-Id → anon
// ------------------------------------------------------
export function resolvePassId(req, body = {}) {
  const fromBody = safeString(body?.customerId || body?.passId || body?.pass_id, "");
  if (fromBody) return fromBody;

  const fromHeader = safeString(req?.get?.("X-Mina-Pass-Id") || req?.get?.("x-mina-pass-id"), "");
  if (fromHeader) return fromHeader;

  return newAnonPassId();
}

// ------------------------------------------------------
// Customer ensure (MEGA-only)
// Signature compatible with your server.js usage:
//   megaEnsureCustomer(supabaseAdmin, { customerId, userId, email, legacyCredits, passId })
// Returns: { passId, credits, shopifyCustomerId, meta }
// ------------------------------------------------------
export async function megaEnsureCustomer(supabaseOrOptions, maybeOptions = null) {
  // Support calling as:
  //   megaEnsureCustomer(supabase, opts)
  //   megaEnsureCustomer(opts)   (uses getSupabaseAdmin)
  const hasSupabase =
    supabaseOrOptions &&
    typeof supabaseOrOptions === "object" &&
    typeof supabaseOrOptions.from === "function";

  const supabase = requireSupabase(hasSupabase ? supabaseOrOptions : null);
  const opts = hasSupabase ? (maybeOptions || {}) : (supabaseOrOptions || {});

  const ts = nowIso();

  const customerIdRaw = safeString(opts.customerId, "");
  const passIdRaw = safeString(opts.passId, "");
  const userId = safeString(opts.userId, "") || null;
  const email = normalizeEmail(opts.email);

  // If customerId itself is a passId, treat it as passId
  const passIdCandidate =
    passIdRaw ||
    (customerIdRaw.startsWith("pass:") ? customerIdRaw : "");

  // Best-effort shopify id
  const shopifyCustomerIdCandidate =
    customerIdRaw && !customerIdRaw.startsWith("pass:") ? customerIdRaw : null;

  // 1) Try to find existing row
  //    - by passId
  //    - else by shopifyCustomerId
  //    - else by email
  let existing = null;

  if (passIdCandidate) {
    const { data, error } = await supabase
      .from("mega_customers")
      .select(
        "mg_pass_id,mg_shopify_customer_id,mg_user_id,mg_email,mg_credits,mg_expires_at,mg_mma_preferences,mg_disabled,mg_created_at"
      )
      .eq("mg_pass_id", passIdCandidate)
      .maybeSingle();
    if (error) throw error;
    existing = data || null;
  }

  if (!existing && shopifyCustomerIdCandidate && shopifyCustomerIdCandidate !== "anonymous") {
    const { data, error } = await supabase
      .from("mega_customers")
      .select(
        "mg_pass_id,mg_shopify_customer_id,mg_user_id,mg_email,mg_credits,mg_expires_at,mg_mma_preferences,mg_disabled,mg_created_at"
      )
      .eq("mg_shopify_customer_id", shopifyCustomerIdCandidate)
      .order("mg_created_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    existing = (data && data[0]) ? data[0] : null;
  }

  if (!existing && email) {
    const { data, error } = await supabase
      .from("mega_customers")
      .select(
        "mg_pass_id,mg_shopify_customer_id,mg_user_id,mg_email,mg_credits,mg_expires_at,mg_mma_preferences,mg_disabled,mg_created_at"
      )
      .eq("mg_email", email)
      .order("mg_created_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    existing = (data && data[0]) ? data[0] : null;
  }

  // 2) Choose ensured passId + shopify id
  const ensuredPassId = existing?.mg_pass_id || derivePassId({
    passId: passIdCandidate,
    shopifyCustomerId: shopifyCustomerIdCandidate,
    userId,
    email,
  });

  const parsed = parsePassId(ensuredPassId);
  const derivedShopifyFromPass =
    parsed.kind === "shopify" ? safeString(parsed.value, "") : "";

  const ensuredShopifyId =
    safeString(existing?.mg_shopify_customer_id, "") ||
    derivedShopifyFromPass ||
    (shopifyCustomerIdCandidate && shopifyCustomerIdCandidate !== "anonymous"
      ? shopifyCustomerIdCandidate
      : null);

  // 3) Create if missing
  if (!existing) {
    const defaultFreeCredits = intOr(process.env.DEFAULT_FREE_CREDITS, 0);
    const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);

    let expiresAt = null;
    if (defaultFreeCredits > 0) {
      const d = new Date(ts);
      d.setUTCDate(d.getUTCDate() + expireDays);
      expiresAt = d.toISOString();
    }

    const payload = {
      mg_pass_id: ensuredPassId,
      mg_shopify_customer_id: ensuredShopifyId,
      mg_user_id: userId,
      mg_email: email,
      mg_credits: defaultFreeCredits,
      mg_expires_at: expiresAt,
      mg_last_active: ts,
      mg_disabled: false,
      mg_mma_preferences: {}, // safe default
      mg_mma_preferences_updated_at: null,
      mg_created_at: ts,
      mg_updated_at: ts,
    };

    const { error: insErr } = await supabase.from("mega_customers").insert(payload);
    if (insErr) throw insErr;

    // Optional: write a ledger credit txn for free credits
    if (defaultFreeCredits > 0) {
      await megaWriteCreditTxnEvent(supabase, {
        customerId: ensuredShopifyId || "anonymous",
        userId,
        email,
        id: `free_signup:${ensuredPassId}`,
        delta: defaultFreeCredits,
        reason: "free_signup",
        source: "system",
        refType: "free_signup",
        refId: ensuredPassId,
        createdAt: ts,
        nextBalance: defaultFreeCredits,
        passId: ensuredPassId,
      });
    }

    return {
      passId: ensuredPassId,
      credits: defaultFreeCredits,
      shopifyCustomerId: ensuredShopifyId || "anonymous",
      meta: { mma_preferences: {} },
    };
  }

  // 4) Update (non-destructive) + last_active
  const updates = {
    mg_last_active: ts,
    mg_updated_at: ts,
  };

  // only set if provided
  if (userId && !existing.mg_user_id) updates.mg_user_id = userId;
  if (email && !existing.mg_email) updates.mg_email = email;
  if (ensuredShopifyId && !existing.mg_shopify_customer_id) updates.mg_shopify_customer_id = ensuredShopifyId;

  const { error: upErr } = await supabase
    .from("mega_customers")
    .update(updates)
    .eq("mg_pass_id", ensuredPassId);
  if (upErr) throw upErr;

  return {
    passId: ensuredPassId,
    credits: intOr(existing?.mg_credits, 0),
    shopifyCustomerId: ensuredShopifyId || existing?.mg_shopify_customer_id || "anonymous",
    meta: { mma_preferences: existing?.mg_mma_preferences || {} },
  };
}

// ------------------------------------------------------
// Credit transaction event writer
// Updates mega_customers.mg_credits + inserts mega_generations ledger row
// Compatible with your server.js usage.
// ------------------------------------------------------
export async function megaWriteCreditTxnEvent(supabaseOrOptions, maybeOptions = null) {
  const hasSupabase =
    supabaseOrOptions &&
    typeof supabaseOrOptions === "object" &&
    typeof supabaseOrOptions.from === "function";

  const supabase = requireSupabase(hasSupabase ? supabaseOrOptions : null);
  const opts = hasSupabase ? (maybeOptions || {}) : (supabaseOrOptions || {});

  const ts = nowIso();

  const customerId = safeString(opts.customerId, "anonymous");
  const userId = safeString(opts.userId, "") || null;
  const email = normalizeEmail(opts.email);

  const delta = Number(opts.delta ?? 0);
  if (!Number.isFinite(delta)) throw new Error("DELTA_INVALID");

  // Ensure customer + passId
  const ensured = await megaEnsureCustomer(supabase, {
    customerId,
    userId,
    email,
    passId: opts.passId || null,
  });

  const passId = ensured.passId;
  const creditsBefore = intOr(ensured.credits, 0);

  // if caller provided nextBalance trust it, else compute
  const nextBalance = Number.isFinite(Number(opts.nextBalance))
    ? Math.max(0, Number(opts.nextBalance))
    : Math.max(0, creditsBefore + delta);

  const createdAt = safeString(opts.createdAt, ts);
  const mgId = safeString(opts.id, "") || `credit_transaction:${crypto.randomUUID()}`;

  // Update customer balance (expiry handled elsewhere if you want)
  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({
      mg_credits: nextBalance,
      mg_last_active: ts,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", passId);
  if (upErr) throw upErr;

  // Insert ledger row
  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: mgId,
    mg_record_type: "credit_transaction",
    mg_pass_id: passId,
    mg_generation_id: null,
    mg_parent_id: null,
    mg_delta: delta,
    mg_reason: safeString(opts.reason, null),
    mg_source: safeString(opts.source, null),
    mg_ref_type: safeString(opts.refType, null),
    mg_ref_id: safeString(opts.refId, null),
    mg_status: "succeeded",
    mg_meta: {
      credits_before: creditsBefore,
      credits_after: nextBalance,
    },
    mg_event_at: createdAt,
    mg_created_at: ts,
    mg_updated_at: ts,
  });
  if (insErr) throw insErr;

  return { passId, creditsBefore, creditsAfter: nextBalance };
}

// ------------------------------------------------------
// Session event writer (MEGA-only)
// Inserts mega_generations session record + updates customer last_active
// Compatible with your server.js usage.
// ------------------------------------------------------
export async function megaWriteSessionEvent(supabaseOrOptions, maybeOptions = null) {
  const hasSupabase =
    supabaseOrOptions &&
    typeof supabaseOrOptions === "object" &&
    typeof supabaseOrOptions.from === "function";

  const supabase = requireSupabase(hasSupabase ? supabaseOrOptions : null);
  const opts = hasSupabase ? (maybeOptions || {}) : (supabaseOrOptions || {});

  const ts = nowIso();

  const customerId = safeString(opts.customerId, "anonymous");
  const sessionId = safeString(opts.sessionId, "");
  if (!sessionId) throw new Error("SESSION_ID_REQUIRED");

  const platform = safeString(opts.platform, "web");
  const title = safeString(opts.title, "Mina session");
  const createdAt = safeString(opts.createdAt, ts);

  const ensured = await megaEnsureCustomer(supabase, {
    customerId,
    userId: opts.userId || null,
    email: opts.email || null,
    passId: opts.passId || null,
  });

  const passId = ensured.passId;

  // Update customer last_active
  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({ mg_last_active: ts, mg_updated_at: ts })
    .eq("mg_pass_id", passId);
  if (upErr) throw upErr;

  // Insert session record
  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `session:${sessionId}`,
    mg_record_type: "session",
    mg_pass_id: passId,
    mg_generation_id: null,
    mg_parent_id: null,
    mg_session_id: sessionId,
    mg_platform: platform,
    mg_title: title,
    mg_status: "succeeded",
    mg_meta: {},
    mg_event_at: createdAt,
    mg_created_at: ts,
    mg_updated_at: ts,
  });
  if (insErr) throw insErr;

  return { passId, sessionId };
}

// ------------------------------------------------------
// Parity / counts helper (admin)
// ------------------------------------------------------
export async function megaParityCounts(supabaseOrNull = null) {
  const supabase = requireSupabase(supabaseOrNull);

  async function countTable(table, where = null) {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (where) {
      for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    }
    const { count, error } = await q;
    if (error) throw error;
    return Number(count ?? 0);
  }

  const customers = await countTable("mega_customers");
  const generationsTotal = await countTable("mega_generations");
  const adminTotal = await countTable("mega_admin");

  const generationByType = {};
  for (const t of ["generation", "mma_step", "event", "feedback", "session", "credit_transaction"]) {
    generationByType[t] = await countTable("mega_generations", { mg_record_type: t });
  }

  const adminByType = {};
  for (const t of ["error", "admin_audit", "profile", "admin_session"]) {
    adminByType[t] = await countTable("mega_admin", { mg_record_type: t });
  }

  return {
    ok: true,
    ts: nowIso(),
    mega_customers: { total: customers },
    mega_generations: { total: generationsTotal, by_type: generationByType },
    mega_admin: { total: adminTotal, by_type: adminByType },
  };
}

// Optional default export (harmless)
export default {
  resolvePassId,
  megaEnsureCustomer,
  megaWriteSessionEvent,
  megaWriteCreditTxnEvent,
  megaParityCounts,
};
