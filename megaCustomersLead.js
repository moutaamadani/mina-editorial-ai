// megaCustomersLead.js (ESM)
import { getSupabaseAdmin } from "./supabase.js";

function cleanStr(v) {
  const s = String(v || "").trim();
  return s || null;
}

function cleanEmail(v) {
  const e = String(v || "").trim().toLowerCase();
  return e || null;
}

/**
 * Upsert-ish behavior without requiring UNIQUE constraints:
 * - if mg_user_id exists -> update that row
 * - else if mg_email exists -> update that row
 * - else insert
 *
 * Columns we use:
 * - mg_user_id (already used in your auth.js)
 * - mg_email   (already used in your auth.js)
 * - mg_pass_id (we'll add)
 * - mg_shopify_customer_id (we'll add)
 */
export async function upsertMegaCustomerLead({ userId, email, passId, shopifyCustomerId }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, error: "missing_supabase_admin" };

  const mg_user_id = cleanStr(userId);
  const mg_email = cleanEmail(email);
  const mg_pass_id = cleanStr(passId);
  const mg_shopify_customer_id = cleanStr(shopifyCustomerId);

  // if nothing to store, skip silently
  if (!mg_user_id && !mg_email && !mg_pass_id && !mg_shopify_customer_id) {
    return { ok: true, skipped: true };
  }

  const patch = {
    ...(mg_user_id ? { mg_user_id } : {}),
    ...(mg_email ? { mg_email } : {}),
    ...(mg_pass_id ? { mg_pass_id } : {}),
    ...(mg_shopify_customer_id ? { mg_shopify_customer_id } : {}),
    mg_updated_at: new Date().toISOString(),
  };

  try {
    // 1) try by user id
    if (mg_user_id) {
      const { data } = awai
