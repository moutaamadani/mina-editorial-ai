// mega-db.js — MEGA-only persistence helpers (customers + credits + sessions + history)
import crypto from "node:crypto";
import { getSupabaseAdmin } from "./supabase.js";

function nowIso() {
  return new Date().toISOString();
}

function intOr(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function addDaysIso(iso, days) {
  const d = iso ? new Date(iso) : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function resolvePassId(req, body = {}) {
  // priority: body.customerId → header X-Mina-Pass-Id → anon
  const fromBody = body?.customerId ? String(body.customerId).trim() : "";
  if (fromBody) return fromBody;

  const fromHeader = req.get("x-mina-pass-id") ? String(req.get("x-mina-pass-id")).trim() : "";
  if (fromHeader) return fromHeader;

  return `pass:anon:${crypto.randomUUID()}`;
}

export async function megaEnsureCustomer({
  passId,
  userId = null,
  email = null,
  shopifyCustomerId = null,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!passId) throw new Error("PASS_ID_REQUIRED");

  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  const ts = nowIso();

  const { data: existing } = await supabase
    .from("mega_customers")
    .select("mg_pass_id, mg_credits, mg_expires_at, mg_created_at")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  const isNew = !existing?.mg_pass_id;

  // Default free credits on first creation (optional)
  const defaultFreeCredits = intOr(process.env.DEFAULT_FREE_CREDITS, 0);
  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);

  const insertCredits = isNew ? defaultFreeCredits : undefined;
  const insertExpiresAt = isNew && defaultFreeCredits > 0 ? addDaysIso(ts, expireDays) : undefined;

  if (isNew) {
    await supabase.from("mega_customers").insert({
      mg_pass_id: passId,
      mg_user_id: userId,
      mg_email: normalizedEmail,
      mg_shopify_customer_id: shopifyCustomerId,
      mg_credits: insertCredits ?? 0,
      mg_expires_at: insertExpiresAt ?? null,
      mg_last_active: ts,
      mg_disabled: false,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    // Keep ledger consistent for the free credits (optional but recommended)
    if (defaultFreeCredits > 0) {
      await megaWriteCreditTxn({
        passId,
        delta: defaultFreeCredits,
        reason: "free_signup",
        source: "system",
        refType: "free_signup",
        refId: passId,
        eventAt: ts,
        meta: { note: "DEFAULT_FREE_CREDITS" },
      });
    }

    return {
      passId,
      credits: insertCredits ?? 0,
      expiresAt: insertExpiresAt ?? null,
      createdAt: ts,
      isNew: true,
    };
  }

  // Update fields + last_active
  await supabase
    .from("mega_customers")
    .update({
      mg_user_id: userId ?? undefined,
      mg_email: normalizedEmail ?? undefined,
      mg_shopify_customer_id: shopifyCustomerId ?? undefined,
      mg_last_active: ts,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", passId);

  return {
    passId,
    credits: existing?.mg_credits ?? 0,
    expiresAt: existing?.mg_expires_at ?? null,
    createdAt: existing?.mg_created_at ?? null,
    isNew: false,
  };
}

export async function megaGetCredits(passId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  return {
    credits: data?.mg_credits ?? 0,
    expiresAt: data?.mg_expires_at ?? null,
  };
}

export async function megaHasCreditRef({ refType, refId } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!refType || !refId) return false;

  const { data } = await supabase
    .from("mega_generations")
    .select("mg_id")
    .eq("mg_record_type", "credit_transaction")
    .eq("mg_ref_type", String(refType))
    .eq("mg_ref_id", String(refId))
    .limit(1);

  return (data?.length ?? 0) > 0;
}

async function megaWriteCreditTxn({
  passId,
  delta,
  reason,
  source,
  refType,
  refId,
  eventAt,
  meta,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const ts = nowIso();
  await supabase.from("mega_generations").insert({
    mg_id: `credit_transaction:${crypto.randomUUID()}`,
    mg_record_type: "credit_transaction",
    mg_pass_id: passId,
    mg_delta: delta,
    mg_reason: reason ?? null,
    mg_source: source ?? null,
    mg_ref_type: refType ?? null,
    mg_ref_id: refId ?? null,
    mg_status: "succeeded",
    mg_meta: meta ?? {},
    mg_event_at: eventAt ?? ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });
}

export async function megaAdjustCredits({
  passId,
  delta,
  reason = "manual",
  source = "api",
  refType = null,
  refId = null,
  grantedAt = null,
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!passId) throw new Error("PASS_ID_REQUIRED");

  const ts = nowIso();
  const eventAt = grantedAt ? new Date(grantedAt).toISOString() : ts;

  // Ensure customer exists
  await megaEnsureCustomer({ passId });

  // Read current
  const { data: row } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  const before = intOr(row?.mg_credits, 0);
  const after = Math.max(0, before + intOr(delta, 0));

  // Rolling expiry on positive grants
  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);
  const currentExpiry = row?.mg_expires_at ? new Date(row.mg_expires_at).toISOString() : null;

  let nextExpiry = currentExpiry;
  if (delta > 0) {
    const candidate = addDaysIso(eventAt, expireDays);
    if (!currentExpiry || new Date(candidate) > new Date(currentExpiry)) {
      nextExpiry = candidate;
    }
  }

  // Update customer balance
  await supabase
    .from("mega_customers")
    .update({
      mg_credits: after,
      mg_expires_at: nextExpiry,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", passId);

  // Ledger row
  await megaWriteCreditTxn({
    passId,
    delta,
    reason,
    source,
    refType,
    refId,
    eventAt,
    meta: { credits_before: before, credits_after: after },
  });

  return { creditsBefore: before, creditsAfter: after, expiresAt: nextExpiry };
}

export async function megaWriteSession({
  passId,
  sessionId,
  platform = "web",
  title = null,
  meta = {},
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!passId) throw new Error("PASS_ID_REQUIRED");
  if (!sessionId) throw new Error("SESSION_ID_REQUIRED");

  const ts = nowIso();

  await supabase.from("mega_generations").insert({
    mg_id: `session:${sessionId}`,
    mg_record_type: "session",
    mg_pass_id: passId,
    mg_session_id: sessionId,
    mg_platform: platform,
    mg_title: title,
    mg_status: "succeeded",
    mg_meta: meta ?? {},
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  return { sessionId };
}

export async function megaWriteFeedback({
  passId,
  generationId = null,
  payload = {},
} = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!passId) throw new Error("PASS_ID_REQUIRED");

  const ts = nowIso();
  const feedbackId = crypto.randomUUID();

  await supabase.from("mega_generations").insert({
    mg_id: `feedback:${feedbackId}`,
    mg_record_type: "feedback",
    mg_pass_id: passId,
    mg_generation_id: generationId,
    mg_status: "succeeded",
    mg_meta: payload ?? {},
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  return { feedbackId };
}

export async function megaGetHistory(passId, { limit = 50 } = {}) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  if (!passId) throw new Error("PASS_ID_REQUIRED");

  const { data } = await supabase
    .from("mega_generations")
    .select(
      "mg_record_type, mg_generation_id, mg_session_id, mg_cre_
