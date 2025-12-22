// shopifySyncRoute.js (ESM)
import { findAndTagCustomerByEmail } from "./shopifyAdmin.js";
import { upsertMegaCustomerLead } from "./src/megaCustomersLead.js";

function cleanStr(v) {
  const s = String(v || "").trim();
  return s || null;
}
function cleanEmail(v) {
  const e = String(v || "").trim().toLowerCase();
  return e || null;
}

export function registerShopifySync(app) {
  app.post("/auth/shopify-sync", async (req, res) => {
    try {
      const body = req.body || {};

      const email = cleanEmail(body.email);
      const userId = cleanStr(body.userId);
      const passId = cleanStr(body.passId) || cleanStr(req.get("x-mina-pass-id"));

      // 1) Shopify lookup/tag (optional)
      let shopifyCustomerId = null;

      if (email) {
        const r = await findAndTagCustomerByEmail(email);
        if (r.ok && r.customer) {
          // legacyResourceId is the numeric Shopify customer ID (string)
          shopifyCustomerId = r.customer.legacyId || null;
        }
      }

      // 2) Store into MEGA (optional)
      // NOTE: even if this fails due to missing columns, we still return ok:true
      await upsertMegaCustomerLead({ userId, email, passId, shopifyCustomerId });

      return res.json({ ok: true, shopifyCustomerId });
    } catch {
      // Never block login flow
      return res.json({ ok: true, shopifyCustomerId: null });
    }
  });
}
