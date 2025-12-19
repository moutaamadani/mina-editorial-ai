// Hero Part 1: Database helpers for MEGA tables (no Prisma)
// Part 1.1: This module keeps Supabase write logic tidy and commented in everyday English.
// Part 1.1.1: Tables touched — mega_customers (per customer) and mega_generations (event stream).
// Part 1.2: Common helper utilities (timestamps, safe strings, key validation) feed into every DB write below.

import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

function isRealCustomerKey(v) {
  const s = safeString(v, "");
  if (!s) return false;
  if (s.toLowerCase() === "anonymous") return false;
  return true;
}

function isAnonymousPass(passId) {
  const p = safeString(passId, "");
  return p === "pass_anonymous" || p.startsWith("pass:anon:");
}

function normalizeEmail(v) {
  const s = safeString(v, "").toLowerCase();
  return s || "";
}

function normalizePassId(raw) {
  return safeString(raw, "");
}

function buildPassId({ existingPassId = "", shopifyCustomerId = "", userId = "", email = "" }) {
  const incoming = normalizePassId(existingPassId);
  if (incoming) return incoming;

  const normEmail = normalizeEmail(email);
  if (isRealCustomerKey(shopifyCustomerId)) return `pass:shopify:${shopifyCustomerId}`;
  if (safeString(userId, "")) return `pass:user:${userId}`;
  if (normEmail) return `pass:email:${normEmail}`;
  return `pass:anon:${crypto.randomUUID()}`;
}

function computeDisplayName(first, last, email) {
  const f = safeString(first, "");
  const l = safeString(last, "");
  const n = `${f} ${l}`.trim();
  if (n) return n;
  return safeString(email, "");
}

// Optional: default free credits for brand new customers
function defaultFreeCredits() {
  const n = Number(process.env.DEFAULT_FREE_CREDITS || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

// Optional: set expires_at when adding credits (only if you set env var)
function creditsExpireDays() {
  const n = Number(process.env.CREDITS_EXPIRE_DAYS || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * megaEnsureCustomer
 * - Always ensures a row exists in mega_customers (unless totally anonymous)
 * - Returns { passId, credits, shopifyCustomerId, meta }
 *
 * customerId: your main external key (usually Shopify customer id, or email fallback)
 * userId/email: Supabase auth identity (if available)
 * profile: optional fields to fill mega_customers (names, locale, verification flags...)
 */
export async function megaEnsureCustomer(
  supabaseAdmin,
  { customerId, userId = null, email = null, legacyCredits = null, profile = {}, passId: explicitPassId = null }
) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");

  const customerKey = safeString(customerId, "");
  const incomingPassId = normalizePassId(explicitPassId || (customerKey.startsWith("pass:") ? customerKey : ""));
  const shopifyCustomerId = customerKey.startsWith("pass:") ? "anonymous" : safeString(customerKey, "anonymous");
  const normEmail = normalizeEmail(email);

  // If fully anonymous (no real id + no email + no userId), don't create DB junk rows
  if (!incomingPassId && !isRealCustomerKey(shopifyCustomerId) && !normEmail && !userId) {
    return {
      passId: buildPassId({ existingPassId: incomingPassId, shopifyCustomerId, userId, email: normEmail }),
      credits: 0,
      shopifyCustomerId: "anonymous",
      meta: {},
    };
  }

  // Try to find an existing customer by (shopify id) OR (user id) OR (email)
  const ors = [];
  const potentialPassIds = new Set();
  if (incomingPassId) potentialPassIds.add(incomingPassId);
  if (isRealCustomerKey(shopifyCustomerId)) potentialPassIds.add(`pass:shopify:${shopifyCustomerId}`);
  if (userId) potentialPassIds.add(`pass:user:${userId}`);
  if (normEmail) potentialPassIds.add(`pass:email:${normEmail}`);

  for (const pid of potentialPassIds) {
    ors.push(`mg_pass_id.eq.${pid}`);
  }

  if (isRealCustomerKey(shopifyCustomerId)) ors.push(`mg_shopify_customer_id.eq.${shopifyCustomerId}`);
  if (userId) ors.push(`mg_user_id.eq.${userId}`);
  if (normEmail) ors.push(`mg_email.eq.${normEmail}`);

  let existing = null;

  if (ors.length) {
    const { data, error } = await supabaseAdmin
      .from("mega_customers")
      .select("*")
      .or(ors.join(","))
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    existing = data || null;
  }

  const incomingFirst = safeString(profile.firstName || profile.first_name || "");
  const incomingLast = safeString(profile.lastName || profile.last_name || "");
  const incomingLocale = safeString(profile.locale || "");
  const incomingTimezone = safeString(profile.timezone || "");
  const incomingMarketingOptIn =
    typeof profile.marketingOptIn === "boolean" ? profile.marketingOptIn : null;
  const incomingProductUpdatesOptIn =
    typeof profile.productUpdatesOptIn === "boolean" ? profile.productUpdatesOptIn : null;

  const incomingVerifiedEmail =
    typeof profile.verifiedEmail === "boolean" ? profile.verifiedEmail : null;
  const incomingVerifiedGoogle =
    typeof profile.verifiedGoogle === "boolean" ? profile.verifiedGoogle : null;
  const incomingVerifiedApple =
    typeof profile.verifiedApple === "boolean" ? profile.verifiedApple : null;
  const incomingVerifiedAny =
    typeof profile.verifiedAny === "boolean" ? profile.verifiedAny : null;

  const incomingVerificationMethod = safeString(profile.verificationMethod || "");
  const incomingVerificationAt = profile.verificationAt || null;
  const incomingVerificationKeynumber = safeString(profile.verificationKeynumber || "");

  const resolvedPassId = buildPassId({
    existingPassId: existing?.mg_pass_id || incomingPassId,
    shopifyCustomerId,
    userId,
    email: normEmail,
  });

  // Create new
  if (!existing) {
    const passId = resolvedPassId;
    const startingCredits =
      Number.isFinite(Number(legacyCredits)) ? Number(legacyCredits) : defaultFreeCredits();

    const payload = {
      mg_pass_id: passId,
      mg_shopify_customer_id: isRealCustomerKey(shopifyCustomerId) ? shopifyCustomerId : "anonymous",
      mg_user_id: userId || null,
      mg_email: normEmail || null,

      mg_first_name: incomingFirst || null,
      mg_last_name: incomingLast || null,
      mg_display_name: computeDisplayName(incomingFirst, incomingLast, normEmail) || null,

      mg_locale: incomingLocale || null,
      mg_timezone: incomingTimezone || null,
      mg_marketing_opt_in: incomingMarketingOptIn === null ? false : incomingMarketingOptIn,
      mg_product_updates_opt_in: incomingProductUpdatesOptIn === null ? false : incomingProductUpdatesOptIn,

      mg_credits: Math.floor(startingCredits || 0),
      mg_expires_at: null,
      mg_last_active: nowIso(),

      mg_disabled: false,

      mg_verified_email: incomingVerifiedEmail === null ? false : incomingVerifiedEmail,
      mg_verified_google: incomingVerifiedGoogle === null ? false : incomingVerifiedGoogle,
      mg_verified_apple: incomingVerifiedApple === null ? false : incomingVerifiedApple,
      mg_verified_any: incomingVerifiedAny === null ? false : incomingVerifiedAny,
      mg_verification_method: incomingVerificationMethod || null,
      mg_verification_at: incomingVerificationAt || null,
      mg_verification_keynumber: incomingVerificationKeynumber || null,

      mg_mma_preferences: profile?.mmaPreferences && typeof profile.mmaPreferences === "object" ? profile.mmaPreferences : {},
      mg_mma_preferences_updated_at: null,

      mg_meta: profile.meta && typeof profile.meta === "object" ? profile.meta : {},
      mg_source_system: safeString(profile.sourceSystem || "app"),
      mg_created_at: nowIso(),
      mg_updated_at: nowIso(),
    };

    const { error: insErr } = await supabaseAdmin.from("mega_customers").insert(payload);
    if (insErr) throw insErr;

    return {
      passId,
      credits: payload.mg_credits,
      shopifyCustomerId: payload.mg_shopify_customer_id,
      meta: payload.mg_meta || {},
    };
  }

  // Update existing (fill missing fields + refresh last_active)
  const passId = existing.mg_pass_id || resolvedPassId;
  const updates = {};

  if (!existing.mg_pass_id && passId) updates.mg_pass_id = passId;

  // If we learned a better key, attach it (don’t overwrite real id with "anonymous")
  if (isRealCustomerKey(shopifyCustomerId) && !isRealCustomerKey(existing.mg_shopify_customer_id)) {
    updates.mg_shopify_customer_id = shopifyCustomerId;
  }

  if (userId && !existing.mg_user_id) updates.mg_user_id = userId;
  if (normEmail && !existing.mg_email) updates.mg_email = normEmail;

  if (incomingFirst && !existing.mg_first_name) updates.mg_first_name = incomingFirst;
  if (incomingLast && !existing.mg_last_name) updates.mg_last_name = incomingLast;

  const nextDisplay =
    safeString(existing.mg_display_name, "") ||
    computeDisplayName(incomingFirst || existing.mg_first_name, incomingLast || existing.mg_last_name, normEmail || existing.mg_email);

  if (nextDisplay && nextDisplay !== existing.mg_display_name) updates.mg_display_name = nextDisplay;

  if (incomingLocale && !existing.mg_locale) updates.mg_locale = incomingLocale;
  if (incomingTimezone && !existing.mg_timezone) updates.mg_timezone = incomingTimezone;

  if (incomingMarketingOptIn !== null) updates.mg_marketing_opt_in = incomingMarketingOptIn;
  if (incomingProductUpdatesOptIn !== null) updates.mg_product_updates_opt_in = incomingProductUpdatesOptIn;

  if (incomingVerifiedEmail !== null) updates.mg_verified_email = incomingVerifiedEmail;
  if (incomingVerifiedGoogle !== null) updates.mg_verified_google = incomingVerifiedGoogle;
  if (incomingVerifiedApple !== null) updates.mg_verified_apple = incomingVerifiedApple;
  if (incomingVerifiedAny !== null) updates.mg_verified_any = incomingVerifiedAny;

  if (incomingVerificationMethod) updates.mg_verification_method = incomingVerificationMethod;
  if (incomingVerificationAt) updates.mg_verification_at = incomingVerificationAt;
  if (incomingVerificationKeynumber) updates.mg_verification_keynumber = incomingVerificationKeynumber;

  updates.mg_last_active = nowIso();
  updates.mg_updated_at = nowIso();

  if (Object.keys(updates).length) {
    const { error: upErr } = await supabaseAdmin
      .from("mega_customers")
      .update(updates)
      .eq("mg_pass_id", passId);

    if (upErr) throw upErr;
  }

  return {
    passId,
    credits: Number(existing.mg_credits || 0),
    shopifyCustomerId: existing.mg_shopify_customer_id || shopifyCustomerId,
    meta: existing.mg_meta || {},
  };
}

// -----------------------------
// Events writers
// -----------------------------

export async function megaWriteCreditTxnEvent(
  supabaseAdmin,
  {
    customerId,
    userId = null,
    email = null,
    id,
    delta,
    reason,
    source,
    refType = null,
    refId = null,
    createdAt = null,
    nextBalance = null,
  }
) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");

  const cust = await megaEnsureCustomer(supabaseAdmin, { customerId, userId, email });

  const txId = safeString(id, crypto.randomUUID());
  const ts = createdAt || nowIso();

  // 1) Insert transaction event
  const row = {
    mg_id: `credit_transaction:${txId}`,
    mg_record_type: "credit_transaction",
    mg_pass_id: cust.passId,

    mg_delta: Number(delta || 0),
    mg_reason: safeString(reason, ""),
    mg_source: safeString(source, ""),

    mg_ref_type: refType ? safeString(refType) : null,
    mg_ref_id: refId ? safeString(refId) : null,

    mg_created_at: ts,
    mg_updated_at: ts,
    mg_event_at: ts,

    mg_meta: {
      email: normalizeEmail(email) || null,
      userId: userId || null,
    },
    mg_source_system: "app",
  };

  const { error: insErr } = await supabaseAdmin.from("mega_generations").insert(row);
  if (insErr) throw insErr;

  // 2) Update customer balance
  const updates = {
    mg_updated_at: nowIso(),
    mg_last_active: nowIso(),
  };

  if (Number.isFinite(Number(nextBalance))) {
    updates.mg_credits = Math.floor(Number(nextBalance));
  } else {
    // fallback: add delta onto current value (best-effort)
    updates.mg_credits = Math.floor((cust.credits || 0) + Number(delta || 0));
  }

  // Optional expiry extension if configured
  const expDays = creditsExpireDays();
  if (expDays > 0 && Number(delta || 0) > 0) {
    updates.mg_expires_at = addDaysIso(expDays);
  }

  const { error: upErr } = await supabaseAdmin
    .from("mega_customers")
    .update(updates)
    .eq("mg_pass_id", cust.passId);

  if (upErr) throw upErr;
}

export async function megaWriteSessionEvent(
  supabaseAdmin,
  { customerId, sessionId, platform, title, createdAt }
) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");
  const cust = await megaEnsureCustomer(supabaseAdmin, { customerId });

  if (isAnonymousPass(cust.passId)) return;

  const sid = safeString(sessionId, crypto.randomUUID());
  const ts = createdAt || nowIso();

  const row = {
    mg_id: `session:${sid}`,
    mg_record_type: "session",
    mg_pass_id: cust.passId,
    mg_session_id: sid,
    mg_platform: safeString(platform, "tiktok"),
    mg_title: safeString(title, "Mina session"),
    mg_created_at: ts,
    mg_updated_at: ts,
    mg_event_at: ts,
    mg_source_system: "app",
  };

  // Ignore duplicates
  const { error } = await supabaseAdmin.from("mega_generations").insert(row);
  if (error && !String(error.message || "").toLowerCase().includes("duplicate")) {
    // If your table doesn’t have unique constraints, this will never happen.
    // Safe to ignore only duplicate-like errors.
    throw error;
  }
}

export async function megaWriteGenerationEvent(
  supabaseAdmin,
  { customerId, userId = null, email = null, generation }
) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");

  const cust = await megaEnsureCustomer(supabaseAdmin, {
    customerId,
    userId,
    email,
  });

  if (isAnonymousPass(cust.passId)) return;

  const g = generation || {};
  const ts = g.createdAt || nowIso();

  const generationId = safeString(g.id, crypto.randomUUID());

  const row = {
    mg_id: `generation:${generationId}`,
    mg_record_type: "generation",
    mg_pass_id: cust.passId,

    mg_session_id: safeString(g.sessionId || ""),
    mg_generation_id: generationId,
    mg_platform: safeString(g.platform || ""),
    mg_title: safeString(g.title || ""),
    mg_type: safeString(g.type || "image"),

    mg_prompt: safeString(g.prompt || ""),
    mg_output_url: safeString(g.outputUrl || ""),
    mg_output_key: safeString(g.outputKey || ""),

    mg_provider: safeString(g.meta?.provider || ""),
    mg_model: safeString(g.meta?.model || ""),
    mg_latency_ms: Number(g.meta?.latencyMs || 0) || null,
    mg_input_chars: Number(g.meta?.inputChars || 0) || null,
    mg_output_chars: Number(g.meta?.outputChars || 0) || null,

    mg_status: safeString(g.meta?.status || "succeeded"),
    mg_error: safeString(g.meta?.error || ""),

    mg_meta: g.meta && typeof g.meta === "object" ? g.meta : {},
    mg_payload: g && typeof g === "object" ? g : {},
    mg_source_system: "app",

    mg_created_at: ts,
    mg_updated_at: ts,
    mg_event_at: ts,
  };

  const { error } = await supabaseAdmin.from("mega_generations").insert(row);
  if (error) throw error;
}

export async function megaWriteFeedbackEvent(
  supabaseAdmin,
  { customerId, feedback }
) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");

  const cust = await megaEnsureCustomer(supabaseAdmin, { customerId });

  if (isAnonymousPass(cust.passId)) return;

  const fb = feedback || {};
  const ts = fb.createdAt || nowIso();
  const meta = fb && typeof fb.meta === "object" ? fb.meta : {};

  const row = {
    mg_id: `feedback:${safeString(fb.id, crypto.randomUUID())}`,
    mg_record_type: "feedback",
    mg_pass_id: cust.passId,

    mg_session_id: safeString(fb.sessionId || ""),
    mg_generation_id: safeString(fb.generationId || ""),
    mg_platform: safeString(fb.platform || meta.platform || ""),
    mg_title: safeString(fb.title || meta.title || ""),
    mg_type: safeString(fb.type || fb.resultType || meta.type || meta.resultType || "image"),
    mg_result_type: safeString(fb.resultType || meta.resultType || "image"),
    mg_prompt: safeString(fb.prompt || ""),
    mg_content_type: safeString(fb.contentType || meta.contentType || ""),

    mg_output_url: safeString(
      fb.outputUrl || fb.imageUrl || fb.videoUrl || meta.outputUrl || ""
    ),
    mg_output_key: safeString(fb.outputKey || meta.outputKey || ""),
    mg_provider: safeString(fb.provider || meta.provider || ""),
    mg_model: safeString(fb.model || meta.model || ""),
    mg_latency_ms: Number(meta.latencyMs ?? fb.latencyMs ?? 0) || null,
    mg_input_chars: Number(meta.inputChars ?? fb.inputChars ?? 0) || null,
    mg_output_chars: Number(meta.outputChars ?? fb.outputChars ?? 0) || null,
    mg_input_tokens: Number(meta.inputTokens ?? fb.inputTokens ?? 0) || null,
    mg_output_tokens: Number(meta.outputTokens ?? fb.outputTokens ?? 0) || null,
    mg_status: safeString(fb.status || meta.status || "succeeded"),
    mg_error: safeString(fb.error || meta.error || ""),
    mg_comment: safeString(fb.comment || ""),
    mg_image_url: safeString(fb.imageUrl || ""),
    mg_video_url: safeString(fb.videoUrl || ""),

    mg_meta: meta,
    mg_payload: fb && typeof fb === "object" ? fb : {},
    mg_source_system: "app",

    mg_created_at: ts,
    mg_updated_at: ts,
    mg_event_at: ts,
  };

  const { error } = await supabaseAdmin.from("mega_generations").insert(row);
  if (error) throw error;
}

export async function megaParityCounts(supabaseAdmin) {
  if (!supabaseAdmin) throw new Error("NO_SUPABASE_CLIENT");

  const [cust, gen] = await Promise.all([
    supabaseAdmin.from("mega_customers").select("mg_pass_id", { count: "exact", head: true }),
    supabaseAdmin.from("mega_generations").select("mg_id", { count: "exact", head: true }),
  ]);

  return {
    mega_customers: cust.count ?? 0,
    mega_generations: gen.count ?? 0,
  };
}
