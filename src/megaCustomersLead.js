// src/megaCustomersLead.js (ESM)
// Minimal “lead capture” helper that is SAFE and cannot break deploy.
// It simply links email/userId/shopifyCustomerId to the MEGA customer row.

"use strict";

import { sbEnabled } from "../supabase.js";
import { megaEnsureCustomer } from "../mega-db.js";

function cleanStr(v) {
  const s = String(v || "").trim();
  return s || null;
}

function normalizeEmail(v) {
  const e = cleanStr(v);
  return e ? e.toLowerCase() : null;
}

function supabaseOk() {
  return typeof sbEnabled === "function" ? sbEnabled() : !!sbEnabled;
}

/**
 * Upsert/Link a "lead" into MEGA.
 * This does NOT create any new tables.
 * It just uses megaEnsureCustomer() which you already rely on everywhere.
 */
export async function upsertMegaCustomerLead({
  passId,
  email,
  userId = null,
  shopifyCustomerId = null,
} = {}) {
  const pid = cleanStr(passId);
  const em = normalizeEmail(email);

  if (!pid && !em) {
    return { ok: false, error: "missing_passId_or_email" };
  }

  // If Supabase is not configured, be non-blocking.
  if (!supabaseOk()) {
    return { ok: true, degraded: true, reason: "NO_SUPABASE" };
  }

  const finalPassId = pid || `pass:email:${em}`;

  await megaEnsureCustomer({
    passId: finalPassId,
    email: em,
    userId: cleanStr(userId),
    shopifyCustomerId: cleanStr(shopifyCustomerId),
  });

  return { ok: true, passId: finalPassId };
}
