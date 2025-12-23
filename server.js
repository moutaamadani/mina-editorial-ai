// server.js — MMA + MEGA only (no /me dependency). Includes R2 signed upload + history + feedback/like + Shopify sync no-404.
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";

import { getSupabaseAdmin, sbEnabled, logAdminAction } from "./supabase.js";
import { requireAdmin } from "./auth.js";

import mmaRouter from "./server/mma/mma-router.js";
import mmaLogAdminRouter from "./src/routes/admin/mma-logadmin.js";

import {
  resolvePassId as megaResolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
} from "./mega-db.js";

import {
  makeKey,
  publicUrlForKey,
  storeRemoteImageToR2,
  parseDataUrl,
  putBufferToR2,
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

// Keep pass:user:* intact.
// For pass:anon:* you can choose to store full or short; this keeps your old behavior (short) to match existing DB.
function normalizeIncomingPassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:anon:")) return s.slice("pass:anon:".length).trim();
  return s;
}

function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
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
const defaultAllowlist = ["https://mina.faltastudio.com", "https://mina-app-bvpn.onrender.com"];
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
// Public stats (used by frontend AuthGate UI)
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
// ======================================================
// Shopify ↔ MEGA passId reconciliation helpers
// ======================================================

// NOTE: adjust these column names ONLY if your mega_customers schema differs
const MEGA_CUSTOMERS_TABLE = "mega_customers";
const COL_PASS_ID = "mg_pass_id";
const COL_EMAIL = "mg_email";
const COL_SHOPIFY_ID = "mg_shopify_customer_id";
const COL_UPDATED_AT = "mg_updated_at";

// Find the "best" existing passId for this Shopify identity
async function findExistingPassIdForShopify({ supabase, shopifyCustomerId, email }) {
  if (!supabase) return null;

  const filters = [];
  if (shopifyCustomerId) filters.push(`${COL_SHOPIFY_ID}.eq.${shopifyCustomerId}`);
  if (email) filters.push(`${COL_EMAIL}.eq.${email}`);
  if (!filters.length) return null;

  const { data, error } = await supabase
    .from(MEGA_CUSTOMERS_TABLE)
    .select(`${COL_PASS_ID}, ${COL_EMAIL}, ${COL_SHOPIFY_ID}, ${COL_UPDATED_AT}`)
    .or(filters.join(","))
    .order(COL_UPDATED_AT, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.[COL_PASS_ID] || null;
}

// Merge credits from any other passIds with the same email into primaryPassId.
// This fixes "I bought on Shopify but my app balance didn't change".
async function mergeCreditsByEmail({ supabase, primaryPassId, email }) {
  if (!supabase || !primaryPassId || !email) return;

  const { data, error } = await supabase
    .from(MEGA_CUSTOMERS_TABLE)
    .select(`${COL_PASS_ID}, ${COL_EMAIL}, ${COL_SHOPIFY_ID}, ${COL_UPDATED_AT}`)
    .eq(COL_EMAIL, email)
    .order(COL_UPDATED_AT, { ascending: false })
    .limit(10);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  for (const r of rows) {
    const otherPassId = r?.[COL_PASS_ID];
    const otherShopifyId = r?.[COL_SHOPIFY_ID] || null;
    if (!otherPassId || otherPassId === primaryPassId) continue;

    // If this other record has a Shopify id, attach it to primary so future webhook lookups find it.
    if (otherShopifyId) {
      try {
        await megaEnsureCustomer({
          passId: primaryPassId,
          email,
          shopifyCustomerId: String(otherShopifyId),
          userId: null,
        });
      } catch {}
    }

    // Move any existing balance over (idempotent via credit ref)
    const { credits: otherCredits } = await megaGetCredits(otherPassId);
    const amount = Number(otherCredits || 0);
    if (amount <= 0) continue;

    const refId = `merge:${otherPassId}=>${primaryPassId}`;

    const already = await megaHasCreditRef({ refType: "merge", refId });
    if (already) continue;

    // Add to primary
    await megaAdjustCredits({
      passId: primaryPassId,
      delta: amount,
      reason: "credits-merge-in",
      source: "shopify-sync",
      refType: "merge",
      refId,
      grantedAt: nowIso(),
    });

    // Remove from secondary
    await megaAdjustCredits({
      passId: otherPassId,
      delta: -amount,
      reason: "credits-merge-out",
      source: "shopify-sync",
      refType: "merge_out",
      refId,
      grantedAt: nowIso(),
    });
  }
}

// RAW webhook MUST be before express.json()
app.post("/api/credits/shopify-order", express.raw({ type: "application/json" }), async (req, res) => {
  const requestId = `shopify_${Date.now()}_${crypto.randomUUID()}`;

  try {
    const rawBody = req.body?.toString("utf8") || "";
    const hmac = req.get("X-Shopify-Hmac-Sha256") || req.get("x-shopify-hmac-sha256") || "";

    const ok = verifyShopifyWebhook({ secret: SHOPIFY_ORDER_WEBHOOK_SECRET, rawBody, hmacHeader: hmac });
    if (!ok) return res.status(401).json({ ok: false, error: "INVALID_HMAC", requestId });

    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

    const order = rawBody ? JSON.parse(rawBody) : {};
    const orderId = order?.id != null ? String(order.id) : null;
    if (!orderId) return res.status(400).json({ ok: false, error: "MISSING_ORDER_ID", requestId });

    const already = await megaHasCreditRef({ refType: "shopify_order", refId: orderId });
    if (already) return res.status(200).json({ ok: true, requestId, alreadyProcessed: true, orderId });

    const credits = creditsFromOrder(order);
    if (!credits) {
      return res.status(200).json({ ok: true, requestId, orderId, credited: 0, reason: "NO_MATCHING_PRODUCT" });
    }

    const shopifyCustomerId = order?.customer?.id != null ? String(order.customer.id) : null;
    const email = safeString(order?.email || order?.customer?.email || "").toLowerCase() || null;

    const supabase = getSupabaseAdmin();
    
    // ✅ Try to credit the SAME passId the app already uses (pass:user:*), if it exists.
    const existingPassId = await findExistingPassIdForShopify({
      supabase,
      shopifyCustomerId,
      email,
    });
    
    const passId =
      existingPassId ||
      (shopifyCustomerId
        ? `pass:shopify:${shopifyCustomerId}`
        : email
          ? `pass:email:${email}`
          : `pass:anon:${crypto.randomUUID()}`);


    await megaEnsureCustomer({ passId, email, shopifyCustomerId: shopifyCustomerId || null, userId: null });
    // ✅ If we credited an existing passId, ensure Shopify id/email are attached to that row too.
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
    return res.status(500).json({ ok: false, error: "WEBHOOK_FAILED", requestId, message: e?.message || String(e) });
  }
});

// ======================================================
// Standard body parsers
// ======================================================
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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

function resolvePassIdForRequest(req, bodyLike = {}) {
  return megaResolvePassId(req, bodyLike);
}

// ======================================================
// Health
// ======================================================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina MMA API (MMA+MEGA)",
    time: nowIso(),
    supabase: sbEnabled(),
    env: IS_PROD ? "production" : "development",
  });
});

// ======================================================
// Shopify sync (frontend calls this; must NOT 404)
// NOTE: NO /me required. This is a tiny helper only.
// ======================================================
app.post("/auth/shopify-sync", async (req, res) => {
  try {
    const authUser = await getAuthUser(req);

    if (!authUser?.userId) {
      return res.status(200).json({ ok: true, loggedIn: false });
    }

    const passId = normalizeIncomingPassId(`pass:user:${authUser.userId}`);
    setPassIdHeader(res, passId);

    if (sbEnabled()) {
      await megaEnsureCustomer({ passId, userId: authUser.userId, email: authUser.email || null });
            // ✅ Pull any credits from Shopify/email passIds into the logged-in user passId
      try {
        const supabase = getSupabaseAdmin();
        await mergeCreditsByEmail({
          supabase,
          primaryPassId: passId,
          email: authUser.email || null,
        });
      } catch (e) {
        console.warn("[shopify-sync] merge credits failed:", e?.message || e);
      }

    }

    return res.status(200).json({ ok: true, loggedIn: true, passId, email: authUser.email || null });
  } catch {
    return res.status(200).json({ ok: true, loggedIn: false, degraded: true });
  }
});

// ======================================================
// Credits / Sessions / History / Feedback (MEGA)
// ======================================================
app.get("/credits/balance", async (req, res) => {
  const requestId = `credits_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const q = normalizeIncomingPassId(req.query.customerId || req.query.passId || "");
    const passId = q || normalizeIncomingPassId(resolvePassIdForRequest(req, { customerId: q }));
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

    const { credits, expiresAt } = await megaGetCredits(passId);
    return res.json({ ok: true, requestId, passId, balance: credits, expiresAt, source: "mega_customers" });
  } catch (e) {
    console.error("GET /credits/balance failed", e);
    return res.status(500).json({ ok: false, requestId, error: "CREDITS_FAILED", message: e?.message || String(e) });
  }
});

app.post("/sessions/start", async (req, res) => {
  const requestId = `sess_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const body = req.body || {};
    const passId = normalizeIncomingPassId(resolvePassIdForRequest(req, body));
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

    const sessionId = crypto.randomUUID();
    const platform = safeString(body.platform, "web").toLowerCase();
    const title = safeString(body.title, "Mina session");

    await megaWriteSession({
      passId,
      sessionId,
      platform,
      title,
      meta: { requestId, ip: req.ip, userAgent: req.get("user-agent") },
    });

    return res.json({
      ok: true,
      requestId,
      passId,
      sessionId,
      session: { id: sessionId, platform, title, createdAt: nowIso() },
    });
  } catch (e) {
    console.error("POST /sessions/start failed", e);
    return res.status(500).json({ ok: false, requestId, error: "SESSION_FAILED", message: e?.message || String(e) });
  }
});

// ✅ Matches your frontend: GET /history/pass/:passId
app.get("/history/pass/:passId", async (req, res) => {
  const requestId = `hist_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const raw = safeString(req.params.passId, "");
    const passId = normalizeIncomingPassId(raw);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

    const { credits, expiresAt } = await megaGetCredits(passId);

    // These table names are the standard MEGA setup.
    // If your DB uses slightly different names, change ONLY these 2 strings.
    const supabase = getSupabaseAdmin();

    const { data: gensRaw, error: gensErr } = await supabase
      .from("mega_generations")
      .select("*")
      .eq("pass_id", passId)
      .order("created_at", { ascending: false });

    if (gensErr) throw gensErr;

    const { data: fbsRaw, error: fbsErr } = await supabase
      .from("mega_feedback")
      .select("*")
      .eq("pass_id", passId)
      .order("created_at", { ascending: false });

    if (fbsErr) {
      // tolerate if feedback table is named differently
      // (frontend still works with empty feedback list)
      console.warn("[history] mega_feedback query failed:", fbsErr?.message || fbsErr);
    }

    const generations = (gensRaw || []).map((r) => ({
      id: String(r.id ?? r.generation_id ?? r.mg_id ?? ""),
      type: String(r.type ?? r.result_type ?? "image"),
      sessionId: String(r.session_id ?? r.sessionId ?? ""),
      passId: String(r.pass_id ?? passId),
      platform: String(r.platform ?? "web"),
      prompt: String(r.prompt ?? ""),
      outputUrl: String(r.output_url ?? r.outputUrl ?? r.public_url ?? r.url ?? ""),
      createdAt: String(r.created_at ?? r.createdAt ?? nowIso()),
      meta: r.meta ?? null,
    }));

    const feedbacks = (fbsRaw || []).map((r) => ({
      id: String(r.id ?? r.fb_id ?? ""),
      passId: String(r.pass_id ?? passId),
      resultType: String(r.result_type ?? r.resultType ?? "image"),
      platform: String(r.platform ?? "web"),
      prompt: String(r.prompt ?? ""),
      comment: String(r.comment ?? ""),
      imageUrl: r.image_url ? String(r.image_url) : undefined,
      videoUrl: r.video_url ? String(r.video_url) : undefined,
      createdAt: String(r.created_at ?? r.createdAt ?? nowIso()),
    }));

    return res.json({
      ok: true,
      passId,
      credits: { balance: credits, expiresAt },
      generations,
      feedbacks,
    });
  } catch (e) {
    console.error("GET /history/pass/:passId failed", e);
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED", requestId, message: e?.message || String(e) });
  }
});

// ✅ Matches your frontend: DELETE /history/:id
app.delete("/history/:id", async (req, res) => {
  const requestId = `del_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const id = safeString(req.params.id, "");
    if (!id) return res.status(400).json({ ok: false, requestId, error: "MISSING_ID" });

    const supabase = getSupabaseAdmin();

    // Try delete from generations first
    const genDel = await supabase.from("mega_generations").delete().eq("id", id).select("id");
    const genCount = Array.isArray(genDel.data) ? genDel.data.length : 0;

    if (genDel.error && genCount === 0) {
      // if the column isn't `id` in your DB, adjust here
      console.warn("[history delete] mega_generations delete warning:", genDel.error?.message || genDel.error);
    }

    // Also try delete from feedback table (safe if not found)
    try {
      await supabase.from("mega_feedback").delete().eq("id", id);
    } catch {}

    return res.json({ ok: true, requestId, deleted: true });
  } catch (e) {
    console.error("DELETE /history/:id failed", e);
    return res.status(500).json({ ok: false, requestId, error: "DELETE_FAILED", message: e?.message || String(e) });
  }
});

// ✅ Matches your frontend: POST /feedback/like
app.post("/feedback/like", async (req, res) => {
  const requestId = `like_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const body = req.body || {};
    const passId = normalizeIncomingPassId(resolvePassIdForRequest(req, body));
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

    const generationId = safeString(body.generationId || body.generation_id, null);

    const payload = {
      event_type: "feedback.like",
      liked: body.liked !== false,
      resultType: safeString(body.resultType, "image"),
      platform: safeString(body.platform, "web"),
      prompt: safeString(body.prompt, ""),
      comment: safeString(body.comment, ""),
      imageUrl: safeString(body.imageUrl, ""),
      videoUrl: safeString(body.videoUrl, ""),
      sessionId: safeString(body.sessionId, ""),
      createdAt: nowIso(),
    };

    const out = await megaWriteFeedback({ passId, generationId, payload });
    return res.json({ ok: true, requestId, passId, feedbackId: out.feedbackId });
  } catch (e) {
    console.error("POST /feedback/like failed", e);
    return res.status(500).json({ ok: false, requestId, error: "FEEDBACK_FAILED", message: e?.message || String(e) });
  }
});

// Keep legacy /feedback alias (won’t hurt)
app.post("/feedback", async (req, res) => {
  return app._router.handle(req, res, () => {}, "post", "/feedback/like");
});

// ======================================================
// R2 signed upload endpoints
// ======================================================
const R2_ACCOUNT_ID = ENV.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = ENV.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = ENV.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = ENV.R2_BUCKET || "";

function r2Enabled() {
  return Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

function getR2S3Client() {
  if (!r2Enabled()) return null;
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

// Create signed PUT URL for browser upload
app.post("/api/r2/upload-signed", async (req, res) => {
  try {
    if (!r2Enabled()) return res.status(503).json({ ok: false, error: "R2_NOT_CONFIGURED" });

    const body = req.body || {};

    // ✅ accept BOTH front/back key names
    const kind = safeString(body.kind || body.folder || "uploads", "uploads");
    const filename = safeString(body.fileName || body.filename || body.file_name || "upload", "upload");
    const contentType = safeString(body.contentType || "application/octet-stream", "application/octet-stream");

    const rawPass =
      body.passId || body.customerId || req.get("x-mina-pass-id") || req.query.passId || req.query.customerId;
    const passId = normalizeIncomingPassId(rawPass) || "anonymous";
    setPassIdHeader(res, passId);

    const key = makeKey({ kind, customerId: passId, filename, contentType });

    const client = getR2S3Client();
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, cmd, { expiresIn: 600 });
    const publicUrl = publicUrlForKey(key);

    return res.status(200).json({
      ok: true,
      key,
      uploadUrl,
      publicUrl,
      url: publicUrl,
      expiresIn: 600,
    });
  } catch (e) {
    console.error("POST /api/r2/upload-signed failed", e);
    return res.status(500).json({ ok: false, error: "UPLOAD_SIGN_FAILED", message: e?.message || String(e) });
  }
});

// Store a remote URL into R2 server-side
app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const body = req.body || {};
    const url = safeString(body.sourceUrl || body.url || "", "");
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const kind = safeString(body.kind || body.folder || "generations", "generations");
    const rawPass = body.passId || body.customerId || req.get("x-mina-pass-id");
    const passId = normalizeIncomingPassId(rawPass) || "anonymous";
    setPassIdHeader(res, passId);

    const out = await storeRemoteImageToR2({ url, kind, customerId: passId });
    return res.status(200).json({ ok: true, key: out.key, publicUrl: out.publicUrl, url: out.publicUrl });
  } catch (e) {
    console.error("POST /api/r2/store-remote-signed failed", e);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED", message: e?.message || String(e) });
  }
});

// Optional: accept base64 dataUrl and upload server-side
app.post("/api/r2/upload-dataurl", async (req, res) => {
  try {
    const body = req.body || {};
    const dataUrl = safeString(body.dataUrl, "");
    if (!dataUrl) return res.status(400).json({ ok: false, error: "MISSING_DATAURL" });

    const kind = safeString(body.kind || body.folder || "uploads", "uploads");
    const filename = safeString(body.filename || body.fileName || "upload", "upload");
    const rawPass = body.passId || body.customerId || req.get("x-mina-pass-id");
    const passId = normalizeIncomingPassId(rawPass) || "anonymous";
    setPassIdHeader(res, passId);

    const parsed = parseDataUrl(dataUrl);
    const key = makeKey({ kind, customerId: passId, filename, contentType: parsed.contentType });

    const out = await putBufferToR2({ key, buffer: parsed.buffer, contentType: parsed.contentType });
    return res.status(200).json({ ok: true, key: out.key, publicUrl: out.publicUrl, url: out.publicUrl });
  } catch (e) {
    console.error("POST /api/r2/upload-dataurl failed", e);
    return res.status(500).json({ ok: false, error: "UPLOAD_DATAURL_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// MMA API (primary)
// ======================================================
app.use("/mma", mmaRouter);
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

    return res.json({ ok: true, totalCustomers: count ?? 0, source: "mega_customers" });
  } catch (e) {
    console.error("GET /admin/summary failed", e);
    return res.status(500).json({ ok: false, error: "ADMIN_SUMMARY_FAILED", message: e?.message || String(e) });
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

    await megaEnsureCustomer({ passId: String(passId) });

    const out = await megaAdjustCredits({
      passId: String(passId),
      delta,
      reason: safeString(reason, "admin-adjust"),
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || requestId,
      grantedAt: nowIso(),
    });

    return res.json({
      ok: true,
      requestId,
      passId: String(passId),
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /admin/credits/adjust failed", e);
    return res.status(500).json({ ok: false, requestId, error: "ADMIN_CREDITS_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// Error middleware + listen
// ======================================================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API (MMA+MEGA) listening on port ${PORT}`);
});
