// shopifyAdmin.js
"use strict";

const SHOPIFY_STORE_DOMAIN = (process.env.SHOPIFY_STORE_DOMAIN || "").trim();
const SHOPIFY_ADMIN_TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
const SHOPIFY_API_VERSION = (process.env.SHOPIFY_API_VERSION || "2024-10").trim();
const SHOPIFY_MINA_TAG = (process.env.SHOPIFY_MINA_TAG || "mina").trim();

function shopifyEnabled() {
  return !!(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);
}

function endpoint() {
  if (!SHOPIFY_STORE_DOMAIN) return null;
  return `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

async function shopifyGraphQL({ query, variables, timeoutMs = 3500 }) {
  if (!shopifyEnabled()) return { ok: false, error: "shopify_disabled" };
  const url = endpoint();
  if (!url) return { ok: false, error: "missing_shopify_domain" };
  if (!globalThis.fetch) return { ok: false, error: "fetch_unavailable" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `shopify_http_${res.status}`, json };
    if (json?.errors?.length) return { ok: false, error: "shopify_graphql_errors", json };
    return { ok: true, data: json.data };
  } catch {
    return { ok: false, error: "shopify_fetch_failed" };
  } finally {
    clearTimeout(t);
  }
}

function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e || null;
}

async function findCustomerByEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return { ok: false, error: "missing_email" };
  if (!shopifyEnabled()) return { ok: false, error: "shopify_disabled" };

  // Shopify customer search query format: "email:someone@domain.com"
  const q = `email:${clean}`;

  const query = `
    query FindCustomer($q: String!) {
      customers(first: 1, query: $q) {
        edges {
          node {
            id
            legacyResourceId
            email
            tags
          }
        }
      }
    }
  `;

  const r = await shopifyGraphQL({ query, variables: { q } });
  if (!r.ok) return r;

  const node = r.data?.customers?.edges?.[0]?.node || null;
  if (!node?.id) return { ok: true, customer: null };

  return {
    ok: true,
    customer: {
      gid: String(node.id),
      legacyId: node.legacyResourceId != null ? String(node.legacyResourceId) : null,
      email: node.email ? String(node.email) : null,
      tags: Array.isArray(node.tags) ? node.tags : [],
    },
  };
}

async function addTagToCustomer(customerGid, tag) {
  const t = String(tag || "").trim();
  const gid = String(customerGid || "").trim();
  if (!gid || !t) return { ok: false, error: "missing_gid_or_tag" };
  if (!shopifyEnabled()) return { ok: false, error: "shopify_disabled" };

  const mutation = `
    mutation TagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;

  const r = await shopifyGraphQL({ query: mutation, variables: { id: gid, tags: [t] } });
  if (!r.ok) return r;

  const errs = r.data?.tagsAdd?.userErrors || [];
  if (errs.length) return { ok: false, error: "shopify_tag_error", userErrors: errs };

  return { ok: true };
}

async function findAndTagCustomerByEmail(email, tag = SHOPIFY_MINA_TAG) {
  const found = await findCustomerByEmail(email);
  if (!found.ok) return found;

  const customer = found.customer;
  if (!customer) return { ok: true, customer: null };

  // Add tag only if missing
  const hasTag = (customer.tags || []).some((x) => String(x).toLowerCase() === String(tag).toLowerCase());
  if (!hasTag && tag) {
    await addTagToCustomer(customer.gid, tag);
  }

  return { ok: true, customer };
}

module.exports = {
  SHOPIFY_MINA_TAG,
  shopifyEnabled,
  findCustomerByEmail,
  addTagToCustomer,
  findAndTagCustomerByEmail,
};
