// server.js — Pure MMA + MEGA wired (Supabase service role). No legacy editorial/motion shims.
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";

import {
  getSupabaseAdmin,
  sbEnabled,
  logAdminAction,
  upsertSessionRow,
  upsertProfileRow,
} from "./supabase.js";

import {
  resolvePassId as megaResolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
} from "./mega-db.js";

import { requireAdmin } from "./auth.js";

import mmaRouter from "./server/mma/mma-router.js";
import mmaLogAdminRouter from "./src/routes/admin/mma-logadmin.js";

import { registerShopifySync } from "./shopifySyncRoute.js";

// R2 helpers (you already have this file)
import {
  makeKey,
  publicUrlForKey,
  putBufferToR2,
  storeRemoteImageToR2,
  parseDataUrl,
} from "./r2.js";

// ======================================================
// Env / app boot
// ======================================================
const ENV = process.env;
const IS_PROD = ENV.NODE_ENV === "production";
const PORT = Number(ENV.PORT || 8080);

const app = express();
app.set("trust proxy", 1);

function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

// ======================================================
// PassId normalization (FIX for your 500)
// DB: mega_customers.mg_pass_id is UUID
// Frontend sometimes sends passId like "pass:anon:<uuid>"
// ======================================================
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalizeToUuidPassId(raw) {
  const s = safeString(raw, "").trim();
  if (!s) return crypto.randomUUID();

  if (UUID_RE.test(s)) return s;

  const m = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  );
  if (m?.[0]) return m[0];

  return crypto.randomUUID();
}

function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
}

async function resolvePassIdForAuthUser({ userId, email }) {
  if (!sbEnabled()) return null;
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  // Prefer mg_user_id match (stable)
  if (userId) {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_pass_id")
      .eq("mg_user_id", userId)
      .maybeSingle();
    if (data?.mg_pass_id) return String(data.mg_pass_id);
  }

  // Fallback to email match
  if (email) {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_pass_id")
      .eq("mg_email", String(email).toLowerCase())
      .maybeSingle();
    if (data?.mg_pass_id) return String(data.mg_pass_id);
  }

  return null;
}

function resolvePassIdForRequest(req, bodyLike = {}) {
  const raw = megaResolvePassId(req, bodyLike);
  return canonicalizeToUuidPassId(raw);
}

// ======================================================
// Process-level crash logging
// ======================================================
process.on("unhandledRejection", async (reason) => {
  const normalized = normalizeError(reason);
  try {
    await logError({
      action: "process.unhandledRejection",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "🧵",
      code: "UNHANDLED_REJECTION",
    });
  } catch (err) {
    console.error("[process.unhandledRejection] failed to log", err);
  }
});

process.on("uncaughtException", async (err) => {
  const normalized = normalizeError(err);
  try {
    await logError({
      action: "process.uncaughtException",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "💥",
      code: "UNCAUGHT_EXCEPTION",
    });
  } catch (loggingError) {
    console.error("[process.uncaughtException] failed to log", loggingError);
  }
});

// ======================================================
// CORS
// ======================================================
const defaultAllowlist = ["http://mina.faltastudio.com", "https://mina-app-bvpn.onrender.com"];
const envAllowlist = (ENV.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowlist = Array.from(new Set([...defaultAllowlist, ...envAllowlist]));

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowlist.length === 0) return cb(null, false);
    return cb(null, allowlist.includes(origin));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Mina-Pass-Id"],
  exposedHeaders: ["X-Mina-Pass-Id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use((_req, res, next) => {
  const existing = res.get("Access-Control-Expose-Headers");
  const headers = existing
    ? existing
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean)
    : [];
  if (!headers.some((h) => h.toLowerCase() === "x-mina-pass-id")) headers.push("X-Mina-Pass-Id");
  res.set("Access-Control-Expose-Headers", headers.join(", "));
  next();
});

// ======================================================
// Shopify webhook (RAW body + HMAC verify) — MEGA credits
// ======================================================
const SHOPIFY_STORE_DOMAIN = ENV.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_TOKEN = ENV.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = ENV.SHOPIFY_API_VERSION || "2025-10";
const SHOPIFY_ORDER_WEBHOOK_SECRET = ENV.SHOPIFY_ORDER_WEBHOOK_SECRET || "";
const SHOPIFY_MINA_TAG = ENV.SHOPIFY_MINA_TAG || "Mina_users";
const SHOPIFY_WELCOME_MATCHA_VARIANT_ID = String(ENV.SHOPIFY_WELCOME_MATCHA_VARIANT_ID || "");

let CREDIT_PRODUCT_MAP = {};
try {
  const raw = ENV.CREDIT_PRODUCT_MAP;
  CREDIT_PRODUCT_MAP = raw ? JSON.parse(raw) : {};
  if (!CREDIT_PRODUCT_MAP || typeof CREDIT_PRODUCT_MAP !== "object") CREDIT_PRODUCT_MAP = {};
} catch {
  CREDIT_PRODUCT_MAP = {};
}

function verifyShopifyWebhook({ secret, rawBody, hmacHeader }) {
  if (!secret || !rawBody || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyAdminFetch(path, { method = "GET", body = null } = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) throw new Error("SHOPIFY_NOT_CONFIGURED");

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${String(path).replace(
    /^\/+/,
    ""
  )}`;

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

async function resolveExistingPassIdForOrder({ shopifyCustomerId, email }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;

    const sid = shopifyCustomerId ? String(shopifyCustomerId).trim() : "";
    const em = email ? String(email).trim().toLowerCase() : "";

    if (sid) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_shopify_customer_id", sid)
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    if (em) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_pass_id")
        .eq("mg_email", em)
        .maybeSingle();
      if (data?.mg_pass_id) return String(data.mg_pass_id);
    }

    return null;
  } catch {
    return null;
  }
}

async function addCustomerTag(customerId, tag) {
  const id = String(customerId);
  const get = await shopifyAdminFetch(`customers/${id}.json`);
  const existingStr = get?.customer?.tags || "";
  const existing = existingStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (existing.includes(tag)) return { ok: true, already: true, tags: existing };
  const nextTags = [...existing, tag].join(", ");

  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, tags: [...existing, tag] };
}

function creditsFromOrder(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  let credits = 0;

  for (const li of items) {
    const sku = String(li?.sku || "").trim();
    const variantId = li?.variant_id != null ? String(li.variant_id) : "";

    if (SHOPIFY_WELCOME_MATCHA_VARIANT_ID && variantId === SHOPIFY_WELCOME_MATCHA_VARIANT_ID) {
      credits += 50;
      continue;
    }

    if (sku && Object.prototype.hasOwnProperty.call(CREDIT_PRODUCT_MAP, sku)) {
      credits += Number(CREDIT_PRODUCT_MAP[sku] || 0);
    }
  }
  return credits;
}

// RAW webhook MUST be before express.json()
app.post("/api/credits/shopify-order", express.raw({ type: "application/json" }), async (req, res) => {
  const requestId = `shopify_${Date.now()}_${crypto.randomUUID()}`;

  try {
    const rawBody = req.body?.toString("utf8") || "";
    const hmac = req.get("X-Shopify-Hmac-Sha256") || req.get("x-shopify-hmac-sha256") || "";

    const ok = verifyShopifyWebhook({
      secret: SHOPIFY_ORDER_WEBHOOK_SECRET,
      rawBody,
      hmacHeader: hmac,
    });
    if (!ok) return res.status(401).json({ ok: false, error: "INVALID_HMAC", requestId });

    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

    const order = rawBody ? JSON.parse(rawBody) : {};
    const orderId = order?.id != null ? String(order.id) : null;
    if (!orderId) return res.status(400).json({ ok: false, error: "MISSING_ORDER_ID", requestId });

    const already = await megaHasCreditRef({ refType: "shopify_order", refId: orderId });
    if (already) return res.status(200).json({ ok: true, requestId, alreadyProcessed: true, orderId });

    const credits = creditsFromOrder(order);
    if (!credits) {
      return res.status(200).json({
        ok: true,
        requestId,
        orderId,
        credited: 0,
        reason: "NO_MATCHING_PRODUCT",
      });
    }

    const shopifyCustomerId = order?.customer?.id != null ? String(order.customer.id) : null;
    const email = safeString(order?.email || order?.customer?.email || "").toLowerCase() || null;

    const existingPassId = await resolveExistingPassIdForOrder({ shopifyCustomerId, email });

    const passId = canonicalizeToUuidPassId(
      existingPassId ||
        (shopifyCustomerId
          ? `pass:shopify:${shopifyCustomerId}`
          : email
            ? `pass:email:${email}`
            : `pass:anon:${crypto.randomUUID()}`)
    );

    await megaEnsureCustomer({
      passId,
      email,
      shopifyCustomerId: shopifyCustomerId || null,
      userId: null,
    });

    const grantedAt = order?.processed_at || order?.created_at || nowIso();

    const out = await megaAdjustCredits({
      passId,
      delta: credits,
      reason: "shopify-order",
      source: "shopify",
      refType: "shopify_order",
      refId: orderId,
      grantedAt,
    });

    if (shopifyCustomerId) {
      try {
        await addCustomerTag(shopifyCustomerId, SHOPIFY_MINA_TAG);
      } catch (e) {
        console.error("[shopify] add tag failed:", e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      requestId,
      orderId,
      passId,
      credited: credits,
      balance: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("[shopify webhook] failed", e);
    return res.status(500).json({
      ok: false,
      error: "WEBHOOK_FAILED",
      requestId,
      message: e?.message || String(e),
    });
  }
});

// ======================================================
// Standard body parsers
// ======================================================
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// ======================================================
// Public stats (used by frontend on login) — FIX 404
// ======================================================
app.get("/public/stats/total-users", async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(200).json({ ok: true, totalUsers: 0, degraded: true });

    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase
      .from("mega_customers")
      .select("mg_pass_id", { count: "exact", head: true });

    if (error) throw error;

    return res.status(200).json({ ok: true, totalUsers: count ?? 0, source: "mega_customers" });
  } catch (e) {
    console.error("GET /public/stats/total-users failed", e);
    return res.status(200).json({ ok: true, totalUsers: 0, degraded: true });
  }
});

// ======================================================
// Shopify lead capture (your /auth/shopify-sync etc)
// ======================================================
registerShopifySync(app);

// ======================================================
// REAL R2 signed upload (fixes /api/r2/upload-signed 404)
// ======================================================
function assertR2Env() {
  const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const missing = need.filter((k) => !safeString(process.env[k], ""));
  if (missing.length) {
    const err = new Error(`R2_MISSING_ENV: ${missing.join(", ")}`);
    err.status = 500;
    throw err;
  }
}

function r2Endpoint() {
  const account = safeString(process.env.R2_ACCOUNT_ID, "");
  const override = safeString(process.env.R2_ENDPOINT, "");
  return override || (account ? `https://${account}.r2.cloudflarestorage.com` : "");
}

async function presignPutUrl({ key, contentType, expiresIn = 600 }) {
  assertR2Env();

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  // IMPORTANT: this dependency must exist (see package.json step below)
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(),
    credentials: {
      accessKeyId: safeString(process.env.R2_ACCESS_KEY_ID, ""),
      secretAccessKey: safeString(process.env.R2_SECRET_ACCESS_KEY, ""),
    },
  });

  const Bucket = safeString(process.env.R2_BUCKET, "");
  const cmd = new PutObjectCommand({
    Bucket,
    Key: key,
    ContentType: contentType || "application/octet-stream",
    CacheControl: "public, max-age=31536000, immutable",
    ContentDisposition: "inline",
  });

  const signedUrl = await getSignedUrl(client, cmd, { expiresIn });
  return signedUrl;
}

// Browser uses this: get signed PUT URL, then uploads directly to R2
app.post("/api/r2/upload-signed", async (req, res) => {
  const requestId = `r2sign_${Date.now()}_${crypto.randomUUID()}`;
  try {
    const body = req.body || {};

    // Determine passId (UUID)
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    // If frontend sends dataUrl/base64, we can upload server-side too
    const dataUrl = safeString(body.dataUrl || body.data_url, "");
    const base64 = safeString(body.base64 || body.fileBase64 || body.file_base64, "");
    const contentTypeFromBody = safeString(body.contentType || body.content_type, "");

    if (dataUrl) {
      const parsed = parseDataUrl(dataUrl);
      const key = makeKey({
        kind: safeString(body.kind, "uploads"),
        customerId: passId,
        filename: safeString(body.filename, `upload.${parsed.ext || "bin"}`),
        contentType: parsed.contentType,
      });

      const stored = await putBufferToR2({ key, buffer: parsed.buffer, contentType: parsed.contentType });
      return res.status(200).json({ ok: true, requestId, passId, key: stored.key, publicUrl: stored.publicUrl, url: stored.publicUrl });
    }

    if (base64) {
      const buf = Buffer.from(base64, "base64");
      const ct = contentTypeFromBody || "application/octet-stream";
      const key = makeKey({
        kind: safeString(body.kind, "uploads"),
        customerId: passId,
        filename: safeString(body.filename, "upload"),
        contentType: ct,
      });

      const stored = await putBufferToR2({ key, buffer: buf, contentType: ct });
      return res.status(200).json({ ok: true, requestId, passId, key: stored.key, publicUrl: stored.publicUrl, url: stored.publicUrl });
    }

    // Signed upload (normal flow)
    const filename = safeString(body.filename, "upload");
    const contentType = contentTypeFromBody || "application/octet-stream";
    const kind = safeString(body.kind, "uploads");

    const key = makeKey({ kind, customerId: passId, filename, contentType });
    const publicUrl = publicUrlForKey(key);

    const uploadUrl = await presignPutUrl({ key, contentType, expiresIn: 600 });

    return res.status(200).json({
      ok: true,
      requestId,
      passId,
      key,
      uploadUrl,      // frontend should PUT to this
      putUrl: uploadUrl,
      signedUrl: uploadUrl,
      method: "PUT",
      headers: { "Content-Type": contentType },
      publicUrl,      // permanent read URL
      url: publicUrl,
      expiresIn: 600,
    });
  } catch (e) {
    console.error("POST /api/r2/upload-signed failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "R2_SIGN_FAILED",
      message: e?.message || String(e),
    });
  }
});

// Store remote URL into R2 (optional but useful)
app.post("/api/r2/store-remote-signed", async (req, res) => {
  const requestId = `r2remote_${Date.now()}_${crypto.randomUUID()}`;
  try {
    const body = req.body || {};
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const remoteUrl = safeString(body.url || body.remoteUrl || body.remote_url, "");
    if (!remoteUrl) return res.status(400).json({ ok: false, requestId, error: "MISSING_URL" });

    const kind = safeString(body.kind, "generations");
    const stored = await storeRemoteImageToR2({ url: remoteUrl, kind, customerId: passId });

    return res.status(200).json({
      ok: true,
      requestId,
      passId,
      key: stored.key,
      publicUrl: stored.publicUrl,
      url: stored.publicUrl,
    });
  } catch (e) {
    console.error("POST /api/r2/store-remote-signed failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "R2_STORE_REMOTE_FAILED",
      message: e?.message || String(e),
    });
  }
});

// ======================================================
// Auth helper (service role validates a user token)
// ======================================================
function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const lower = token.toLowerCase();
  if (!token || lower === "null" || lower === "undefined" || lower === "[object object]") return null;
  return token;
}

async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const userId = safeString(data.user.id, "");
  const email = safeString(data.user.email, "").toLowerCase() || null;
  if (!userId) return null;

  return { userId, email, token };
}

// ======================================================
// Core routes (MEGA-only)
// ======================================================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina MMA API (MEGA-only)",
    time: nowIso(),
    supabase: sbEnabled(),
    env: IS_PROD ? "production" : "development",
  });
});

app.get("/me", async (req, res) => {
  const requestId = `me_${Date.now()}_${crypto.randomUUID()}`;

  try {
    const authUser = await getAuthUser(req);

    // If client already has a passId header, use it (but normalize to UUID)
    const incoming = safeString(req.get("x-mina-pass-id"), "");
    let passId = incoming ? canonicalizeToUuidPassId(incoming) : null;

    // If authed and no header, reuse existing customer UUID (by userId/email)
    if (!passId && authUser?.userId) {
      passId = await resolvePassIdForAuthUser({ userId: authUser.userId, email: authUser.email });
    }

    // Otherwise, fall back to resolver (then normalize)
    if (!passId) passId = resolvePassIdForRequest(req, {});

    setPassIdHeader(res, passId);

    if (!sbEnabled()) {
      return res.json({
        ok: true,
        requestId,
        user: authUser ? { id: authUser.userId, email: authUser.email } : null,
        passId,
        degraded: true,
        degradedReason: "Supabase not configured",
      });
    }

    if (authUser) {
      void upsertProfileRow({ userId: authUser.userId, email: authUser.email });
      void upsertSessionRow({
        userId: authUser.userId,
        email: authUser.email,
        token: authUser.token,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });

      await megaEnsureCustomer({
        passId,
        userId: authUser.userId,
        email: authUser.email,
      });
    } else {
      await megaEnsureCustomer({ passId });
    }

    return res.json({
      ok: true,
      requestId,
      user: authUser ? { id: authUser.userId, email: authUser.email } : null,
      passId,
    });
  } catch (e) {
    console.error("GET /me failed", e);
    const fallback = resolvePassIdForRequest(req, {});
    setPassIdHeader(res, fallback);
    return res.status(200).json({
      ok: true,
      requestId,
      user: null,
      passId: fallback,
      degraded: true,
      degradedReason: e?.message || String(e),
    });
  }
});

app.get("/credits/balance", async (req, res) => {
  const requestId = `credits_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const passId = resolvePassIdForRequest(req, {
      customerId: req.query.customerId || req.query.passId,
    });
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const { credits, expiresAt } = await megaGetCredits(passId);

    return res.json({
      ok: true,
      requestId,
      passId,
      balance: credits,
      expiresAt,
      source: "mega_customers",
    });
  } catch (e) {
    console.error("GET /credits/balance failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "CREDITS_FAILED",
      message: e?.message || String(e),
    });
  }
});

app.post("/credits/add", async (req, res) => {
  const requestId = `add_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const body = req.body || {};
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);

    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, requestId, error: "INVALID_AMOUNT" });
    }

    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const out = await megaAdjustCredits({
      passId,
      delta: amount,
      reason: safeString(body.reason, "manual-topup"),
      source: safeString(body.source, "api"),
      refType: "manual",
      refId: requestId,
      grantedAt: nowIso(),
    });

    return res.json({
      ok: true,
      requestId,
      passId,
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /credits/add failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "CREDITS_ADD_FAILED",
      message: e?.message || String(e),
    });
  }
});

app.post("/sessions/start", async (req, res) => {
  const requestId = `sess_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const body = req.body || {};
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const sessionId = crypto.randomUUID();
    const platform = safeString(body.platform, "web").toLowerCase();
    const title = safeString(body.title, "Mina session");

    await megaWriteSession({
      passId,
      sessionId,
      platform,
      title,
      meta: {
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      },
    });

    return res.json({
      ok: true,
      requestId,
      passId,
      session: { id: sessionId, platform, title, createdAt: nowIso() },
    });
  } catch (e) {
    console.error("POST /sessions/start failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "SESSION_FAILED",
      message: e?.message || String(e),
    });
  }
});

app.post("/feedback", async (req, res) => {
  const requestId = `fb_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const body = req.body || {};
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const generationId = safeString(body.generationId || body.generation_id, null);

    const payload =
      body.payload && typeof body.payload === "object"
        ? body.payload
        : {
            event_type: safeString(body.event_type, "feedback"),
            payload: body.payload || {},
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            hard_block: safeString(body.hard_block, "") || undefined,
            note: safeString(body.note, "") || undefined,
          };

    const out = await megaWriteFeedback({ passId, generationId, payload });

    return res.json({
      ok: true,
      requestId,
      passId,
      feedbackId: out.feedbackId,
    });
  } catch (e) {
    console.error("POST /feedback failed", e);
    return res.status(500).json({
      ok: false,
      requestId,
      error: "FEEDBACK_FAILED",
      message: e?.message || String(e),
    });
  }
});

// ======================================================
// MMA API (primary)
// ======================================================
app.use("/mma", mmaRouter);

// Optional: separate admin log router
app.use("/admin/mma", mmaLogAdminRouter);

// ======================================================
// Admin API (MEGA)
// ======================================================
app.get("/admin/summary", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });

    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase
      .from("mega_customers")
      .select("mg_pass_id", { count: "exact", head: true });

    if (error) throw error;

    void logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin.summary",
      status: 200,
      route: "/admin/summary",
      method: "GET",
      detail: { totalCustomers: count ?? 0 },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true, totalCustomers: count ?? 0, source: "mega_customers" });
  } catch (e) {
    console.error("GET /admin/summary failed", e);
    res.status(500).json({ ok: false, error: "ADMIN_SUMMARY_FAILED", message: e?.message || String(e) });
  }
});

app.post("/admin/credits/adjust", requireAdmin, async (req, res) => {
  const requestId = `admcred_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const { passId, delta, reason } = req.body || {};
    if (!passId || typeof delta !== "number") {
      return res.status(400).json({ ok: false, requestId, error: "passId and numeric delta are required" });
    }

    await megaEnsureCustomer({ passId: canonicalizeToUuidPassId(passId) });

    const out = await megaAdjustCredits({
      passId: canonicalizeToUuidPassId(passId),
      delta,
      reason: safeString(reason, "admin-adjust"),
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || requestId,
      grantedAt: nowIso(),
    });

    res.json({
      ok: true,
      requestId,
      passId: canonicalizeToUuidPassId(passId),
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /admin/credits/adjust failed", e);
    res.status(500).json({ ok: false, requestId, error: "ADMIN_CREDITS_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// Error middleware + listen
// ======================================================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API (MEGA-only) listening on port ${PORT}`);
});
