// shopifyAdmin.js
"use strict";

// Tiny Shopify Admin helpers used by /auth/shopify-sync
// This is NOT "Shopify auth". It's optional lead-capture + tagging.
// Safe: if Shopify env is missing, functions return ok:false (no crashes).

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
export const SHOPIFY_MINA_TAG = process.env.SHOPIFY_MINA_TAG || "Mina_users";

function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e || null;
}

export function shopifyConfigured() {
  return !!(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);
}

export async function shopifyAdminFetch(path, { method = "GET", body = null } = {}) {
  if (!shopifyConfigured()) {
    const err = new Error("SHOPIFY_NOT_CONFIGURED");
    err.status = 503;
    throw err;
  }

  const cleanPath = String(path || "").replace(/^\/+/, "");
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${cleanPath}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!resp.ok) {
    const err = new Error(`SHOPIFY_${resp.status}`);
    err.status = resp.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

export async function findCustomerIdByEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return null;
  if (!shopifyConfigured()) return null;

  // REST search endpoint
  const q = encodeURIComponent(`email:${clean}`);
  const json = await shopifyAdminFetch(`customers/search.json?query=${q}`, { method: "GET" });

  const customers = Array.isArray(json?.customers) ? json.customers : [];
  const first = customers[0];
  const id = first?.id != null ? String(first.id) : null;
  return id || null;
}

export async function addCustomerTag(customerId, tag = SHOPIFY_MINA_TAG) {
  if (!shopifyConfigured()) return { ok: false, error: "SHOPIFY_NOT_CONFIGURED" };

  const id = String(customerId || "").trim();
  const t = String(tag || "").trim();
  if (!id || !t) return { ok: false, error: "MISSING_INPUT" };

  const get = await shopifyAdminFetch(`customers/${id}.json`, { method: "GET" });
  const existingStr = get?.customer?.tags || "";
  const existing = existingStr
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (existing.includes(t)) {
    return { ok: true, already: true, customerId: id, tags: existing };
  }

  const nextTags = [...existing, t].join(", ");
  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, customerId: id, tags: [...existing, t] };
}

/**
 * ✅ This is the missing export your server is importing.
 * Finds Shopify customer by email, tags them, returns status.
 */
export async function findAndTagCustomerByEmail(email, tag = SHOPIFY_MINA_TAG) {
  const clean = normalizeEmail(email);
  if (!clean) return { ok: false, error: "MISSING_EMAIL" };
  if (!shopifyConfigured()) return { ok: false, error: "SHOPIFY_NOT_CONFIGURED" };

  const customerId = await findCustomerIdByEmail(clean);
  if (!customerId) return { ok: false, error: "NOT_FOUND" };

  const out = await addCustomerTag(customerId, tag);
  return { ...out, ok: true, customerId };
}
