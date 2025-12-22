// shopifyAdmin.js (ESM)
"use strict";

const ENV = process.env;

const SHOPIFY_STORE_DOMAIN = (ENV.SHOPIFY_STORE_DOMAIN || "").trim();
const SHOPIFY_ADMIN_TOKEN = (ENV.SHOPIFY_ADMIN_TOKEN || "").trim();
const SHOPIFY_API_VERSION = (ENV.SHOPIFY_API_VERSION || "2025-10").trim();

export function shopifyConfigured() {
  return Boolean(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);
}

function buildAdminUrl(path, searchParams) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const base = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${cleanPath}`;
  if (!searchParams) return base;

  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function shopifyAdminFetch(path, { method = "GET", body = null, searchParams = null } = {}) {
  if (!shopifyConfigured()) {
    const err = new Error("SHOPIFY_NOT_CONFIGURED");
    err.code = "SHOPIFY_NOT_CONFIGURED";
    throw err;
  }

  const url = buildAdminUrl(path, searchParams);

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
  } catch {}

  if (!resp.ok) {
    const err = new Error(`SHOPIFY_${resp.status}`);
    err.status = resp.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

export async function findCustomerByEmail(email) {
  const em = String(email || "").trim().toLowerCase();
  if (!em) return null;

  // Shopify search syntax: "email:someone@example.com"
  const query = `email:${em}`;
  const out = await shopifyAdminFetch("customers/search.json", {
    searchParams: { query, limit: 1 },
  });

  const customers = Array.isArray(out?.customers) ? out.customers : [];
  return customers[0] || null;
}

export async function addCustomerTag(customerId, tag) {
  const id = String(customerId || "").trim();
  const t = String(tag || "").trim();
  if (!id || !t) return { ok: false, reason: "missing_id_or_tag" };

  const get = await shopifyAdminFetch(`customers/${id}.json`);
  const existingStr = get?.customer?.tags || "";
  const existing = existingStr
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (existing.includes(t)) return { ok: true, already: true, tags: existing };

  const nextTags = [...existing, t].join(", ");
  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, tags: [...existing, t] };
}

export async function findAndTagCustomerByEmail(email, tag) {
  const customer = await findCustomerByEmail(email);
  if (!customer?.id) return { customer: null, tagged: false };

  let tagged = false;
  try {
    const r = await addCustomerTag(customer.id, tag);
    tagged = Boolean(r?.ok);
  } catch {
    // Tagging is best-effort
  }

  return { customer, tagged };
}
