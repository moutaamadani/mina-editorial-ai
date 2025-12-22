// megaCustomersLead.js — minimal upsert into mega_customers for lead capture
"use strict";

import { getSupabaseAdmin, sbEnabled } from "./supabase.js";

function cleanStr(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normalizeEmail(v) {
  const e = String(v ?? "").trim().toLowerCase();
  return e || null;
}

async function tryUpsertRow(supabase, row) {
  const { error } = await supabase.from("mega_customers").upsert(row, { onConflict: "mg_pass_id" });
  if (!error) return { ok: true };
  return { ok: false, error };
}

/**
 * Safe upsert: if your table doesn’t have mg_shopify_customer_id,
 * we retry without it instead of crashing the whole route.
 */
export async function upsertMegaCustomerLead({
  passId,
  email = null,
  userId = null,
  shopifyCustomerId = null,
} = {}) {
  if (!sbEnabled()) return { ok: false, degraded: true, reason: "NO_SUPABASE" };

  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, degraded: true, reason: "NO_SUPABASE" };

  const pid = cleanStr(passId);
  if (!pid) return { ok: false, error: "MISSING_PASS_ID" };

  const rowBase = { mg_pass_id: pid };

  const em = normalizeEmail(email);
  const uid = cleanStr(userId);
  const sid = cleanStr(shopifyCustomerId);

  if (em) rowBase.mg_email = em;
  if (uid) rowBase.mg_user_id = uid;
  if (sid) rowBase.mg_shopify_customer_id = sid;

  // First try with everything
  const first = await tryUpsertRow(supabase, rowBase);
  if (first.ok) return { ok: true };

  // Retry without shopify column if it doesn't exist
  const msg = String(first.error?.message || "");
  if (msg.toLowerCase().includes("mg_shopify_customer_id") && msg.toLowerCase().includes("does not exist")) {
    const retryRow = { mg_pass_id: pid };
    if (em) retryRow.mg_email = em;
    if (uid) retryRow.mg_user_id = uid;

    const second = await tryUpsertRow(supabase, retryRow);
    if (second.ok) return { ok: true, degraded: true, reason: "NO_SHOPIFY_COLUMN" };
  }

  // Otherwise bubble the error (real issue)
  throw first.error;
}
