// shopifySyncRoute.js — POST /auth/shopify-sync
"use strict";

import express from "express";
import { findAndTagCustomerByEmail, getShopifyConfig } from "./shopifyAdmin.js";
import { upsertMegaCustomerLead } from "./megaCustomersLead.js";

function cleanStr(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normalizeEmail(v) {
  const e = String(v ?? "").trim().toLowerCase();
  return e || null;
}

export function registerShopifySync(app) {
  const router = express.Router();

  router.post("/shopify-sync", async (req, res) => {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const userId = cleanStr(body.userId);
    const passId = cleanStr(body.passId);

    // Always respond non-blocking for auth UX
    if (!email) return res.status(200).json({ ok: true, shopifyCustomerId: null });

    const cfg = getShopifyConfig();
    if (!cfg.configured) {
      // Shopify is optional; treat as disabled
      if (passId) {
        try {
          await upsertMegaCustomerLead({ passId, email, userId, shopifyCustomerId: null });
        } catch {}
      }
      return res.status(200).json({ ok: true, shopifyCustomerId: null, degraded: true, reason: "SHOPIFY_DISABLED" });
    }

    try {
      const shopifyCustomerId = await findAndTagCustomerByEmail(email);

      // Store link in MEGA (best-effort)
      if (passId) {
        try {
          await upsertMegaCustomerLead({ passId, email, userId, shopifyCustomerId });
        } catch (e) {
          console.error("[shopify-sync] mega upsert failed:", e?.message || e);
        }
      }

      return res.status(200).json({ ok: true, shopifyCustomerId: shopifyCustomerId || null });
    } catch (e) {
      // If token/domain/api version are wrong, we want visibility, but don’t block login.
      console.error("[shopify-sync] failed:", e?.message || e, e?.body || "");
      return res.status(200).json({
        ok: true,
        shopifyCustomerId: null,
        degraded: true,
        reason: "SHOPIFY_ERROR",
      });
    }
  });

  app.use("/auth", router);
}
