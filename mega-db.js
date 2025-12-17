// mega-db.js
"use strict";

import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  if (!email) return null;
  const s = String(email).trim().toLowerCase();
  return s || null;
}

function safeShopifyId(customerIdRaw) {
  const v = customerIdRaw === null || customerIdRaw === undefined ? "" : String(customerIdRaw);
  return v.trim() || "anonymous";
}

function isAnonymousCustomerId(customerIdRaw) {
  return safeShopifyId(customerIdRaw) === "anonymous";
}

function namespacedId(prefix, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.startsWith(`${prefix}:`)) return v;
  return `${prefix}:${v}`;
}

/**
 * Find an existing PassID from any known identifiers (priority: user_id -> email -> shopify_customer_id).
 * Returns passId string or null.
 */
async function megaFindPassId(supabaseAdmin, { customerId, userId, email }) {
  if (!supabaseAdmin) return null;

  const shopifyId = safeShopifyId(customerId);
  const normEmail = normalizeEmail(email);

  // 1) user_id
  if (userId) {
    const { data, error } = await supabaseAdmin
      .from("mega_customers")
      .select("mg_pass_id")
      .eq("mg_user_id", userId)
      .limit(1);

    if (!error && Array.isArray(data) && data[0]?.mg_pass_id) return data[0].mg_pass_id;
  }

  // 2) email
  if (normEmail) {
    const { data, error } = await supabaseAdmin
      .from("mega_customers")
      .select("mg_pass_id")
      .eq("mg_email", normEmail)
      .limit(1);

    if (!error && Array.isArray(data) && data[0]?.mg_pass_id) return data[0].mg_pass_id;
  }

  // 3) shopify_customer_id (skip "anonymous")
  if (shopifyId && shopifyId !== "anonymous") {
    const { data, error } = await supabaseAdmin
      .from("mega_customers")
      .select("mg_pass_id")
      .eq("mg_shopify_customer_id", shopifyId)
      .limit(1);

    if (!error && Array.isArray(data) && data[0]?.mg_pass_id) return data[0].mg_pass_id;
  }

  return null;
}

/**
 * Ensure MEGA customer exists and is linked to identifiers.
 * - Creates PassID if none exists
 * - Updates mapping fields if newly known
 * - Optionally syncs credits from legacy
 *
 * Returns: { passId }
 */
export async function megaEnsureCustomer(
  supabaseAdmin,
  { customerId, userId, email, legacyCredits = null }
) {
  if (!supabaseAdmin) return { passId: null, credits: null };

  const shopifyId = safeShopifyId(customerId);
  const normEmail = normalizeEmail(email);

  // Avoid creating infinite MEGA customers for totally anonymous users
  // (if no email/userId, we return null passId unless you pass a non-anon customerId)
  const hasStrongId = !!userId || !!normEmail || (shopifyId && shopifyId !== "anonymous");
  if (!hasStrongId) {
    return { passId: null, credits: null };
  }

  const existingPassId = await megaFindPassId(supabaseAdmin, { customerId: shopifyId, userId, email: normEmail });
  const ts = nowIso();

  if (existingPassId) {
    // Touch + attach missing mapping fields + optionally sync credits
    const updates = {
      mg_updated_at: ts,
      mg_last_active: ts,
    };

    if (userId) updates.mg_user_id = userId;
    if (normEmail) updates.mg_email = normEmail;
    if (shopifyId && shopifyId !== "anonymous") updates.mg_shopify_customer_id = shopifyId;

    if (typeof legacyCredits === "number" && Number.isFinite(legacyCredits)) {
      updates.mg_credits = Math.floor(legacyCredits);
    }

    // Best-effort
    try {
      await supabaseAdmin.from("mega_customers").update(updates).eq("mg_pass_id", existingPassId);
    } catch (_) {}

    const { data } = await supabaseAdmin
      .from("mega_customers")
      .select("mg_pass_id,mg_credits,mg_shopify_customer_id,mg_user_id,mg_email,mg_meta")
      .eq("mg_pass_id", existingPassId)
      .maybeSingle();

    return {
      passId: existingPassId,
      credits: data?.mg_credits ?? null,
      shopifyCustomerId: data?.mg_shopify_customer_id || null,
      userId: data?.mg_user_id || null,
      email: data?.mg_email || null,
      meta: data?.mg_meta || {},
    };
  }

  // Create new (deterministic PassID rule)
  const passId = isAnonymousCustomerId(shopifyId)
    ? userId
      ? namespacedId("pass:user", userId)
      : namespacedId("pass:anon", crypto.randomUUID())
    : namespacedId("pass:shopify", shopifyId);

  const payload = {
    mg_pass_id: passId,
    mg_shopify_customer_id: shopifyId !== "anonymous" ? shopifyId : null,
    mg_user_id: userId || null,
    mg_email: normEmail,
    mg_credits:
      typeof legacyCredits === "number" && Number.isFinite(legacyCredits) ? Math.floor(legacyCredits) : 0,
    mg_topup_default_packs: 3,
    mg_created_at: ts,
    mg_updated_at: ts,
    mg_last_active: ts,
    mg_disabled: false,
    mg_meta: {},
  };

  const { error } = await supabaseAdmin.from("mega_customers").insert(payload);
  if (error) {
    // If insertion failed due to race/unique, try resolving again
    const retry = await megaFindPassId(supabaseAdmin, { customerId: shopifyId, userId, email: normEmail });
    if (retry) {
      const { data } = await supabaseAdmin
        .from("mega_customers")
        .select("mg_pass_id,mg_credits,mg_shopify_customer_id,mg_user_id,mg_email,mg_meta")
        .eq("mg_pass_id", retry)
        .maybeSingle();

      return {
        passId: retry,
        credits: data?.mg_credits ?? null,
        shopifyCustomerId: data?.mg_shopify_customer_id || null,
        userId: data?.mg_user_id || null,
        email: data?.mg_email || null,
        meta: data?.mg_meta || {},
      };
    }

    return { passId: null, credits: null };
  }

  return {
    passId,
    credits: payload.mg_credits,
    shopifyCustomerId: payload.mg_shopify_customer_id,
    userId: payload.mg_user_id,
    email: payload.mg_email,
    meta: payload.mg_meta,
  };
}

async function megaUpsertLedgerRow(supabaseAdmin, row) {
  if (!supabaseAdmin) return;
  if (!row?.mg_id || !row?.mg_record_type || !row?.mg_pass_id) return;

  const payload = {
    mg_created_at: row.mg_created_at || nowIso(),
    mg_updated_at: row.mg_updated_at || nowIso(),
    ...row,
  };

  if (payload.mg_meta === undefined || payload.mg_meta === null) payload.mg_meta = {};
  if (payload.mg_payload === undefined || payload.mg_payload === null) payload.mg_payload = {};

  // Best-effort upsert
  await supabaseAdmin.from("mega_generations").upsert(payload, { onConflict: "mg_id" });
}

/**
 * SESSION dual-write
 */
export async function megaWriteSessionEvent(
  supabaseAdmin,
  { customerId, userId = null, email = null, sessionId, platform, title, createdAt }
) {
  const { passId, shopifyCustomerId } = await megaEnsureCustomer(supabaseAdmin, {
    customerId,
    userId,
    email,
    legacyCredits: null,
  });

  if (!passId) return { passId: null };

  await megaUpsertLedgerRow(supabaseAdmin, {
    mg_id: namespacedId("session", sessionId),
    mg_record_type: "session",
    mg_pass_id: passId,
    mg_session_id: String(sessionId),
    mg_platform: platform ? String(platform) : null,
    mg_title: title ? String(title) : null,
    mg_created_at: createdAt || nowIso(),
    mg_meta: { source: "legacy.sessions" },
    mg_payload: {
      shopifyCustomerId: shopifyCustomerId || safeShopifyId(customerId),
      sessionId: String(sessionId),
      platform: platform ? String(platform) : null,
      title: title ? String(title) : null,
      createdAt: createdAt || nowIso(),
    },
  });

  return { passId };
}

/**
 * GENERATION dual-write
 */
export async function megaWriteGenerationEvent(
  supabaseAdmin,
  { customerId, userId = null, email = null, generation }
) {
  const { passId, shopifyCustomerId } = await megaEnsureCustomer(supabaseAdmin, {
    customerId,
    userId,
    email,
    legacyCredits: null,
  });

  if (!passId) return { passId: null };
  const g = generation || {};

  await megaUpsertLedgerRow(supabaseAdmin, {
    mg_id: namespacedId("generation", g.id),
    mg_record_type: "generation",
    mg_pass_id: passId,
    mg_session_id: g.sessionId ? String(g.sessionId) : null,
    mg_generation_id: g.id ? String(g.id) : null,
    mg_platform: g.platform ? String(g.platform) : null,
    mg_type: g.type ? String(g.type) : null,
    mg_prompt: g.prompt ? String(g.prompt) : null,
    mg_output_url: g.outputUrl ? String(g.outputUrl) : null,
    mg_output_key: g.outputKey ? String(g.outputKey) : null,
    mg_provider: g.provider ? String(g.provider) : (g.meta?.provider ? String(g.meta.provider) : null),
    mg_model: g.model ? String(g.model) : (g.meta?.model ? String(g.meta.model) : null),
    mg_latency_ms: typeof g.meta?.latencyMs === "number" ? g.meta.latencyMs : null,
    mg_input_chars: typeof g.meta?.inputChars === "number" ? g.meta.inputChars : null,
    mg_output_chars: typeof g.meta?.outputChars === "number" ? g.meta.outputChars : null,
    mg_status: g.meta?.status ? String(g.meta.status) : "succeeded",
    mg_error: g.meta?.error ? String(g.meta.error) : null,
    mg_created_at: g.createdAt || nowIso(),
    mg_meta: g.meta ?? {},
    mg_payload: { ...g, shopifyCustomerId: shopifyCustomerId || safeShopifyId(customerId) },
  });

  return { passId };
}

/**
 * FEEDBACK dual-write
 */
export async function megaWriteFeedbackEvent(
  supabaseAdmin,
  { customerId, userId = null, email = null, feedback }
) {
  const { passId, shopifyCustomerId } = await megaEnsureCustomer(supabaseAdmin, {
    customerId,
    userId,
    email,
    legacyCredits: null,
  });

  if (!passId) return { passId: null };
  const f = feedback || {};

  await megaUpsertLedgerRow(supabaseAdmin, {
    mg_id: namespacedId("feedback", f.id),
    mg_record_type: "feedback",
    mg_pass_id: passId,
    mg_session_id: f.sessionId ? String(f.sessionId) : null,
    mg_generation_id: f.generationId ? String(f.generationId) : null,
    mg_platform: f.platform ? String(f.platform) : null,
    mg_result_type: f.resultType ? String(f.resultType) : null,
    mg_prompt: f.prompt ? String(f.prompt) : null,
    mg_comment: f.comment ? String(f.comment) : null,
    mg_image_url: f.imageUrl ? String(f.imageUrl) : null,
    mg_video_url: f.videoUrl ? String(f.videoUrl) : null,
    mg_created_at: f.createdAt || nowIso(),
    mg_meta: { source: "legacy.feedback" },
    mg_payload: { ...f, shopifyCustomerId: shopifyCustomerId || safeShopifyId(customerId) },
  });

  return { passId };
}

/**
 * CREDIT TXN dual-write
 * Note: id can be legacy credit txn UUID or any unique string you generate.
 */
export async function megaWriteCreditTxnEvent(
  supabaseAdmin,
  { customerId, userId = null, email = null, id, delta, reason, source, refType = null, refId = null, createdAt = null, nextBalance = null }
) {
  const { passId, shopifyCustomerId } = await megaEnsureCustomer(supabaseAdmin, {
    customerId,
    userId,
    email,
    legacyCredits: null,
  });

  if (!passId) return { passId: null };

  await megaUpsertLedgerRow(supabaseAdmin, {
    mg_id: namespacedId("credit_transaction", id || `ctx_${crypto.randomUUID()}`),
    mg_record_type: "credit_transaction",
    mg_pass_id: passId,
    mg_delta: typeof delta === "number" ? Math.floor(delta) : Number(delta || 0),
    mg_reason: reason ? String(reason) : null,
    mg_source: source ? String(source) : null,
    mg_ref_type: refType ? String(refType) : null,
    mg_ref_id: refId ? String(refId) : null,
    mg_created_at: createdAt || nowIso(),
    mg_meta: { source: "legacy.credit_transactions" },
    mg_payload: {
      id: id || null,
      delta: typeof delta === "number" ? Math.floor(delta) : Number(delta || 0),
      reason: reason || null,
      source: source || null,
      refType: refType || null,
      refId: refId || null,
      createdAt: createdAt || nowIso(),
      nextBalance: typeof nextBalance === "number" ? nextBalance : null,
    },
  });

  if (typeof nextBalance === "number" && Number.isFinite(nextBalance)) {
    try {
      await supabaseAdmin
        .from("mega_customers")
        .update({ mg_credits: Math.floor(nextBalance), mg_updated_at: nowIso() })
        .eq("mg_pass_id", passId);
    } catch (_) {}
  }

  return { passId };
}

/**
 * Admin parity counts (cheap, safe)
 */
export async function megaParityCounts(supabaseAdmin) {
  if (!supabaseAdmin) return null;

  const count = async (table, col = "*", filter = null) => {
    let q = supabaseAdmin.from(table).select(col, { count: "exact", head: true });
    if (filter?.eq) q = q.eq(filter.eq[0], filter.eq[1]);
    const { count: c, error } = await q;
    if (error) return null;
    return c ?? 0;
  };

  const [megaCustomers, megaSessions, megaGenerations, megaFeedback, megaCreditTxns] = await Promise.all([
    count("mega_customers", "mg_pass_id"),
    count("mega_generations", "mg_id", { eq: ["mg_record_type", "session"] }),
    count("mega_generations", "mg_id", { eq: ["mg_record_type", "generation"] }),
    count("mega_generations", "mg_id", { eq: ["mg_record_type", "feedback"] }),
    count("mega_generations", "mg_id", { eq: ["mg_record_type", "credit_transaction"] }),
  ]);

  return {
    mega: {
      customers: megaCustomers,
      sessions: megaSessions,
      generations: megaGenerations,
      feedback: megaFeedback,
      credit_transactions: megaCreditTxns,
    },
    meta: { generatedAt: nowIso() },
  };
}
