// server.js (Supabase-first, MMA production, no legacy patches)
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";

import {
  megaEnsureCustomer,
  megaWriteSessionEvent,
  megaWriteCreditTxnEvent,
  megaParityCounts,
} from "./mega-db.js";

import { parseDataUrl } from "./r2.js";
import { logAdminAction, upsertSessionRow } from "./supabase.js";
import { requireAdmin } from "./auth.js";

// MMA (robust import: works whether module exports named factories or defaults)
import mmaRouter from "./server/mma/mma-router.js";
import * as mmaControllerMod from "./server/mma/mma-controller.js";

// Admin MMA logs router
import mmaLogAdminRouter from "./src/routes/admin/mma-logadmin.js";

// ======================================================
// Env / app boot
// ======================================================
const ENV = process.env;
const IS_PROD = ENV.NODE_ENV === "production";
const PORT = Number(ENV.PORT || 8080);

const app = express();

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
// Supabase (service role) — MEGA-first persistence
// ======================================================
const SUPABASE_URL = ENV.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function sbEnabled() {
  return !!supabaseAdmin;
}

function nowIso() {
  return new Date().toISOString();
}

// ======================================================
// Small safety helpers
// ======================================================
function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function safeShopifyId(customerIdRaw) {
  const v = customerIdRaw === null || customerIdRaw === undefined ? "" : String(customerIdRaw);
  return v.trim() || "anonymous";
}

function resolveCustomerId(req, body) {
  const fromBody = body?.customerId;
  if (fromBody !== null && fromBody !== undefined && String(fromBody).trim()) {
    return String(fromBody).trim();
  }
  const fromHeader = String(req.get("X-Mina-Pass-Id") || "").trim();
  if (fromHeader) return fromHeader;
  return "anonymous";
}

function normalizePassId(passId) {
  return safeString(passId || "", "");
}

function newAnonymousPassId() {
  return `pass:anon:${crypto.randomUUID()}`;
}

function resolvePassId({
  existingPassId = null,
  incomingPassId = null,
  shopifyId = null,
  userId = null,
  email = null,
}) {
  const incoming = normalizePassId(existingPassId || incomingPassId);
  if (incoming) return incoming;

  const cleanShopify = safeString(shopifyId || "", "");
  if (cleanShopify && cleanShopify !== "anonymous") return `pass:shopify:${cleanShopify}`;

  const cleanUserId = safeString(userId || "", "");
  if (cleanUserId) return `pass:user:${cleanUserId}`;

  const normEmail = safeString(email || "", "").toLowerCase();
  if (normEmail) return `pass:email:${normEmail}`;

  return newAnonymousPassId();
}

// UUID helpers for sessions (MMA still accepts sess_<uuid>)
function isUuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function normalizeSessionUuid(sessionIdRaw) {
  const s = safeString(sessionIdRaw || "");
  if (!s) return "";
  if (s.startsWith("sess_")) {
    const maybe = s.slice("sess_".length);
    return isUuid(maybe) ? maybe : s;
  }
  return s;
}

function getRequestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    route: req.path,
    method: req.method,
  };
}

// ======================================================
// Admin audit helpers
// ======================================================
function auditAiEvent(req, action, status, detail = {}) {
  const meta = req ? getRequestMeta(req) : {};
  const userId = req?.user?.userId;
  const email = req?.user?.email;

  const normalizedDetail = { ...detail };
  normalizedDetail.ip = meta.ip;
  normalizedDetail.userAgent = meta.userAgent;
  normalizedDetail.user_id = userId || undefined;
  normalizedDetail.email = email || undefined;

  void logAdminAction({
    userId,
    email,
    action,
    status,
    route: detail.route || meta.route,
    method: detail.method || meta.method,
    detail: normalizedDetail,
  });
}

function persistSessionHash(req, token, userId, email) {
  if (!token) return;
  void upsertSessionRow({
    userId,
    email,
    token,
    ip: req?.ip,
    userAgent: req?.get ? req.get("user-agent") : null,
  });
}

// ======================================================
// Credits expiry policy (rolling)
// ======================================================
const DEFAULT_CREDITS_EXPIRE_DAYS = (() => {
  const raw = Number(ENV.CREDITS_EXPIRE_DAYS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 30;
})();

function addDaysToIso(baseIso, days) {
  const baseMs = Date.parse(String(baseIso || ""));
  if (!Number.isFinite(baseMs)) return null;
  const ms = baseMs + Number(days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function maxIso(aIso, bIso) {
  const a = Date.parse(String(aIso || ""));
  const b = Date.parse(String(bIso || ""));
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
  if (!Number.isFinite(a)) return bIso || null;
  if (!Number.isFinite(b)) return aIso || null;
  return a >= b ? (aIso || null) : (bIso || null);
}

// ======================================================
// Supabase business helpers (MEGA tables only)
// ======================================================
async function sbEnsureCustomer({ customerId, userId, email, passId = null }) {
  if (!supabaseAdmin) return null;

  const rawCustomerId = safeString(customerId, "");
  const incomingPassId = passId || (rawCustomerId.startsWith("pass:") ? rawCustomerId : null);
  const derivedShopify = rawCustomerId.startsWith("pass:shopify:")
    ? rawCustomerId.slice("pass:shopify:".length)
    : null;

  const id = derivedShopify || (incomingPassId ? "anonymous" : safeShopifyId(customerId));

  const { passId: ensuredPassId, credits = 0, shopifyCustomerId, meta } = await megaEnsureCustomer(
    supabaseAdmin,
    {
      customerId: id,
      userId: userId || null,
      email: email || null,
      legacyCredits: null,
      passId: incomingPassId,
    }
  );

  return {
    shopify_customer_id: shopifyCustomerId || id,
    credits,
    meta: meta || {},
    passId: ensuredPassId || null,
  };
}

async function sbGetCredits({ customerId, reqUserId, reqEmail }) {
  if (!supabaseAdmin) return { balance: null, historyLength: null, source: "no-sb", passId: null };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  const { count, error: countErr } = await supabaseAdmin
    .from("mega_generations")
    .select("mg_id", { count: "exact", head: true })
    .eq("mg_record_type", "credit_transaction")
    .eq("mg_pass_id", cust.passId);

  return {
    balance: cust.credits ?? 0,
    historyLength: countErr ? null : (count ?? 0),
    source: "mega",
    passId: cust?.passId || null,
  };
}

// WARNING: not fully atomic under concurrency (fine for low traffic)
async function sbAdjustCredits({
  customerId,
  delta,
  reason,
  source,
  refType,
  refId,
  reqUserId,
  reqEmail,
  grantedAt = null,
}) {
  if (!supabaseAdmin) return { ok: false, balance: null, source: "no-sb", passId: null };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);

  await megaWriteCreditTxnEvent(supabaseAdmin, {
    customerId: cust.shopify_customer_id,
    userId: reqUserId || null,
    email: reqEmail || null,
    id: refId || crypto.randomUUID(),
    delta,
    reason,
    source,
    refType,
    refId,
    createdAt: nowIso(),
    nextBalance,
  });

  // Rolling expiry: positive grant extends expiry
  if (Number(delta || 0) > 0 && cust?.passId) {
    const grantIso = safeString(grantedAt || nowIso(), nowIso());
    const desired = addDaysToIso(grantIso, DEFAULT_CREDITS_EXPIRE_DAYS);

    const { data: row, error: readErr } = await supabaseAdmin
      .from("mega_customers")
      .select("mg_expires_at")
      .eq("mg_pass_id", cust.passId)
      .maybeSingle();
    if (readErr) throw readErr;

    const nextExp = maxIso(row?.mg_expires_at || null, desired);
    if (nextExp && nextExp !== (row?.mg_expires_at || null)) {
      const { error: upErr } = await supabaseAdmin
        .from("mega_customers")
        .update({ mg_expires_at: nextExp, mg_updated_at: nowIso() })
        .eq("mg_pass_id", cust.passId);
      if (upErr) throw upErr;
    }
  }

  return { ok: true, balance: nextBalance, source: "mega", passId: cust?.passId || null };
}

async function sbUpsertAppSession({ id, customerId, platform, title, createdAt }) {
  if (!supabaseAdmin) return;

  const sid = normalizeSessionUuid(id);
  if (!isUuid(sid)) throw new Error(`sessions.id must be uuid; got "${id}"`);

  await megaWriteSessionEvent(supabaseAdmin, {
    customerId: safeShopifyId(customerId),
    sessionId: sid,
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    createdAt: createdAt || nowIso(),
  });
}

async function sbCountCustomers() {
  if (!supabaseAdmin) return null;
  const { count, error } = await supabaseAdmin
    .from("mega_customers")
    .select("mg_pass_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function sbListCustomers(limit = 500) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("mega_customers")
    .select("mg_shopify_customer_id,mg_email,mg_credits,mg_last_active,mg_created_at,mg_updated_at,mg_disabled")
    .order("mg_shopify_customer_id", { ascending: true })
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  if (error) throw error;
  return (data || []).map((r) => ({
    shopify_customer_id: r.mg_shopify_customer_id,
    email: r.mg_email,
    credits: r.mg_credits,
    last_active: r.mg_last_active,
    created_at: r.mg_created_at,
    updated_at: r.mg_updated_at,
    disabled: r.mg_disabled,
  }));
}

async function sbGetCustomerHistory(customerId) {
  if (!supabaseAdmin) return null;

  const cid = safeShopifyId(customerId);
  const cust = await sbEnsureCustomer({ customerId: cid, userId: null, email: null });
  const passId = cust?.passId || null;

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("mega_customers")
      .select("mg_shopify_customer_id,mg_credits,mg_pass_id,mg_expires_at")
      .eq("mg_shopify_customer_id", cid)
      .maybeSingle(),
    passId
      ? supabaseAdmin
          .from("mega_generations")
          .select("*")
          .eq("mg_pass_id", passId)
          .eq("mg_record_type", "generation")
          .order("mg_created_at", { ascending: false })
          .limit(500)
      : { data: [], error: null },
    passId
      ? supabaseAdmin
          .from("mega_generations")
          .select("*")
          .eq("mg_pass_id", passId)
          .eq("mg_record_type", "feedback")
          .order("mg_created_at", { ascending: false })
          .limit(500)
      : { data: [], error: null },
    passId
      ? supabaseAdmin
          .from("mega_generations")
          .select("*")
          .eq("mg_pass_id", passId)
          .eq("mg_record_type", "credit_transaction")
          .order("mg_created_at", { ascending: false })
          .limit(500)
      : { data: [], error: null },
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: cid,
    credits: {
      balance: custRes.data?.mg_credits ?? 0,
      expiresAt: custRes.data?.mg_expires_at ?? null,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

async function sbGetCustomerHistoryByPassId(passId) {
  if (!supabaseAdmin) return null;

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("mega_customers")
      .select("mg_shopify_customer_id,mg_credits,mg_pass_id,mg_expires_at")
      .eq("mg_pass_id", passId)
      .maybeSingle(),
    supabaseAdmin
      .from("mega_generations")
      .select("*")
      .eq("mg_pass_id", passId)
      .eq("mg_record_type", "generation")
      .order("mg_created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("mega_generations")
      .select("*")
      .eq("mg_pass_id", passId)
      .eq("mg_record_type", "feedback")
      .order("mg_created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("mega_generations")
      .select("*")
      .eq("mg_pass_id", passId)
      .eq("mg_record_type", "credit_transaction")
      .order("mg_created_at", { ascending: false })
      .limit(500),
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: custRes.data?.mg_shopify_customer_id || passId,
    credits: {
      balance: custRes.data?.mg_credits ?? 0,
      expiresAt: custRes.data?.mg_expires_at ?? null,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

// ======================================================
// MMA preferences: keep in MEGA customers row (mg_mma_preferences)
// ======================================================
function normalizeMmaPreferences(pref = {}) {
  const hardBlocks = Array.isArray(pref?.hard_blocks)
    ? pref.hard_blocks.map((v) => safeString(v, "")).filter(Boolean)
    : [];

  const tagWeights = {};
  if (pref && typeof pref.tag_weights === "object") {
    for (const [tag, weight] of Object.entries(pref.tag_weights)) {
      const t = safeString(tag, "");
      const n = Number(weight);
      if (t && Number.isFinite(n)) tagWeights[t] = n;
    }
  }

  return {
    hard_blocks: Array.from(new Set(hardBlocks)),
    tag_weights: tagWeights,
    updated_at: pref?.updated_at || pref?.updatedAt || null,
    source: pref?.source || "mma",
  };
}

function mergeHardBlocks(target, additions = []) {
  let changed = false;
  for (const value of additions) {
    const v = safeString(value, "");
    if (v && !target.includes(v)) {
      target.push(v);
      changed = true;
    }
  }
  return changed;
}

function adjustTagWeights(target, tags = [], delta = 0) {
  let changed = false;
  for (const tag of tags) {
    const t = safeString(tag, "");
    if (!t) continue;
    const current = Number(target[t] ?? 0);
    const next = Number.isFinite(current) ? current + delta : delta;
    target[t] = Number.isFinite(next) ? Number(next) : delta;
    changed = true;
  }
  return changed;
}

function applyMmaEventToPreferences(pref, eventType, payload, updatedAt) {
  const next = normalizeMmaPreferences(pref);
  const safePayload = payload && typeof payload === "object" ? payload : {};

  const hardBlockPayload = [];
  if (safePayload.hard_block) hardBlockPayload.push(safeString(safePayload.hard_block, ""));
  if (Array.isArray(safePayload.hard_blocks)) {
    hardBlockPayload.push(...safePayload.hard_blocks.map((v) => safeString(v, "")));
  }

  const tags = Array.isArray(safePayload.tags)
    ? safePayload.tags.map((t) => safeString(t, "")).filter(Boolean)
    : safePayload.tag
      ? [safeString(safePayload.tag, "")]
      : [];

  const payloadTagWeights =
    safePayload.tag_weights && typeof safePayload.tag_weights === "object"
      ? safePayload.tag_weights
      : null;

  let changed = false;

  if (eventType === "preference_set" || (eventType === "dislike" && hardBlockPayload.length)) {
    changed = mergeHardBlocks(next.hard_blocks, hardBlockPayload) || changed;
  }

  if (eventType === "like" || eventType === "dislike") {
    changed = adjustTagWeights(next.tag_weights, tags, eventType === "like" ? 1 : -1) || changed;
  }

  if (eventType === "preference_set" && payloadTagWeights) {
    for (const [tag, weight] of Object.entries(payloadTagWeights)) {
      const t = safeString(tag, "");
      const n = Number(weight);
      if (!t || !Number.isFinite(n)) continue;
      if (next.tag_weights[t] !== n) {
        next.tag_weights[t] = n;
        changed = true;
      }
    }
  }

  if (changed) {
    next.updated_at = updatedAt;
    next.source = "mma";
  }

  return { next, changed };
}

async function updateMmaPreferencesForEvent(passId, eventType, payload) {
  if (!supabaseAdmin) return null;
  if (!eventType) return null;

  const ts = nowIso();
  const { data, error } = await supabaseAdmin
    .from("mega_customers")
    .select("mg_mma_preferences")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  if (error) throw error;

  const current = data?.mg_mma_preferences || {};
  const { next, changed } = applyMmaEventToPreferences(current, eventType, payload, ts);
  if (!changed) return current;

  const updates = {
    mg_mma_preferences: next,
    mg_mma_preferences_updated_at: ts,
    mg_last_active: ts,
    mg_updated_at: ts,
  };

  const { error: upErr } = await supabaseAdmin.from("mega_customers").update(updates).eq("mg_pass_id", passId);
  if (upErr) throw upErr;

  return next;
}

// ======================================================
// R2 (public, non-expiring)
// ======================================================
const R2_ACCOUNT_ID = ENV.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = ENV.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = ENV.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = ENV.R2_BUCKET || "";
const R2_ENDPOINT = ENV.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

const R2_PUBLIC_BASE_URL = ENV.R2_PUBLIC_BASE_URL || "";
if (IS_PROD && !R2_PUBLIC_BASE_URL) {
  throw new Error("R2_PUBLIC_BASE_URL is REQUIRED in production so asset URLs are permanent (non-expiring).");
}

function r2Enabled() {
  return Boolean(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

const r2 = r2Enabled()
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

function safeName(name = "file") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}
function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}
function guessExtFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "";
}
function encodeKeyForUrl(key) {
  return String(key || "")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}
function r2PublicUrlForKeyLocal(key) {
  if (!key) return "";
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return "";
}

async function r2PutPublic({ key, body, contentType }) {
  if (!r2Enabled() || !r2) throw new Error("R2_NOT_CONFIGURED");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicUrl = r2PublicUrlForKeyLocal(key);
  if (!publicUrl) throw new Error("Missing R2_PUBLIC_BASE_URL (or public fallback config).");
  return { key, publicUrl };
}

async function storeRemoteToR2Public({ remoteUrl, kind = "generations", customerId = "anon" }) {
  const resp = await fetch(remoteUrl);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const extGuess = guessExtFromContentType(contentType);
  const key = `${folder}/${cid}/${Date.now()}-${uuid}${extGuess ? `.${extGuess}` : ""}`;

  return r2PutPublic({ key, body: buf, contentType });
}

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
app.use((req, res, next) => {
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
// Shopify webhook (RAW body + HMAC verify) — keep for prod credits
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

// Raw webhook route MUST be before express.json()
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

    const order = rawBody ? JSON.parse(rawBody) : {};
    const orderId = order?.id != null ? String(order.id) : null;

    const shopifyCustomerId = order?.customer?.id != null ? String(order.customer.id) : null;
    const email = String(order?.email || order?.customer?.email || "").toLowerCase();

    if (!orderId) return res.status(400).json({ ok: false, error: "MISSING_ORDER_ID", requestId });
    if (!supabaseAdmin) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

    // Idempotency
    const { data: existing, error: exErr } = await supabaseAdmin
      .from("mega_generations")
      .select("mg_id")
      .eq("mg_record_type", "credit_transaction")
      .eq("mg_ref_type", "shopify_order")
      .eq("mg_ref_id", orderId)
      .limit(1);
    if (exErr) throw exErr;
    if (existing && existing.length) {
      return res.status(200).json({ ok: true, requestId, alreadyProcessed: true, orderId });
    }

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

    const customerKey = shopifyCustomerId || email || "anonymous";
    const grantedAt = order?.processed_at || order?.created_at || nowIso();

    const out = await sbAdjustCredits({
      customerId: customerKey,
      delta: credits,
      reason: "shopify-order",
      source: "shopify",
      refType: "shopify_order",
      refId: orderId,
      reqUserId: null,
      reqEmail: email || null,
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
      customerId: customerKey,
      credited: credits,
      balance: out.balance,
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
// Frontend error logger
// ======================================================
app.post("/api/log-error", async (req, res) => {
  try {
    const body = req.body || {};
    await logError({
      action: "frontend.error",
      status: 500,
      route: body.url || "/(frontend)",
      method: "FRONTEND",
      message: body.message || "Frontend crash",
      stack: body.stack,
      userAgent: body.userAgent || req.get("user-agent"),
      ip: req.headers["x-forwarded-for"] || req.ip,
      userId: body.userId,
      email: body.email,
      emoji: "🖥️",
      code: "FRONTEND_CRASH",
      detail: { ...(body.extra || {}) },
      sourceSystem: "mina-frontend",
    });
  } catch (err) {
    console.error("[POST /api/log-error] failed to record", err);
  }
  res.json({ ok: true });
});

// ======================================================
// Auth helpers
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

// ======================================================
// MMA clients + router wiring
// ======================================================
const replicate = new Replicate({ auth: ENV.REPLICATE_API_TOKEN });
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

const createMmaController =
  mmaControllerMod.createMmaController || mmaControllerMod.default;

if (typeof createMmaController !== "function") {
  throw new Error("MMA controller factory not found. Expected createMmaController export in ./server/mma/mma-controller.js");
}

const mmaController = createMmaController({ supabaseAdmin, openai, replicate });
const mmaHub = typeof mmaController?.getHub === "function" ? mmaController.getHub() : null;

// ======================================================
// Routes
// ======================================================

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina MMA API (Supabase)",
    time: nowIso(),
    supabase: sbEnabled(),
    r2: r2Enabled(),
  });
});

// /me (kept, but simplified and safe)
app.get("/me", async (req, res) => {
  const requestId = `me_${Date.now()}_${crypto.randomUUID()}`;
  const incomingPassId = normalizePassId(req.get("X-Mina-Pass-Id"));

  try {
    const token = getBearerToken(req);

    // No token => anonymous
    if (!token) {
      const passId = resolvePassId({ incomingPassId });
      res.set("X-Mina-Pass-Id", passId);
      return res.json({ ok: true, user: null, isAdmin: false, passId, requestId });
    }

    if (!supabaseAdmin) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: "INVALID_TOKEN", requestId });

    const email = String(data.user.email || "").toLowerCase();
    const userId = String(data.user.id || "");
    if (!userId) return res.status(401).json({ ok: false, error: "MISSING_USER_ID", requestId });

    // Ensure customer row exists
    const cust = await sbEnsureCustomer({ customerId: incomingPassId || "anonymous", userId, email });
    const passId = resolvePassId({
      existingPassId: cust?.passId,
      incomingPassId,
      userId,
      email,
    });

    res.set("X-Mina-Pass-Id", passId);

    return res.json({
      ok: true,
      user: { id: userId, email },
      isAdmin: false,
      passId,
      requestId,
    });
  } catch (e) {
    console.error("GET /me failed", e);
    const fallbackPassId = resolvePassId({ incomingPassId });
    res.set("X-Mina-Pass-Id", fallbackPassId);
    return res.status(200).json({
      ok: true,
      user: null,
      isAdmin: false,
      passId: fallbackPassId,
      requestId,
      degraded: true,
      degradedReason: e?.message || String(e),
    });
  }
});

// Public stats
app.get("/public/stats/total-users", async (_req, res) => {
  try {
    if (!sbEnabled()) return res.json({ ok: true, totalUsers: 0, source: "no-supabase" });
    const count = await sbCountCustomers();
    return res.json({ ok: true, totalUsers: Math.max(0, Number(count ?? 0)), source: "mega_customers" });
  } catch (e) {
    console.error("GET /public/stats/total-users failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: "STATS_FAILED" });
  }
});

// History
app.get("/history", async (req, res) => {
  try {
    const customerId = resolveCustomerId(req, req.query);
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
    const history = await sbGetCustomerHistory(customerId);
    return res.json({
      ok: true,
      customerId,
      generations: history?.generations || [],
      feedbacks: history?.feedbacks || [],
      credits: history?.credits || { balance: 0, history: [] },
    });
  } catch (err) {
    console.error("GET /history error:", err);
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED", message: err?.message || "Failed" });
  }
});

app.get("/history/pass/:passId", async (req, res) => {
  try {
    const passId = String(req.params.passId || "").trim();
    if (!passId) return res.status(400).json({ ok: false, error: "MISSING_PASS_ID" });
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });

    const history = await sbGetCustomerHistoryByPassId(passId);
    return res.json({
      ok: true,
      customerId: history.customerId,
      generations: history.generations,
      feedbacks: history.feedbacks,
      credits: history.credits,
    });
  } catch (err) {
    console.error("GET /history/pass/:passId error:", err);
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED", message: err?.message || "Failed" });
  }
});

// Credits
app.get("/credits/balance", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const customerId = resolveCustomerId(req, { customerId: req.query.customerId });

    if (!sbEnabled()) {
      return res.json({
        ok: false,
        requestId,
        customerId,
        balance: null,
        historyLength: null,
        message: "Supabase not configured",
        passId: null,
      });
    }

    const rec = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    return res.json({
      ok: true,
      requestId,
      customerId,
      balance: rec.balance,
      historyLength: rec.historyLength,
      source: rec.source,
      passId: rec.passId,
    });
  } catch (err) {
    console.error("Error in /credits/balance:", err);
    return res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error",
      requestId,
    });
  }
});

app.post("/credits/add", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId = resolveCustomerId(req, body);
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
    const reason = safeString(body.reason || "manual-topup");
    const source = safeString(body.source || "api");

    if (!amount || !Number.isFinite(amount)) {
      return res.status(400).json({ ok: false, error: "INVALID_AMOUNT", message: "amount must be a number", requestId });
    }
    if (!sbEnabled()) return res.status(500).json({ ok: false, error: "NO_DB", requestId });

    const out = await sbAdjustCredits({
      customerId,
      delta: amount,
      reason,
      source,
      refType: "manual",
      refId: requestId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    return res.json({
      ok: true,
      requestId,
      customerId,
      newBalance: out.balance,
      source: out.source,
      passId: out?.passId || null,
    });
  } catch (err) {
    console.error("Error in /credits/add:", err);
    return res.status(500).json({ ok: false, error: "CREDITS_ERROR", message: err?.message || "Unexpected", requestId });
  }
});

// Sessions
app.post("/sessions/start", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId = resolveCustomerId(req, body);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const title = safeString(body.title || "Mina session");

    if (!sbEnabled()) return res.status(500).json({ ok: false, error: "NO_DB", requestId });

    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    const sessionId = uuidv4();
    await sbUpsertAppSession({
      id: sessionId,
      customerId: safeShopifyId(customerId),
      platform,
      title,
      createdAt: nowIso(),
    });

    persistSessionHash(req, sessionId, req.user?.userId, req.user?.email);

    return res.json({
      ok: true,
      requestId,
      session: { id: sessionId, customerId: safeShopifyId(customerId), platform, title, createdAt: nowIso() },
      passId: cust?.passId || null,
    });
  } catch (err) {
    console.error("Error in /sessions/start:", err);
    return res.status(500).json({ ok: false, error: "SESSION_ERROR", message: err?.message || "Unexpected", requestId });
  }
});

// ======================================================
// MMA legacy-compat shims (optional but safe to keep)
// ======================================================
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    if (!sbEnabled()) return res.status(500).json({ ok: false, error: "NO_DB", requestId });

    const body = req.body || {};
    const customerId = resolveCustomerId(req, body);

    const result = await mmaController.runStillCreate({
      customerId,
      email: req?.user?.email || null,
      userId: req?.user?.userId || null,
      assets: {
        product_url: safeString(body.productImageUrl) || null,
        logo_url: safeString(body.logoImageUrl) || null,
        inspiration_urls: Array.isArray(body.styleImageUrls) ? body.styleImageUrls.filter(Boolean) : [],
        style_hero_url: null,
        input_still_image_id: null,
        still_url: null,
      },
      inputs: {
        userBrief: safeString(body.brief),
        style: safeString(body.tone || body.stylePresetKey || ""),
        aspect_ratio: safeString(body.aspectRatio || ""),
        platform: safeString(body.platform || ""),
      },
      history: { vision_intelligence: !!body.minaVisionEnabled },
      brief: safeString(body.brief || ""),
      settings: {},
    });

    if (result?.passId) res.set("X-Mina-Pass-Id", result.passId);

    const imageUrl = result?.outputs?.seedream_image_url || null;
    const prompt = result?.mma_vars?.prompts?.clean_prompt || safeString(body.brief || "");

    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    return res.json({
      ok: true,
      requestId,
      generationId: result?.generationId,
      passId: result?.passId || null,
      prompt,
      imageUrl,
      imageUrls: imageUrl ? [imageUrl] : [],
      sessionId: null,
      gpt: {
        userMessage: result?.mma_vars?.prompts?.clean_prompt || null,
      },
      credits: creditsInfo?.balance == null ? undefined : { balance: creditsInfo.balance },
    });
  } catch (err) {
    console.error("Error in /editorial/generate (mma shim):", err);
    return res.status(500).json({ ok: false, error: "MMA_EDITORIAL_ERROR", message: err?.message || "Unexpected", requestId });
  }
});

app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    if (!sbEnabled()) return res.status(500).json({ ok: false, error: "NO_DB", requestId });

    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription || body.text || body.motionBrief || "");

    if (!lastImageUrl) return res.status(400).json({ ok: false, error: "MISSING_LAST_IMAGE", requestId });
    if (!motionDescription) return res.status(400).json({ ok: false, error: "MISSING_MOTION_DESCRIPTION", requestId });

    const customerId = resolveCustomerId(req, body);
    const platform = safeString(body.platform || "");
    const aspectRatio = safeString(body.aspectRatio || body.motionAspectRatio || "");
    const motionStyles = Array.isArray(body.motionStyles || body.motionStyleKeys)
      ? (body.motionStyles || body.motionStyleKeys).filter(Boolean)
      : [];

    const result = await mmaController.runVideoAnimate({
      customerId,
      email: req?.user?.email || null,
      userId: req?.user?.userId || null,
      assets: { input_still_image_id: lastImageUrl, still_url: lastImageUrl },
      inputs: {
        motion_user_brief: motionDescription,
        movement_style: motionStyles.join(", ") || safeString(body.movementStyle || ""),
        platform,
        aspect_ratio: aspectRatio,
      },
      mode: { platform, aspect_ratio: aspectRatio },
      history: { vision_intelligence: !!body.minaVisionEnabled },
      brief: motionDescription,
      settings: aspectRatio ? { kling: { aspect_ratio: aspectRatio } } : {},
    });

    if (result?.passId) res.set("X-Mina-Pass-Id", result.passId);

    const videoUrl = result?.outputs?.kling_video_url || null;
    const prompt = result?.mma_vars?.prompts?.motion_prompt || motionDescription;

    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    return res.json({
      ok: true,
      requestId,
      generationId: result?.generationId,
      passId: result?.passId || null,
      prompt,
      videoUrl,
      sessionId: null,
      gpt: { userMessage: result?.mma_vars?.prompts?.motion_prompt || null },
      credits: creditsInfo?.balance == null ? undefined : { balance: creditsInfo.balance },
    });
  } catch (err) {
    console.error("Error in /motion/generate (mma shim):", err);
    return res.status(500).json({ ok: false, error: "MMA_MOTION_ERROR", message: err?.message || "Unexpected", requestId });
  }
});

// ======================================================
// MMA API (primary)
// ======================================================
if (!mmaRouter) {
  console.warn("[mma] router not loaded (check ./server/mma/mma-router.js exports)");
} else {
  app.use("/mma", mmaRouter);
}

// MMA admin logs
app.use("/admin/mma", mmaLogAdminRouter);

// ======================================================
// Admin API
// ======================================================
app.get("/admin/summary", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const totalCustomers = await sbCountCustomers();
    res.json({
      totalCustomers: totalCustomers ?? 0,
      source: "mega_customers",
    });
  } catch (err) {
    console.error("GET /admin/summary error", err);
    res.status(500).json({ error: "Failed to load admin summary" });
  }
});

app.get("/admin/customers", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });
    const rows = await sbListCustomers(500);
    res.json({ customers: rows, source: "supabase" });
  } catch (err) {
    console.error("GET /admin/customers error", err);
    res.status(500).json({ error: "Failed to load admin customers" });
  }
});

app.get("/admin/mega/parity", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "Supabase not available" });
    const summary = await megaParityCounts(supabaseAdmin);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: "MEGA_PARITY_FAILED", message: e?.message || String(e) });
  }
});

app.post("/admin/credits/adjust", requireAdmin, async (req, res) => {
  try {
    const { customerId, delta, reason } = req.body || {};
    if (!customerId || typeof delta !== "number") {
      return res.status(400).json({ error: "customerId and numeric delta are required" });
    }
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const out = await sbAdjustCredits({
      customerId: String(customerId),
      delta,
      reason: reason || "admin-adjust",
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || null,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    res.json({ customerId: String(customerId), balance: out.balance, source: out.source });
  } catch (err) {
    console.error("POST /admin/credits/adjust error", err);
    res.status(500).json({ error: "Failed to adjust credits" });
  }
});

// ======================================================
// R2 helper routes
// ======================================================
app.post("/store-remote-generation", async (req, res) => {
  try {
    const { url, urls, customerId, folder } = req.body || {};
    const remoteUrl =
      (typeof url === "string" && url) ||
      (Array.isArray(urls) && typeof urls[0] === "string" ? urls[0] : "");
    if (!remoteUrl) return res.status(400).json({ ok: false, error: "NO_URL" });

    const cid = (customerId || "anon").toString();
    const fold = (folder || "generations").toString();

    const stored = await storeRemoteToR2Public({ remoteUrl, kind: fold, customerId: cid });

    return res.json({ ok: true, key: stored.key, url: stored.publicUrl, publicUrl: stored.publicUrl });
  } catch (err) {
    console.error("POST /store-remote-generation error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED", message: err?.message || "Failed" });
  }
});

app.post("/api/r2/upload-signed", async (req, res) => {
  try {
    const { dataUrl, kind = "uploads", customerId = "anon", filename = "" } = req.body || {};
    if (!dataUrl) return res.status(400).json({ ok: false, error: "MISSING_DATAURL" });

    const { buffer, contentType, ext } = parseDataUrl(dataUrl);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const base = safeName(filename || "upload");
    const uuid = crypto.randomUUID();

    const extGuess = ext || guessExtFromContentType(contentType);
    const key = `${folder}/${cid}/${Date.now()}-${uuid}-${base}${
      extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : ""
    }`;

    const stored = await r2PutPublic({ key, body: buffer, contentType });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,
      publicUrl: stored.publicUrl,
      contentType,
      bytes: buffer.length,
    });
  } catch (err) {
    console.error("POST /api/r2/upload-signed error:", err);
    return res.status(500).json({ ok: false, error: "UPLOAD_PUBLIC_FAILED", message: err?.message || "Unexpected error" });
  }
});

app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const stored = await storeRemoteToR2Public({ remoteUrl: url, kind, customerId });

    return res.json({ ok: true, key: stored.key, url: stored.publicUrl, publicUrl: stored.publicUrl });
  } catch (err) {
    console.error("POST /api/r2/store-remote-signed error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_PUBLIC_FAILED", message: err?.message || "Unexpected error" });
  }
});

// ======================================================
// Error middleware + listen
// ======================================================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API listening on port ${PORT}`);
});
