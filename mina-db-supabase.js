//mina-editorial-ai/mina-db-supabase.js
// mina-db-supabase.js
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Service-role client (server-side only)
export const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

export function isSupabaseDataReady() {
  return !!supabaseAdmin;
}

function nowIso() {
  return new Date().toISOString();
}

function safeShopifyId(customerIdRaw) {
  const v = customerIdRaw === null || customerIdRaw === undefined ? "" : String(customerIdRaw);
  return v.trim() || "anonymous";
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function normalizeSessionId(sessionIdRaw) {
  const s = (sessionIdRaw || "").toString().trim();
  if (!s) return "";
  if (s.startsWith("sess_")) {
    const maybe = s.slice("sess_".length);
    return isUuid(maybe) ? maybe : s; // fallback if weird
  }
  return s;
}

export function normalizeFeedbackId(feedbackIdRaw) {
  const s = (feedbackIdRaw || "").toString().trim();
  if (!s) return "";
  if (s.startsWith("fb_")) {
    const maybe = s.slice("fb_".length);
    return isUuid(maybe) ? maybe : s;
  }
  return s;
}

async function getCustomerRow(shopifyCustomerId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,user_id,email,credits,meta,created_at,updated_at,last_active,expires_at")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createCustomerRow({ shopifyCustomerId, userId, email, defaultCredits }) {
  if (!supabaseAdmin) return null;

  const ts = nowIso();
  const payload = {
    shopify_customer_id: shopifyCustomerId,
    user_id: userId || null,
    email: email || null,
    credits: Number.isFinite(defaultCredits) ? defaultCredits : 0,
    last_active: ts,
    created_at: ts,
    updated_at: ts,
    meta: {},
  };

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert(payload)
    .select("shopify_customer_id,user_id,email,credits,meta,created_at,updated_at,last_active,expires_at")
    .single();

  if (error) throw error;
  return data;
}

async function touchCustomer({ shopifyCustomerId, userId, email, patchMeta }) {
  if (!supabaseAdmin) return;

  const ts = nowIso();
  const updates = {
    updated_at: ts,
    last_active: ts,
  };

  // Only set these if provided (don’t overwrite with null)
  if (userId) updates.user_id = userId;
  if (email) updates.email = email;

  if (patchMeta && typeof patchMeta === "object") {
    // merge meta client-side
    const existing = await getCustomerRow(shopifyCustomerId);
    const nextMeta = { ...(existing?.meta || {}), ...patchMeta };
    updates.meta = nextMeta;
  }

  const { error } = await supabaseAdmin
    .from("customers")
    .update(updates)
    .eq("shopify_customer_id", shopifyCustomerId);

  if (error) throw error;
}

export async function getOrCreateCustomer({
  customerId,
  userId,
  email,
  defaultCredits = 0,
}) {
  const shopifyCustomerId = safeShopifyId(customerId);
  if (!supabaseAdmin) return null;

  let row = await getCustomerRow(shopifyCustomerId);
  if (!row) {
    row = await createCustomerRow({
      shopifyCustomerId,
      userId,
      email,
      defaultCredits,
    });
  } else {
    // update last_active (+ attach user/email if they exist)
    await touchCustomer({ shopifyCustomerId, userId, email });
  }
  return row;
}

/**
 * Returns: { balance, customer, historyLength }
 */
export async function getCreditsRecordDb({
  customerId,
  userId,
  email,
  defaultFreeCredits = 0,
}) {
  if (!supabaseAdmin) {
    return { balance: null, customer: null, historyLength: null };
  }

  const cust = await getOrCreateCustomer({
    customerId,
    userId,
    email,
    defaultCredits: defaultFreeCredits,
  });

  // Count txns (optional, can be null if you want cheaper)
  const { count, error: countErr } = await supabaseAdmin
    .from("credit_transactions")
    .select("id", { count: "exact", head: true })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (countErr) {
    // don’t fail the request for count
    return { balance: cust.credits ?? 0, customer: cust, historyLength: null };
  }

  return { balance: cust.credits ?? 0, customer: cust, historyLength: count ?? null };
}

/**
 * Adjust credits + insert credit_transactions row.
 * NOTE: This is not fully atomic without a SQL function. Good enough for low concurrency.
 */
export async function adjustCreditsDb({
  customerId,
  delta,
  reason = "adjustment",
  source = "api",
  refType = null,
  refId = null,
  userId,
  email,
  defaultFreeCredits = 0,
}) {
  if (!supabaseAdmin) {
    return { ok: false, balance: null };
  }

  const cust = await getOrCreateCustomer({
    customerId,
    userId,
    email,
    defaultCredits: defaultFreeCredits,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);
  const ts = nowIso();

  // 1) update customer balance
  const { error: updErr } = await supabaseAdmin
    .from("customers")
    .update({
      credits: nextBalance,
      updated_at: ts,
      last_active: ts,
      ...(userId ? { user_id: userId } : {}),
      ...(email ? { email } : {}),
    })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (updErr) throw updErr;

  // 2) insert transaction
  const txn = {
    id: crypto.randomUUID(),
    shopify_customer_id: cust.shopify_customer_id,
    delta: Number(delta || 0),
    reason: String(reason || "adjustment"),
    source: String(source || "api"),
    ref_type: refType ? String(refType) : null,
    ref_id: refId ? String(refId) : null,
    created_at: ts,
  };

  const { error: insErr } = await supabaseAdmin.from("credit_transactions").insert(txn);
  if (insErr) {
    // If txn insert fails, balance already updated. Log and continue.
    console.error("[credits] Failed to insert credit_transactions row", insErr);
  }

  return { ok: true, balance: nextBalance };
}

export async function upsertAppSessionDb({ id, shopifyCustomerId, platform, title, createdAt }) {
  if (!supabaseAdmin) return;

  const sid = normalizeSessionId(id);
  if (!sid || !isUuid(sid)) {
    throw new Error(`Session id must be UUID (got: ${id})`);
  }

  const payload = {
    id: sid,
    shopify_customer_id: safeShopifyId(shopifyCustomerId),
    platform: (platform || "tiktok").toString(),
    title: (title || "Mina session").toString(),
    created_at: createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("sessions").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

export async function upsertFeedbackDb(feedback) {
  if (!supabaseAdmin) return;

  const fid = normalizeFeedbackId(feedback?.id);
  if (!fid || !isUuid(fid)) {
    throw new Error(`Feedback id must be UUID (got: ${feedback?.id})`);
  }

  const payload = {
    id: fid,
    shopify_customer_id: safeShopifyId(feedback.shopify_customer_id),
    session_id: feedback.session_id ? normalizeSessionId(feedback.session_id) : null,
    generation_id: feedback.generation_id ? String(feedback.generation_id) : null,
    result_type: String(feedback.result_type || "image"),
    platform: feedback.platform ? String(feedback.platform) : null,
    prompt: String(feedback.prompt || ""),
    comment: feedback.comment ? String(feedback.comment) : null,
    image_url: feedback.image_url ? String(feedback.image_url) : null,
    video_url: feedback.video_url ? String(feedback.video_url) : null,
    created_at: feedback.created_at || nowIso(),
  };

  const { error } = await supabaseAdmin.from("feedback").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

export async function getBillingSettingsDb(customerId) {
  if (!supabaseAdmin) return { enabled: false, monthlyLimitPacks: 0, source: "no-db" };

  const cust = await getOrCreateCustomer({ customerId, defaultCredits: 0 });
  const meta = cust?.meta || {};
  const autoTopup = meta.autoTopup || {};
  return {
    enabled: Boolean(autoTopup.enabled),
    monthlyLimitPacks: Number.isFinite(autoTopup.monthlyLimitPacks)
      ? Math.max(0, Math.floor(autoTopup.monthlyLimitPacks))
      : 0,
    source: "customers.meta",
  };
}

export async function setBillingSettingsDb(customerId, enabled, monthlyLimitPacks) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const cust = await getOrCreateCustomer({ customerId, defaultCredits: 0 });
  const meta = cust?.meta || {};
  const nextMeta = {
    ...meta,
    autoTopup: {
      enabled: Boolean(enabled),
      monthlyLimitPacks: Number.isFinite(monthlyLimitPacks)
        ? Math.max(0, Math.floor(monthlyLimitPacks))
        : 0,
    },
  };

  await touchCustomer({
    shopifyCustomerId: cust.shopify_customer_id,
    patchMeta: nextMeta,
  });

  return {
    enabled: Boolean(nextMeta.autoTopup.enabled),
    monthlyLimitPacks: nextMeta.autoTopup.monthlyLimitPacks,
  };
}

export async function countCustomersDb() {
  if (!supabaseAdmin) return null;
  const { count, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function listCustomersDb(limit = 500) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,credits,email,last_active,created_at,updated_at")
    .order("shopify_customer_id", { ascending: true })
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  if (error) throw error;
  return data || [];
}

export async function getCustomerHistoryDb(shopifyCustomerId) {
  if (!supabaseAdmin) return null;
  const sid = safeShopifyId(shopifyCustomerId);

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("customers")
      .select("shopify_customer_id,credits")
      .eq("shopify_customer_id", sid)
      .maybeSingle(),
    supabaseAdmin
      .from("generations")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("feedback")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: sid,
    credits: {
      balance: custRes.data?.credits ?? 0,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

export async function getAdminOverviewDb() {
  if (!supabaseAdmin) return null;

  const [gensRes, fbRes] = await Promise.all([
    supabaseAdmin.from("generations").select("*").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("feedback").select("*").order("created_at", { ascending: false }).limit(500),
  ]);

  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;

  return {
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

