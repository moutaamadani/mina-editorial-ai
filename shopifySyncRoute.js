// shopifySyncRoute.js (ESM)
"use strict";

import express from "express";
import { getSupabaseAdmin, sbEnabled } from "./supabase.js";
import { megaEnsureCustomer } from "./mega-db.js";
import { findAndTagCustomerByEmail, shopifyConfigured } from "./shopifyAdmin.js";

const ENV = process.env;
const SHOPIFY_MINA_TAG = (ENV.SHOPIFY_MINA_TAG || "Mina_users").trim();

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

function normalizeEmail(email) {
  const em = safeString(email, "").toLowerCase();
  return em || null;
}

async function resolveExistingMegaPassId({ passId, userId, email, shopifyCustomerId }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;

    // 1) explicit passId (if it already exists in DB)
    if (passId) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_pass_id", passId)
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    // 2) match by shopify id
    if (shopifyCustomerId) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_shopify_customer_id", String(shopifyCustomerId))
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    // 3) match by user id
    if (userId) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_user_id", String(userId))
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    // 4) match by email
    if (email) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_email", String(email))
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    return null;
  } catch {
    return null;
  }
}

export function registerShopifySync(app) {
  // We attach a json parser here so order doesn't matter relative to global parsers.
  app.post("/auth/shopify-sync", express.json({ limit: "1mb" }), async (req, res) => {
    const requestId = `shopify_sync_${Date.now()}`;

    const debug =
      ENV.NODE_ENV !== "production" || String(req.get("x-mina-debug") || "") === "1";

    try {
      const body = req.body || {};
      const email = normalizeEmail(body.email);
      const userId = safeString(body.userId, "") || null;
      const passIdInput = safeString(body.passId, "") || null;

      if (!email) {
        return res.status(400).json({ ok: false, requestId, error: "MISSING_EMAIL" });
      }

      // If Shopify isn't configured, don't break auth flow — just return ok with null.
      if (!shopifyConfigured()) {
        return res.status(200).json({
          ok: true,
          requestId,
          shopifyCustomerId: null,
          degraded: true,
          degradedReason: "SHOPIFY_NOT_CONFIGURED",
        });
      }

      // Find Shopify customer by email + best-effort tag
      const { customer, tagged } = await findAndTagCustomerByEmail(email, SHOPIFY_MINA_TAG);
      if (!customer?.id) {
        return res.status(200).json({
          ok: true,
          requestId,
          shopifyCustomerId: null,
          tagged: false,
        });
      }

      const shopifyCustomerId = String(customer.id);

      // Link into MEGA (if Supabase is enabled)
      let passId =
        (await resolveExistingMegaPassId({
          passId: passIdInput,
          userId,
          email,
          shopifyCustomerId,
        })) ||
        passIdInput ||
        (userId ? `pass:user:${userId}` : `pass:email:${email}`);

      if (sbEnabled()) {
        await megaEnsureCustomer({
          passId,
          userId: userId || null,
          email,
          shopifyCustomerId,
        });

        // Force-set shopify id in case megaEnsureCustomer doesn't update existing rows
        const supabase = getSupabaseAdmin();
        if (supabase) {
          await supabase
            .from("mega_customers")
            .update({
              mg_shopify_customer_id: shopifyCustomerId,
              mg_email: email,
              ...(userId ? { mg_user_id: userId } : {}),
            })
            .eq("mg_pass_id", passId);
        }
      }

      res.set("X-Mina-Pass-Id", passId);

      return res.status(200).json({
        ok: true,
        requestId,
        passId,
        shopifyCustomerId,
        tagged: Boolean(tagged),
      });
    } catch (e) {
      // Keep flow non-blocking: return ok with null, but include debug info if allowed.
      return res.status(200).json({
        ok: true,
        requestId,
        shopifyCustomerId: null,
        tagged: false,
        degraded: true,
        degradedReason: "SHOPIFY_SYNC_FAILED",
        ...(debug ? { debugError: e?.message || String(e) } : {}),
      });
    }
  });
}
