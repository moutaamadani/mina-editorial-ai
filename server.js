// server.js (Supabase-first, no Prisma)
// Mina Editorial AI API
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";

import {
  parseDataUrl,
  makeKey,
  putBufferToR2,
  publicUrlForKey,
  storeRemoteImageToR2,
} from "./r2.js";

import { logAdminAction, upsertGenerationRow, upsertSessionRow } from "./supabase.js";
import { requireAdmin } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MINA_BASELINE_USERS = 3651; // offset we add on top of DB users

// ======================================================
// Supabase (service role) — used for business persistence
// Tables (per your schema visualizer):
// - customers (shopify_customer_id PK)
// - credit_transactions (id uuid PK)
// - sessions (id uuid PK)
// - generations (id text PK)
// - feedback (id uuid PK)
// ======================================================
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

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

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Accept old clients sending "sess_<uuid>" and normalize to uuid
function normalizeSessionUuid(sessionIdRaw) {
  const s = safeString(sessionIdRaw || "");
  if (!s) return "";
  if (s.startsWith("sess_")) {
    const maybe = s.slice("sess_".length);
    return isUuid(maybe) ? maybe : s;
  }
  return s;
}

function isHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ======================================================
// R2 setup (Cloudflare R2 = S3 compatible)
// ======================================================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

// Optional override, otherwise computed from account id
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function safeName(name = "file") {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
// =======================
// GPT I/O capture helpers (store what we send to OpenAI + what we get back)
// =======================
function truncateStr(s, max = 4000) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated ${s.length - max} chars]`;
}

// userContent is sometimes a string, sometimes an array of {type:"text"} + {type:"image_url"}
function summarizeUserContent(userContent) {
  if (typeof userContent === "string") {
    return { userText: truncateStr(userContent, 6000), imageUrls: [], imagesCount: 0 };
  }

  const parts = Array.isArray(userContent) ? userContent : [];
  const texts = [];
  const imageUrls = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
      imageUrls.push(p.image_url.url);
    }
  }

  return {
    userText: truncateStr(texts.join("\n\n"), 6000),
    imageUrls: imageUrls.slice(0, 8), // keep it small
    imagesCount: imageUrls.length,
  };
}

function makeGptIOInput({ model, systemMessage, userContent, temperature, maxTokens }) {
  const sys = typeof systemMessage?.content === "string" ? systemMessage.content : "";
  const { userText, imageUrls, imagesCount } = summarizeUserContent(userContent);

  return {
    model: model || null,
    temperature: typeof temperature === "number" ? temperature : null,
    maxTokens: typeof maxTokens === "number" ? maxTokens : null,
    system: truncateStr(sys, 6000),
    userText,
    imageUrls,
    imagesCount,
  };
}

async function r2PutAndSignGet({ key, body, contentType }) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );

  // Signed GET URL (works even if bucket is private)
  const signedUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: 60 * 60 * 24 * 7 } // 7 days
  );

  return signedUrl;
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
// Admin audit helpers (kept as-is)
// ======================================================
function auditAiEvent(req, action, status, detail = {}) {
  const meta = req ? getRequestMeta(req) : {};
  const userId = req?.user?.userId;
  const email = req?.user?.email;

  const normalizedDetail = { ...detail };
  normalizedDetail.request_id =
    normalizedDetail.request_id || normalizedDetail.requestId || null;
  normalizedDetail.step = normalizedDetail.step || normalizedDetail.stage || null;
  normalizedDetail.input_type =
    normalizedDetail.input_type || normalizedDetail.inputType || null;
  normalizedDetail.output_type =
    normalizedDetail.output_type || normalizedDetail.outputType || null;
  normalizedDetail.r2_url = normalizedDetail.r2_url || normalizedDetail.r2Url || null;
  normalizedDetail.model = normalizedDetail.model || null;
  normalizedDetail.provider = normalizedDetail.provider || null;

  normalizedDetail.latency_ms =
    typeof normalizedDetail.latency_ms === "number"
      ? normalizedDetail.latency_ms
      : typeof normalizedDetail.latencyMs === "number"
        ? normalizedDetail.latencyMs
        : null;

  normalizedDetail.input_chars =
    typeof normalizedDetail.input_chars === "number"
      ? normalizedDetail.input_chars
      : typeof normalizedDetail.inputChars === "number"
        ? normalizedDetail.inputChars
        : null;

  normalizedDetail.output_chars =
    typeof normalizedDetail.output_chars === "number"
      ? normalizedDetail.output_chars
      : typeof normalizedDetail.outputChars === "number"
        ? normalizedDetail.outputChars
        : null;

  delete normalizedDetail.requestId;
  delete normalizedDetail.inputType;
  delete normalizedDetail.outputType;
  delete normalizedDetail.r2Url;
  delete normalizedDetail.latencyMs;
  delete normalizedDetail.inputChars;
  delete normalizedDetail.outputChars;

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
  const meta = req ? getRequestMeta(req) : {};
  void upsertSessionRow({
    userId,
    email,
    token,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// ======================================================
// Supabase business persistence helpers
// ======================================================

// Create customer row on first contact (+ optional welcome credits txn)
const DEFAULT_FREE_CREDITS = Number(process.env.DEFAULT_FREE_CREDITS || 50);

async function sbGetCustomer(customerId) {
  if (!supabaseAdmin) return null;
  const id = safeShopifyId(customerId);

  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,user_id,email,credits,expires_at,last_active,disabled,created_at,updated_at,meta")
    .eq("shopify_customer_id", id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function sbInsertCreditTxn({ customerId, delta, reason, source, refType = null, refId = null }) {
  if (!supabaseAdmin) return;

  const txn = {
    id: crypto.randomUUID(), // uuid column
    shopify_customer_id: safeShopifyId(customerId),
    delta: Number(delta || 0),
    reason: String(reason || "adjustment"),
    source: String(source || "api"),
    ref_type: refType ? String(refType) : null,
    ref_id: refId ? String(refId) : null,
    created_at: nowIso(),
  };

  const { error } = await supabaseAdmin.from("credit_transactions").insert(txn);
  if (error) throw error;
}

async function sbEnsureCustomer({ customerId, userId, email }) {
  if (!supabaseAdmin) return null;

  const id = safeShopifyId(customerId);
  let row = await sbGetCustomer(id);

  if (!row) {
    const ts = nowIso();
    const startingCredits = DEFAULT_FREE_CREDITS > 0 ? DEFAULT_FREE_CREDITS : 0;

    const payload = {
      shopify_customer_id: id,
      user_id: userId || null,
      email: email || null,
      credits: startingCredits,
      last_active: ts,
      created_at: ts,
      updated_at: ts,
      meta: {},
      disabled: false,
    };

    const { data, error } = await supabaseAdmin
      .from("customers")
      .insert(payload)
      .select("shopify_customer_id,user_id,email,credits,expires_at,last_active,disabled,created_at,updated_at,meta")
      .single();

    if (error) throw error;
    row = data;

    // Insert welcome transaction (mirrors old behavior)
    if (startingCredits > 0) {
      try {
        await sbInsertCreditTxn({
          customerId: id,
          delta: startingCredits,
          reason: "auto-welcome",
          source: "system",
          refType: "welcome",
          refId: null,
        });
      } catch (e) {
        // Don’t break customer creation on txn failure
        console.error("[supabase] welcome txn insert failed:", e?.message || e);
      }
    }
  } else {
    // touch last_active / attach email/user_id if newly known
    const updates = { last_active: nowIso(), updated_at: nowIso() };
    if (userId && !row.user_id) updates.user_id = userId;
    if (email && !row.email) updates.email = email;

    const { error } = await supabaseAdmin.from("customers").update(updates).eq("shopify_customer_id", id);
    if (error) throw error;
  }

  return row;
}

async function sbGetCredits({ customerId, reqUserId, reqEmail }) {
  if (!supabaseAdmin) return { balance: null, historyLength: null, source: "no-sb" };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  // count txns
  const { count, error: countErr } = await supabaseAdmin
    .from("credit_transactions")
    .select("id", { count: "exact", head: true })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  return {
    balance: cust.credits ?? 0,
    historyLength: countErr ? null : (count ?? 0),
    source: "supabase",
  };
}

// WARNING: not fully atomic under concurrency (fine for low traffic)
async function sbAdjustCredits({ customerId, delta, reason, source, refType, refId, reqUserId, reqEmail }) {
  if (!supabaseAdmin) return { ok: false, balance: null, source: "no-sb" };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);
  const updates = {
    credits: nextBalance,
    last_active: nowIso(),
    updated_at: nowIso(),
  };

  if (reqUserId) updates.user_id = reqUserId;
  if (reqEmail) updates.email = reqEmail;

  const { error } = await supabaseAdmin.from("customers").update(updates).eq("shopify_customer_id", cust.shopify_customer_id);
  if (error) throw error;

  // Insert transaction (best effort)
  try {
    await sbInsertCreditTxn({
      customerId: cust.shopify_customer_id,
      delta,
      reason,
      source,
      refType,
      refId,
    });
  } catch (e) {
    console.error("[supabase] credit txn insert failed:", e?.message || e);
  }

  return { ok: true, balance: nextBalance, source: "supabase" };
}

async function sbUpsertAppSession({ id, customerId, platform, title, createdAt }) {
  if (!supabaseAdmin) return;

  const sid = normalizeSessionUuid(id);
  if (!isUuid(sid)) throw new Error(`sessions.id must be uuid; got "${id}"`);

  const payload = {
    id: sid,
    shopify_customer_id: safeShopifyId(customerId),
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    created_at: createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("sessions").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbUpsertGenerationBusiness(gen) {
  if (!supabaseAdmin) return;

  // generations.id is text in your schema (so "gen_<uuid>" is OK)
  const payload = {
    id: String(gen.id),
    type: String(gen.type || "image"),
    session_id: gen.sessionId ? String(gen.sessionId) : null,
    customer_id: gen.customerId ? String(gen.customerId) : null,
    platform: gen.platform ? String(gen.platform) : null,
    prompt: gen.prompt ? String(gen.prompt) : "",
    output_url: gen.outputUrl ? String(gen.outputUrl) : null,
    meta: gen.meta ?? null,
    created_at: gen.createdAt || nowIso(),
    updated_at: nowIso(),
    shopify_customer_id: gen.customerId ? String(gen.customerId) : null,
    provider: gen.meta?.provider ? String(gen.meta.provider) : (gen.provider ? String(gen.provider) : null),
    output_key: gen.outputKey ? String(gen.outputKey) : null,
  };

  const { error } = await supabaseAdmin.from("generations").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbUpsertFeedbackBusiness(fb) {
  if (!supabaseAdmin) return;

  const fid = fb.id;
  if (!isUuid(fid)) throw new Error(`feedback.id must be uuid; got "${fid}"`);

  const sessionUuid = fb.sessionId ? normalizeSessionUuid(fb.sessionId) : null;
  if (sessionUuid && !isUuid(sessionUuid)) {
    // If client sends legacy / invalid session id, just drop it
    console.warn("[feedback] dropping invalid sessionId:", fb.sessionId);
  }

  const payload = {
    id: fid,
    shopify_customer_id: safeShopifyId(fb.customerId),
    session_id: sessionUuid && isUuid(sessionUuid) ? sessionUuid : null,
    generation_id: fb.generationId ? String(fb.generationId) : null,
    result_type: String(fb.resultType || "image"),
    platform: fb.platform ? String(fb.platform) : null,
    prompt: String(fb.prompt || ""),
    comment: fb.comment ? String(fb.comment) : null,
    image_url: fb.imageUrl ? String(fb.imageUrl) : null,
    video_url: fb.videoUrl ? String(fb.videoUrl) : null,
    created_at: fb.createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("feedback").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbGetLikesForCustomer(customerId, limit = 50) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("feedback")
    .select("result_type,platform,prompt,comment,image_url,video_url,created_at")
    .eq("shopify_customer_id", safeShopifyId(customerId))
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(200, Number(limit || 50))));

  if (error) throw error;

  return (data || []).map((r) => ({
    resultType: r.result_type || "image",
    platform: r.platform || "tiktok",
    prompt: r.prompt || "",
    comment: r.comment || "",
    imageUrl: r.image_url || null,
    videoUrl: r.video_url || null,
    createdAt: r.created_at || nowIso(),
  }));
}

async function sbGetBillingSettings(customerId) {
  if (!supabaseAdmin) return { enabled: false, monthlyLimitPacks: 0, source: "no-db" };

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });
  const meta = cust?.meta || {};
  const autoTopup = meta.autoTopup || {};
  return {
    enabled: Boolean(autoTopup.enabled),
    monthlyLimitPacks: Number.isFinite(autoTopup.monthlyLimitPacks)
      ? Math.max(0, Math.floor(autoTopup.monthlyLimitPacks))
      : 0,
    source: "customers.meta",
  };
}

async function sbSetBillingSettings(customerId, enabled, monthlyLimitPacks) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });
  const meta = cust?.meta || {};

  const nextMeta = {
    ...meta,
    autoTopup: {
      enabled: Boolean(enabled),
      monthlyLimitPacks: Number.isFinite(monthlyLimitPacks)
        ? Math.max(0, Math.floor(monthlyLimitPacks))
        : 0,
    },
  };

  const { error } = await supabaseAdmin
    .from("customers")
    .update({ meta: nextMeta, updated_at: nowIso() })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (error) throw error;

  return { enabled: nextMeta.autoTopup.enabled, monthlyLimitPacks: nextMeta.autoTopup.monthlyLimitPacks };
}

async function sbCountCustomers() {
  if (!supabaseAdmin) return null;
  const { count, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function sbListCustomers(limit = 500) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,email,credits,last_active,created_at,updated_at,disabled")
    .order("shopify_customer_id", { ascending: true })
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  if (error) throw error;
  return data || [];
}

async function sbGetCustomerHistory(customerId) {
  if (!supabaseAdmin) return null;

  const cid = safeShopifyId(customerId);

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("customers")
      .select("shopify_customer_id,credits")
      .eq("shopify_customer_id", cid)
      .maybeSingle(),
    supabaseAdmin
      .from("generations")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("feedback")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: cid,
    credits: {
      balance: custRes.data?.credits ?? 0,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

async function sbGetAdminOverview() {
  if (!supabaseAdmin) return null;

  const [gensRes, fbRes] = await Promise.all([
    supabaseAdmin.from("generations").select("*").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("feedback").select("*").order("created_at", { ascending: false }).limit(500),
  ]);

  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;

  return {
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

// ======================================================
// Express setup
// ======================================================
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Models
const SEADREAM_MODEL = process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL = process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// How many credits each operation costs
const IMAGE_CREDITS_COST = Number(process.env.IMAGE_CREDITS_COST || 1);
const MOTION_CREDITS_COST = Number(process.env.MOTION_CREDITS_COST || 5);

// ======================================================
// Style presets
// ======================================================
const STYLE_PRESETS = {
  vintage: {
    name: "Vintage",
    profile: {
      keywords: [
        "editorial-still-life",
        "film-grain-texture",
        "muted-color-palette",
        "soft-contrast",
        "gentle-vignette",
        "studio-tabletop",
        "smooth-clean-backdrop",
        "subtle-flash-highlights",
        "timeless-magazine-look",
      ],
      description:
        "editorial still life with a luxurious, magazine-era feel. Clean compositions, smooth backgrounds, and muted tones with gentle contrast. Subtle grain and soft highlights give a timeless, refined look while keeping the scene minimal and polished. no frames",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Vintage%201.png"],
  },

  gradient: {
    name: "Gradient",
    profile: {
      keywords: [
        "gradient-background",
        "midair-suspension",
        "luxury-editorial-still-life",
        "minimal-composition",
        "hyper-texture-detail",
        "sculptural-subject",
        "dramatic-rim-light",
        "soft-vignette-falloff",
        "crisp-specular-highlights",
      ],
      description:
        "Minimal luxury still life shot against a smooth gradient backdrop, Editorial lighting with subtle rim/backlight and controlled shadows,hyper-detailed textures and sculptural forms.",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Gradient%200.png"],
  },

  "back-light": {
    name: "Back Light",
    profile: {
      keywords: [
        "luxury-editorial-still-life",
        "high-key-light-background",
        "backlit-translucency",
        "glass-refractions",
        "clean-specular-highlights",
        "minimal-composition",
        "soft-shadow-falloff",
        "premium-studio-look",
      ],
      description:
        "Luxurious editorial still life on a bright, minimal background. Clean studio lighting with glossy glass reflections and a strong backlight that reveals inner translucency and subtle texture, creating a premium, sculptural feel.",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Backlight.png"],
  },
};

// ======================================================
// Mina Vision Intelligence (now reads likes from Supabase feedback)
// Cache (in-memory) only to reduce DB reads
// ======================================================
const likeMemory = new Map(); // customerId -> [likeEntry]
const MAX_LIKES_PER_CUSTOMER = 50;

const styleProfileCache = new Map(); // customerId -> { profile, likesCountAtCompute, updatedAt }
const styleProfileHistory = new Map(); // customerId -> [ { profile, likesCountAtCompute, createdAt } ]

const MIN_LIKES_FOR_FIRST_PROFILE = 20;
const LIKES_PER_PROFILE_REFRESH = 5;

function rememberLike(customerIdRaw, entry) {
  if (!customerIdRaw) return;
  const customerId = String(customerIdRaw);
  const existing = likeMemory.get(customerId) || [];
  existing.push({
    resultType: entry.resultType || "image",
    platform: entry.platform || "tiktok",
    prompt: entry.prompt || "",
    comment: entry.comment || "",
    imageUrl: entry.imageUrl || null,
    videoUrl: entry.videoUrl || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });

  if (existing.length > MAX_LIKES_PER_CUSTOMER) {
    const excess = existing.length - MAX_LIKES_PER_CUSTOMER;
    existing.splice(0, excess);
  }

  likeMemory.set(customerId, existing);
}

async function getLikes(customerIdRaw) {
  const customerId = String(customerIdRaw || "");
  if (!customerId) return [];

  // Prefer Supabase feedback
  if (sbEnabled()) {
    try {
      const likes = await sbGetLikesForCustomer(customerId, MAX_LIKES_PER_CUSTOMER);
      likeMemory.set(customerId, likes);
      return likes;
    } catch (e) {
      console.error("[likes] supabase read failed:", e?.message || e);
      // fall back to cache
    }
  }

  return likeMemory.get(customerId) || [];
}

function getStyleHistoryFromLikes(likes) {
  return (likes || []).map((like) => ({
    prompt: like.prompt,
    platform: like.platform,
    comment: like.comment || null,
  }));
}

function mergePresetAndUserProfile(presetProfile, userProfile) {
  if (presetProfile && userProfile) {
    const combinedKeywords = [
      ...(presetProfile.keywords || []),
      ...(userProfile.keywords || []),
    ]
      .map((k) => String(k).trim())
      .filter(Boolean);
    const dedupedKeywords = Array.from(new Set(combinedKeywords));

    const description = (
      "Base style: " +
      (presetProfile.description || "") +
      " Personal twist: " +
      (userProfile.description || "")
    ).trim();

    return {
      profile: {
        keywords: dedupedKeywords,
        description,
      },
      source: "preset+user",
    };
  } else if (userProfile) {
    return { profile: userProfile, source: "user_only" };
  } else if (presetProfile) {
    return { profile: presetProfile, source: "preset_only" };
  } else {
    return { profile: null, source: "none" };
  }
}

async function runChatWithFallback({
  systemMessage,
  userContent,
  fallbackPrompt,
  model = "gpt-4.1-mini",
  temperature = 0.9,
  maxTokens = 400,
}) {
  const gptIn = makeGptIOInput({ model, systemMessage, userContent, temperature, maxTokens });

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [systemMessage, { role: "user", content: userContent }],
      temperature,
      max_tokens: maxTokens,
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty GPT response");

    return {
      prompt: text,
      usedFallback: false,
      gptError: null,
      gptModel: model,
      gptIO: {
        in: gptIn,
        out: { text: truncateStr(text, 8000) },
      },
    };
  } catch (err) {
    const outText = fallbackPrompt || "";
    return {
      prompt: outText,
      usedFallback: true,
      gptError: {
        status: err?.status || null,
        message: err?.message || String(err),
      },
      gptModel: model,
      gptIO: {
        in: gptIn,
        out: {
          text: truncateStr(outText, 8000),
          error: { status: err?.status || null, message: err?.message || String(err) },
        },
      },
    };
  }
}


// Build style profile from likes (with vision if images exist)
async function buildStyleProfileFromLikes(customerId, likes) {
  const recentLikes = (likes || []).slice(-10);
  if (!recentLikes.length) {
    return {
      profile: { keywords: [], description: "" },
      usedFallback: false,
      gptError: null,
    };
  }

  const examplesText = recentLikes
    .map((like, idx) => {
      return `#${idx + 1} [${like.resultType} / ${like.platform}]
Prompt: ${like.prompt || ""}
UserComment: ${like.comment || "none"}
HasImage: ${like.imageUrl ? "yes" : "no"}
HasVideo: ${like.videoUrl ? "yes" : "no"}`;
    })
    .join("\n\n");

  const systemMessage = {
    role: "system",
    content:
      "You are an assistant that summarizes a user's aesthetic preferences " +
      "for AI-generated editorial product images and motion.\n\n" +
      "You will see liked generations with prompts, optional comments, and sometimes the final liked image.\n\n" +
      "IMPORTANT:\n" +
      "- Treat comments as preference signals. If user says they DON'T like something (e.g. 'I like the image but I don't like the light'), do NOT treat that attribute as part of their style. Prefer avoiding repeatedly disliked attributes.\n" +
      "- For images, use the actual image content (colors, lighting, composition, background complexity, mood) to infer style.\n" +
      "- For motion entries you only see prompts/comments, use those.\n\n" +
      "Return STRICT JSON only with 'keywords' and 'description'.",
  };

  const userText = `
Customer id: ${customerId}

Below are image/video generations this customer explicitly liked.

Infer what they CONSISTENTLY LIKE, not what they dislike.
If comments mention dislikes, subtract those from your style interpretation.

Return STRICT JSON only with this shape:
{
  "keywords": ["short-tag-1", "short-tag-2", ...],
  "description": "2-3 sentence natural-language description of their style"
}

Text data for last liked generations:
${examplesText}
`.trim();

  const imageParts = [];
  recentLikes.forEach((like) => {
    if (like.resultType === "image" && like.imageUrl) {
      imageParts.push({
        type: "image_url",
        image_url: { url: like.imageUrl },
      });
    }
  });

  const userContent =
    imageParts.length > 0
      ? [{ type: "text", text: userText }, ...imageParts]
      : userText;

  const fallbackPrompt = '{"keywords":[],"description":""}';

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  let profile = { keywords: [], description: "" };
  try {
    profile = JSON.parse(result.prompt);
    if (!Array.isArray(profile.keywords)) profile.keywords = [];
    if (typeof profile.description !== "string") profile.description = "";
  } catch (e) {
    profile = { keywords: [], description: result.prompt || "" };
  }

  return {
    profile,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}

async function getOrBuildStyleProfile(customerIdRaw, likes) {
  const customerId = String(customerIdRaw || "anonymous");
  const likesCount = (likes || []).length;

  if (likesCount < MIN_LIKES_FOR_FIRST_PROFILE) {
    return {
      profile: null,
      meta: {
        source: "none",
        reason: "not_enough_likes",
        likesCount,
        minLikesForFirstProfile: MIN_LIKES_FOR_FIRST_PROFILE,
      },
    };
  }

  const cached = styleProfileCache.get(customerId);
  if (cached && likesCount < cached.likesCountAtCompute + LIKES_PER_PROFILE_REFRESH) {
    return {
      profile: cached.profile,
      meta: {
        source: "cache",
        likesCount,
        likesCountAtProfile: cached.likesCountAtCompute,
        updatedAt: cached.updatedAt,
        refreshStep: LIKES_PER_PROFILE_REFRESH,
      },
    };
  }

  const profileRes = await buildStyleProfileFromLikes(customerId, likes);
  const profile = profileRes.profile;
  const updatedAt = new Date().toISOString();

  styleProfileCache.set(customerId, {
    profile,
    likesCountAtCompute: likesCount,
    updatedAt,
  });

  const historyArr = styleProfileHistory.get(customerId) || [];
  historyArr.push({
    profile,
    likesCountAtCompute: likesCount,
    createdAt: updatedAt,
  });
  styleProfileHistory.set(customerId, historyArr);

  return {
    profile,
    meta: {
      source: "recomputed",
      likesCount,
      likesCountAtProfile: likesCount,
      updatedAt,
      refreshStep: LIKES_PER_PROFILE_REFRESH,
      usedFallback: profileRes.usedFallback,
      gptError: profileRes.gptError,
    },
  };
}

// ======================================================
// Prompt builders (kept from your version)
// ======================================================
async function buildEditorialPrompt(payload) {
  const {
    productImageUrl,
    logoImageUrl = "",
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
    styleHistory = [],
    styleProfile = null,
    presetHeroImageUrls = [],
  } = payload;

  const fallbackPrompt = [
    safeString(brief, "Editorial still-life product photo."),
    tone ? `Tone: ${tone}.` : "",
    `Shot for ${platform}, clean composition, professional lighting.`,
    "Hero product in focus, refined minimal background, fashion/editorial style.",
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none yet – this might be their first liked result.";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial art director for fashion & beauty." +
      " You will see one product image, an optional logo, and up to several style reference images." +
      " You write ONE clear prompt for a generative image model." +
      " Describe subject, environment, lighting, camera, mood, and style." +
      " Do NOT include line breaks, lists, or bullet points. One paragraph max." +
      " After the prompt, return JSON with two fields: 'imageTexts' (array of captions for each image uploaded)" +
      " and 'userMessage' (a friendly remark about one or more of the images).",
  };

  const userText = `
You are creating a new ${mode} for Mina.

Current request brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer (history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached images are:
- Main product image as the hero subject
- Optional logo image for brand identity
- Up to 3 style/mood references from the user
- Optional preset hero style image(s) defining a strong mood/look

Write the final prompt I should send to the image model.
Also, after the prompt, output JSON with 'imageTexts' and 'userMessage'.
`.trim();

    const imageParts = [];
  if (productImageUrl) imageParts.push({ type: "image_url", image_url: { url: productImageUrl } });
  if (logoImageUrl) imageParts.push({ type: "image_url", image_url: { url: logoImageUrl } });

  (styleImageUrls || [])
    .slice(0, 3)
    .filter(Boolean)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  (presetHeroImageUrls || [])
    .slice(0, 1)
    .filter(Boolean)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  // ✅ Use the shared helper so we capture GPT input/output
  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: "gpt-4.1-mini",
    temperature: 0.8,
    maxTokens: 420,
  });

  const response = (result.prompt || "").trim();
  const firstBrace = response.indexOf("{");
  let prompt = response;
  let meta = { imageTexts: [], userMessage: "" };

  if (firstBrace >= 0) {
    prompt = response.slice(0, firstBrace).trim();
    const jsonString = response.slice(firstBrace);
    try {
      const parsed = JSON.parse(jsonString);
      if (Array.isArray(parsed.imageTexts)) meta.imageTexts = parsed.imageTexts;
      if (typeof parsed.userMessage === "string") meta.userMessage = parsed.userMessage;
    } catch (_) {}
  }

  return {
    prompt,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
    imageTexts: meta.imageTexts,
    userMessage: meta.userMessage,

    // ✅ HERE IS THE IMPORTANT PART:
    gptModel: result.gptModel,
    gptIO: result.gptIO, // { in: {...}, out: {...} }
  };
}



async function buildMotionPrompt(options) {
  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
    styleHistory = [],
    styleProfile = null,
  } = options;

  const fallbackPrompt = [
    motionBrief || "Short looping editorial motion of the product.",
    tone ? `Tone: ${tone}.` : "",
    `Optimised for ${platform} vertical content.`,
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for fashion & beauty. " +
      "You will see a reference still frame. " +
      "You describe a SHORT looping product motion for a generative video model like Kling. " +
      "Keep it 1–2 sentences, no line breaks.",
  };

  const userText = `
You are creating a short motion loop based on the attached still frame.

Desired motion description from the user:
${safeString(motionBrief, "subtle elegant camera move with a small motion in the scene.")}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked image prompts for this customer (aesthetic history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached image is the reference frame to animate. Do NOT mention URLs. 
Write the final video generation prompt.
`.trim();

  const imageParts = [];
  if (lastImageUrl) imageParts.push({ type: "image_url", image_url: { url: lastImageUrl } });

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });
}

async function buildMotionSuggestion(options) {
  const {
    referenceImageUrl,
    tone,
    platform = "tiktok",
    styleHistory = [],
    styleProfile = null,

    // ✅ NEW
    userDraft = "", // typed text from textarea (optional)
    extraImageUrls = [], // product/logo/inspiration (optional)
    presetHeroImageUrls = [], // optional (if you want)
  } = options;

  const cleanedDraft = safeString(userDraft, "").trim();

  const fallbackPrompt =
    cleanedDraft ||
    "Slow, minimal motion, soft, ASMR movement, satisfying video";

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for luxury still-life. " +
      "Given images + style preferences, propose ONE short motion idea the user will see in a textarea.\n\n" +
      "Constraints:\n" +
      "- Return exactly ONE sentence, no bullet points, no quotes.\n" +
      "- Max ~220 characters.\n" +
      "- Do NOT mention 'TikTok' or 'platform', just describe the motion, in easy english, and clear scene composition.\n\n" +
      "If the user already wrote a draft, improve it while keeping the same intent.",
  };

  const userText = `
We want a motion idea for an editorial product shot.

User draft (if any):
${cleanedDraft ? cleanedDraft : "none"}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer:
${historyText}

Style profile:
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

Attached images:
- The first image is the still frame to animate (most important).
- Additional images (if present) are product/logo/style references to match the brand vibe.

Task:
Write one single-sentence motion idea. If a user draft exists, rewrite it tighter and more editorial.
`.trim();

  const imageParts = [];

  // ✅ main reference still
  if (referenceImageUrl) {
    imageParts.push({ type: "image_url", image_url: { url: referenceImageUrl } });
  }

  // ✅ optional extra images (product/logo/inspiration)
  (extraImageUrls || [])
    .filter((u) => isHttpUrl(u))
    .slice(0, 4)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  // ✅ optional preset hero image (if you want it to influence motion too)
  (presetHeroImageUrls || [])
    .filter((u) => isHttpUrl(u))
    .slice(0, 1)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  return {
    text: result.prompt,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}


// ======================================================
// Sessions (in-memory helper only; authoritative data is Supabase)
// ======================================================
const sessions = new Map(); // sessionId -> { id, customerId, platform, title, createdAt }

function createSession({ customerId, platform, title }) {
  const sessionId = uuidv4(); // MUST be uuid for sessions.id
  const session = {
    id: sessionId,
    customerId: safeShopifyId(customerId),
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    createdAt: new Date().toISOString(),
  };

  sessions.set(sessionId, session);

  // Persist to Supabase
  if (sbEnabled()) {
    void sbUpsertAppSession({
      id: sessionId,
      customerId: session.customerId,
      platform: session.platform,
      title: session.title,
      createdAt: session.createdAt,
    }).catch((e) => console.error("[supabase] session upsert failed:", e?.message || e));
  }

  return session;
}

function ensureSession(sessionIdRaw, customerId, platform) {
  const platformNorm = safeString(platform || "tiktok").toLowerCase();
  const incomingId = normalizeSessionUuid(sessionIdRaw || "");

  if (incomingId && sessions.has(incomingId)) return sessions.get(incomingId);

  if (incomingId && isUuid(incomingId)) {
    // accept client-provided uuid session id
    const s = {
      id: incomingId,
      customerId: safeShopifyId(customerId),
      platform: platformNorm,
      title: "Mina session",
      createdAt: new Date().toISOString(),
    };
    sessions.set(incomingId, s);
    if (sbEnabled()) {
      void sbUpsertAppSession({
        id: incomingId,
        customerId: s.customerId,
        platform: s.platform,
        title: s.title,
        createdAt: s.createdAt,
      }).catch((e) => console.error("[supabase] session upsert failed:", e?.message || e));
    }
    return s;
  }

  return createSession({ customerId, platform: platformNorm, title: "Mina session" });
}

// ======================================================
// Routes
// ======================================================

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API (Supabase)",
    time: new Date().toISOString(),
    supabase: sbEnabled(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API (Supabase)",
    time: new Date().toISOString(),
    supabase: sbEnabled(),
  });
});

// public stats → total users on login screen
app.get("/public/stats/total-users", async (_req, res) => {
  const requestId = `stats_${Date.now()}`;

  if (!sbEnabled()) {
    return res.json({
      ok: false,
      requestId,
      source: "no_supabase",
      totalUsers: null,
    });
  }

  try {
    const dbCount = await sbCountCustomers();
    const total = (dbCount ?? 0) + MINA_BASELINE_USERS;
    return res.json({
      ok: true,
      requestId,
      source: "supabase",
      totalUsers: total,
    });
  } catch (err) {
    console.error("[mina] total-users supabase error", err);
    return res.json({
      ok: false,
      requestId,
      source: "sb_error",
      totalUsers: null,
    });
  }
});

// Billing settings (stored in customers.meta.autoTopup)
app.get("/billing/settings", async (req, res) => {
  try {
    const customerIdRaw = req.query.customerId;
    if (!customerIdRaw) return res.status(400).json({ error: "Missing customerId" });

    const customerId = String(customerIdRaw);

    if (!sbEnabled()) {
      return res.json({ customerId, enabled: false, monthlyLimitPacks: 0, source: "no-db" });
    }

    const setting = await sbGetBillingSettings(customerId);
    return res.json({ customerId, ...setting });
  } catch (err) {
    console.error("GET /billing/settings error", err);
    res.status(500).json({ error: "Failed to load billing settings" });
  }
});

app.post("/billing/settings", async (req, res) => {
  try {
    const { customerId, enabled, monthlyLimitPacks } = req.body || {};
    if (!customerId) return res.status(400).json({ error: "customerId is required" });
    if (!sbEnabled()) return res.status(500).json({ error: "Supabase not configured" });

    const saved = await sbSetBillingSettings(
      String(customerId),
      Boolean(enabled),
      Number(monthlyLimitPacks || 0)
    );

    res.json({
      customerId: String(customerId),
      enabled: saved.enabled,
      monthlyLimitPacks: saved.monthlyLimitPacks,
    });
  } catch (err) {
    console.error("POST /billing/settings error", err);
    res.status(500).json({ error: "Failed to save billing settings" });
  }
});

// Credits: balance
app.get("/credits/balance", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const customerIdRaw = req.query.customerId || "anonymous";
    const customerId = String(customerIdRaw);

    if (!sbEnabled()) {
      return res.json({
        ok: false,
        requestId,
        customerId,
        balance: null,
        historyLength: null,
        meta: { imageCost: IMAGE_CREDITS_COST, motionCost: MOTION_CREDITS_COST },
        message: "Supabase not configured",
      });
    }

    const rec = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    res.json({
      ok: true,
      requestId,
      customerId,
      balance: rec.balance,
      historyLength: rec.historyLength,
      meta: { imageCost: IMAGE_CREDITS_COST, motionCost: MOTION_CREDITS_COST },
      source: rec.source,
    });
  } catch (err) {
    console.error("Error in /credits/balance:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits balance.",
      requestId,
    });
  }
});

// Credits: add (manual / via webhook)
app.post("/credits/add", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined ? String(body.customerId) : "anonymous";
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
    const reason = safeString(body.reason || "manual-topup");
    const source = safeString(body.source || "api");

    if (!amount || !Number.isFinite(amount)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AMOUNT",
        message: "amount is required and must be a number.",
        requestId,
      });
    }

    if (!sbEnabled()) {
      return res.status(500).json({ ok: false, error: "NO_DB", message: "Supabase not configured", requestId });
    }

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

    res.json({
      ok: true,
      requestId,
      customerId,
      newBalance: out.balance,
      source: out.source,
    });
  } catch (err) {
    console.error("Error in /credits/add:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits add.",
      requestId,
    });
  }
});

// Admin API (summary & customers/adjust)
app.get("/admin/summary", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const totalCustomers = await sbCountCustomers();

    // Sum credits + autoTopup enabled (best-effort; limited scan)
    let totalCredits = 0;
    let autoTopupOn = 0;

    const pageSize = 1000;
    let from = 0;
    const hardCap = 20000; // safety cap
    while (from < hardCap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabaseAdmin
        .from("customers")
        .select("credits,meta")
        .range(from, to);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        totalCredits += Number(row.credits || 0);
        const enabled = row?.meta?.autoTopup?.enabled;
        if (enabled === true) autoTopupOn += 1;
      }

      if (data.length < pageSize) break;
      from += pageSize;
    }

    res.json({
      totalCustomers: totalCustomers ?? 0,
      totalCredits,
      autoTopupOn,
      source: "supabase",
      note: totalCustomers > 20000 ? "summary capped to 20k customers for sum/autoTopup count" : undefined,
    });
  } catch (err) {
    console.error("GET /admin/summary error", err);
    res.status(500).json({ error: "Failed to load admin summary" });
  }
});

app.get("/admin/customers", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const rows = await sbListCustomers(500);
    res.json({ customers: rows, source: "supabase" });
  } catch (err) {
    console.error("GET /admin/customers error", err);
    res.status(500).json({ error: "Failed to load admin customers" });
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

    res.json({
      customerId: String(customerId),
      balance: out.balance,
      source: out.source,
    });
  } catch (err) {
    console.error("POST /admin/credits/adjust error", err);
    res.status(500).json({ error: "Failed to adjust credits" });
  }
});

// =======================
// Session start (Supabase-only)
// =======================
app.post("/sessions/start", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const title = safeString(body.title || "Mina session");

    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    // Ensure customer exists (and welcome credits if configured)
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    const session = createSession({ customerId, platform, title });

    // For audit/ops correlation
    persistSessionHash(req, session.id || requestId, req.user?.userId, req.user?.email);

    res.json({
      ok: true,
      requestId,
      session,
    });
  } catch (err) {
    console.error("Error in /sessions/start:", err);
    res.status(500).json({
      ok: false,
      error: "SESSION_ERROR",
      message: err?.message || "Unexpected error during session start.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Editorial (image) — Supabase-only credits
// =======================
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  // keep for catch/meta
  let customerId = "anonymous";
  let platform = "tiktok";
  let stylePresetKey = "";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const productImageUrl = safeString(body.productImageUrl);
    const logoImageUrl = safeString(body.logoImageUrl || "");
    const styleImageUrls = Array.isArray(body.styleImageUrls) ? body.styleImageUrls : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!productImageUrl && !brief) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "vision",
        input_type: "text",
        output_type: "image",
        model: SEADREAM_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: { reason: "missing_input" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide at least productImageUrl or brief so Mina knows what to create.",
        requestId,
      });
    }

    // Ensure customer exists (welcome credits etc.)
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    // Credits check (Supabase)
    const imageCost = IMAGE_CREDITS_COST;
    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    if ((creditsInfo.balance ?? 0) < imageCost) {
      auditAiEvent(req, "ai_error", 402, {
        request_id: requestId,
        step: "vision",
        input_type: productImageUrl ? "image" : "text",
        output_type: "image",
        model: SEADREAM_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: {
          reason: "insufficient_credits",
          required: imageCost,
          balance: creditsInfo.balance ?? 0,
        },
      });
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${imageCost}, you have ${creditsInfo.balance ?? 0}.`,
        requiredCredits: imageCost,
        currentCredits: creditsInfo.balance ?? 0,
        requestId,
      });
    }

    // Session
    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;
    persistSessionHash(req, sessionId || requestId, req.user?.userId, req.user?.email);

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, null);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const promptResult = await buildEditorialPrompt({
      productImageUrl,
      logoImageUrl,
      styleImageUrls,
      brief,
      tone,
      platform,
      mode: "image",
      styleHistory,
      styleProfile: finalStyleProfile,
      presetHeroImageUrls: preset?.heroImageUrls || [],
    });

    const prompt = promptResult.prompt;
    const imageTexts = promptResult.imageTexts || [];
    const userMessage = promptResult.userMessage || "";

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      session_id: sessionId,
      customer_id: customerId,
      model: SEADREAM_MODEL,
      provider: "replicate",
      input_chars: (prompt || "").length,
      stylePresetKey,
      minaVisionEnabled,
      generation_id: generationId,
    });

    // Aspect ratio
    const requestedAspect = safeString(body.aspectRatio || "");
    const validAspects = new Set(["9:16", "3:4", "2:3", "1:1", "3:2", "16:9"]);
    let aspectRatio = "2:3";

    if (validAspects.has(requestedAspect)) {
      aspectRatio = requestedAspect;
    } else {
      if (platform === "tiktok" || platform.includes("reel")) aspectRatio = "9:16";
      else if (platform === "instagram-post") aspectRatio = "3:4";
      else if (platform === "print") aspectRatio = "2:3";
      else if (platform === "square") aspectRatio = "1:1";
      else if (platform.includes("youtube")) aspectRatio = "16:9";
    }

    const input = {
      prompt,
      image_input: productImageUrl ? [productImageUrl, ...styleImageUrls] : styleImageUrls,
      max_images: body.maxImages || 1,
      size: "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run(SEADREAM_MODEL, { input });

    let imageUrls = [];
    if (Array.isArray(output)) {
      imageUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") return item.url || item.image || null;
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      imageUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") imageUrls = [output.url];
      else if (Array.isArray(output.output)) imageUrls = output.output.filter((v) => typeof v === "string");
    }

    const imageUrl = imageUrls[0] || null;
    if (!imageUrl) {
      throw new Error("Image generation returned no URL.");
    }

    // Spend credits AFTER successful generation (Supabase)
    const spend = await sbAdjustCredits({
      customerId,
      delta: -imageCost,
      reason: "image-generate",
      source: "api",
      refType: "generation",
      refId: generationId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    const latencyMs = Date.now() - startedAt;
    const outputChars = imageUrls.join(",").length;

    const generationRecord = {
      id: generationId,
      type: "image",
      sessionId,
      customerId,
      platform,
      prompt: prompt || "",
      outputUrl: imageUrl,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        productImageUrl,
        logoImageUrl,
        styleImageUrls,
        aspectRatio,
        imageTexts,
        userMessage,
        requestId,
        latencyMs,
        inputChars: (prompt || "").length,
        outputChars,
        model: SEADREAM_MODEL,
        provider: "replicate",
        status: "succeeded",
        userId: req.user?.userId,
        email: req.user?.email,
      },
    };

    // Persist business generation row (Supabase table)
    void sbUpsertGenerationBusiness(generationRecord).catch((e) =>
      console.error("[supabase] generation upsert failed:", e?.message || e)
    );

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      r2_url: imageUrl,
      session_id: sessionId,
      customer_id: customerId,
      model: SEADREAM_MODEL,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId,
      userId: req.user?.userId,
      email: req.user?.email,
      model: SEADREAM_MODEL,
      provider: "replicate",
      status: "succeeded",
      inputChars: (prompt || "").length,
      outputChars,
      latencyMs,
      meta: {
        requestId,
        step: "vision",
        input_type: productImageUrl ? "image" : "text",
        output_type: "image",
        r2_url: imageUrl,
        customerId,
        platform,
        aspectRatio,
        minaVisionEnabled,
        stylePresetKey,
      },
    });

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt,
      imageUrl,
      imageUrls,
      rawOutput: output,
      payload: body,
      generationId,
      sessionId,
      credits: {
        balance: spend.balance,
        cost: imageCost,
      },
      gpt: {
        usedFallback: promptResult.usedFallback,
        error: promptResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
        imageTexts,
        userMessage,
      },
    });
  } catch (err) {
    console.error("Error in /editorial/generate:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "vision",
      input_type: safeString(req.body?.productImageUrl) ? "image" : "text",
      output_type: "image",
      model: SEADREAM_MODEL,
      provider: "replicate",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(safeString(req.body?.sessionId)) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: SEADREAM_MODEL,
      provider: "replicate",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "vision",
        input_type: safeString(req.body?.productImageUrl) ? "image" : "text",
        output_type: "image",
        customerId,
        platform: safeString(req.body?.platform || "") || null,
        stylePresetKey: safeString(req.body?.stylePresetKey || "") || null,
        error: err?.message,
      },
    });

    res.status(500).json({
      ok: false,
      error: "EDITORIAL_GENERATION_ERROR",
      message: err?.message || "Unexpected error during image generation.",
      requestId,
    });
  }
});

// =======================
// ---- Motion suggestion (textarea) — Supabase-only likes read
// =======================
app.post("/motion/suggest", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  let customerId = "anonymous";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const referenceImageUrl = safeString(body.referenceImageUrl);

    if (!referenceImageUrl) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        model: "gpt-4.1-mini",
        provider: "openai",
        generation_id: generationId,
        detail: { reason: "missing_reference_image" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_REFERENCE_IMAGE",
        message: "referenceImageUrl is required to suggest motion.",
        requestId,
      });
    }

    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;
    const userDraft = safeString(body.text || body.motionBrief || body.motionDescription || "");
    
    // Optional extra context images (if your frontend sends them)
    const productImageUrl = safeString(body.productImageUrl || "");
    const logoImageUrl = safeString(body.logoImageUrl || "");
    const styleImageUrls = Array.isArray(body.styleImageUrls) ? body.styleImageUrls : [];
    
    const extraImageUrls = [
      productImageUrl,
      logoImageUrl,
      ...styleImageUrls,
    ].map((u) => safeString(u, "")).filter((u) => isHttpUrl(u));

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    // Ensure customer exists
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    persistSessionHash(req, body.sessionId || customerId || requestId, req.user?.userId, req.user?.email);

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      session_id: normalizeSessionUuid(body.sessionId) || null,
      customer_id: customerId,
      model: "gpt-4.1-mini",
      provider: "openai",
      input_chars: JSON.stringify(body || {}).length,
      generation_id: generationId,
    });

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      finalStyleProfile = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile).profile;
    } else {
      styleHistory = [];
      finalStyleProfile = mergePresetAndUserProfile(preset ? preset.profile : null, null).profile;
    }

    const suggestionRes = await buildMotionSuggestion({
    referenceImageUrl,
    tone,
    platform,
    styleHistory,
    styleProfile: finalStyleProfile,
  
    // ✅ NEW
    userDraft,
    extraImageUrls,
    presetHeroImageUrls: preset?.heroImageUrls || [],
    });


    const latencyMs = Date.now() - startedAt;

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      session_id: normalizeSessionUuid(body.sessionId) || null,
      customer_id: customerId,
      model: "gpt-4.1-mini",
      provider: "openai",
      latency_ms: latencyMs,
      input_chars: JSON.stringify(body || {}).length,
      output_chars: (suggestionRes.text || "").length,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(body.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: "gpt-4.1-mini",
      provider: "openai",
      status: "succeeded",
      inputChars: JSON.stringify(body || {}).length,
      outputChars: (suggestionRes.text || "").length,
      latencyMs,
      meta: {
        requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        customerId,
        sessionId: normalizeSessionUuid(body.sessionId) || null,
      },
    });

    res.json({
      ok: true,
      requestId,
      suggestion: suggestionRes.text,
      gpt: {
        usedFallback: suggestionRes.usedFallback,
        error: suggestionRes.gptError,
      },
    });
  } catch (err) {
    console.error("Error in /motion/suggest:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      model: "gpt-4.1-mini",
      provider: "openai",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(req.body?.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: "gpt-4.1-mini",
      provider: "openai",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        customerId,
        error: err?.message,
      },
    });

    res.status(500).json({
      ok: false,
      error: "MOTION_SUGGESTION_ERROR",
      message: err?.message || "Unexpected error during motion suggestion.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Motion (video) — Supabase-only credits
// =======================
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  let customerId = "anonymous";
  let platform = "tiktok";
  let stylePresetKey = "";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription);
    const tone = safeString(body.tone);
    platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!lastImageUrl) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        model: KLING_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: { reason: "missing_last_image" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        model: KLING_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: { reason: "missing_motion_description" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    // Ensure customer exists
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    // Credits check (Supabase)
    const motionCost = MOTION_CREDITS_COST;
    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    if ((creditsInfo.balance ?? 0) < motionCost) {
      auditAiEvent(req, "ai_error", 402, {
        request_id: requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        model: KLING_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: {
          reason: "insufficient_credits",
          required: motionCost,
          balance: creditsInfo.balance ?? 0,
        },
      });
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${motionCost}, you have ${creditsInfo.balance ?? 0}.`,
        requiredCredits: motionCost,
        currentCredits: creditsInfo.balance ?? 0,
        requestId,
      });
    }

    // Session
    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;
    persistSessionHash(req, sessionId || requestId, req.user?.userId, req.user?.email);

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, null);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const motionResult = await buildMotionPrompt({
      motionBrief: motionDescription,
      tone,
      platform,
      lastImageUrl,
      styleHistory,
      styleProfile: finalStyleProfile,
    });

    const prompt = motionResult.prompt;
    let durationSeconds = Number(body.durationSeconds || 5);
    if (durationSeconds > 10) durationSeconds = 10;
    if (durationSeconds < 1) durationSeconds = 1;

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "motion",
      input_type: "text",
      output_type: "video",
      session_id: sessionId,
      customer_id: customerId,
      model: KLING_MODEL,
      provider: "replicate",
      input_chars: (prompt || "").length,
      stylePresetKey,
      minaVisionEnabled,
      generation_id: generationId,
    });

    const input = {
      mode: "standard",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: "",
    };

    const output = await replicate.run(KLING_MODEL, { input });

    let videoUrl = null;
    if (typeof output === "string") {
      videoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") videoUrl = first;
      else if (first && typeof first === "object") {
        if (typeof first.url === "string") videoUrl = first.url;
        else if (typeof first.video === "string") videoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") videoUrl = output.url;
      else if (typeof output.video === "string") videoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") videoUrl = output.output[0];
      }
    }

    if (!videoUrl) {
      throw new Error("Motion generation returned no URL.");
    }

    // Spend credits AFTER successful generation (Supabase)
    const spend = await sbAdjustCredits({
      customerId,
      delta: -motionCost,
      reason: "motion-generate",
      source: "api",
      refType: "generation",
      refId: generationId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    const latencyMs = Date.now() - startedAt;
    const outputChars = (videoUrl || "").length;

    const generationRecord = {
      id: generationId,
      type: "motion",
      sessionId,
      customerId,
      platform,
      prompt: motionDescription || "",
      outputUrl: videoUrl,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        lastImageUrl,
        durationSeconds,
        requestId,
        latencyMs,
        inputChars: (prompt || "").length,
        outputChars,
        model: KLING_MODEL,
        provider: "replicate",
        status: "succeeded",
        userId: req.user?.userId,
        email: req.user?.email,
      },
    };

    void sbUpsertGenerationBusiness(generationRecord).catch((e) =>
      console.error("[supabase] generation upsert failed:", e?.message || e)
    );

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "motion",
      input_type: "text",
      output_type: "video",
      r2_url: videoUrl,
      session_id: sessionId,
      customer_id: customerId,
      model: KLING_MODEL,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId,
      userId: req.user?.userId,
      email: req.user?.email,
      model: KLING_MODEL,
      provider: "replicate",
      status: "succeeded",
      inputChars: (prompt || "").length,
      outputChars,
      latencyMs,
      meta: {
        requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        r2_url: videoUrl,
        customerId,
        platform,
        durationSeconds,
        minaVisionEnabled,
        stylePresetKey,
      },
    });

    res.json({
      ok: true,
      message: "Mina Motion video generated via Kling.",
      requestId,
      prompt,
      videoUrl,
      rawOutput: output,
      generationId,
      sessionId,
      payload: {
        lastImageUrl,
        motionDescription,
        tone,
        platform,
        durationSeconds,
        customerId,
        stylePresetKey,
      },
      credits: {
        balance: spend.balance,
        cost: motionCost,
      },
      gpt: {
        usedFallback: motionResult.usedFallback,
        error: motionResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
      },
    });
  } catch (err) {
    console.error("Error in /motion/generate:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "motion",
      input_type: "text",
      output_type: "video",
      model: KLING_MODEL,
      provider: "replicate",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(req.body?.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: KLING_MODEL,
      provider: "replicate",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        customerId,
        error: err?.message,
      },
    });

    res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});

// =======================
// ---- Feedback / likes (image + motion) — Supabase-only persistence
// =======================
app.post("/feedback/like", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    const resultType = safeString(body.resultType || "image");
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const prompt = safeString(body.prompt);
    const comment = safeString(body.comment);
    const imageUrl = safeString(body.imageUrl || "");
    const videoUrl = safeString(body.videoUrl || "");
    const sessionId = normalizeSessionUuid(safeString(body.sessionId || "")) || null;
    const generationId = safeString(body.generationId || "") || null;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_PROMPT",
        message: "Prompt is required to store like feedback.",
        requestId,
      });
    }

    // Ensure customer exists
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    // Update cache (optional)
    rememberLike(customerId, {
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
    });

    // Persist to Supabase feedback table
    const feedbackId = crypto.randomUUID(); // feedback.id is uuid
    const feedback = {
      id: feedbackId,
      sessionId,
      generationId,
      customerId,
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      createdAt: new Date().toISOString(),
    };

    await sbUpsertFeedbackBusiness(feedback);

    // total likes (best-effort)
    let totalLikes = null;
    try {
      const likes = await sbGetLikesForCustomer(customerId, MAX_LIKES_PER_CUSTOMER);
      totalLikes = likes.length;
    } catch (_) {}

    res.json({
      ok: true,
      message: "Like stored for Mina Vision Intelligence.",
      requestId,
      payload: {
        customerId,
        resultType,
        platform,
        sessionId,
        generationId,
      },
      totals: {
        likesForCustomer: totalLikes,
      },
    });
  } catch (err) {
    console.error("Error in /feedback/like:", err);
    res.status(500).json({
      ok: false,
      error: "FEEDBACK_ERROR",
      message: err?.message || "Unexpected error while saving feedback.",
      requestId,
    });
  }
});

// =======================
// Shopify credits integration — Supabase-only
// =======================
const CREDIT_SKUS = {
  "MINA-50": 50,
};

app.post("/api/credits/shopify-order", async (req, res) => {
  try {
    const secretFromQuery = req.query.secret;
    if (!secretFromQuery || secretFromQuery !== process.env.SHOPIFY_ORDER_WEBHOOK_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Invalid webhook secret",
      });
    }

    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
      });
    }

    const order = req.body;
    if (!order) {
      return res.status(400).json({ ok: false, error: "NO_ORDER", message: "Missing order payload" });
    }

    if (!order.customer || !order.customer.id) {
      return res.status(400).json({ ok: false, error: "NO_CUSTOMER", message: "Order has no customer.id" });
    }

    const customerId = String(order.customer.id);

    let creditsToAdd = 0;
    const items = order.line_items || [];

    for (const item of items) {
      const sku = item.sku;
      const quantity = item.quantity || 1;
      if (sku && CREDIT_SKUS[sku]) creditsToAdd += CREDIT_SKUS[sku] * quantity;
    }

    if (creditsToAdd <= 0) {
      console.log("[SHOPIFY_WEBHOOK] Order has no credit SKUs. Doing nothing.");
      return res.json({ ok: true, message: "No credit products found in order.", added: 0 });
    }

    // Ensure customer exists + add credits
    await sbEnsureCustomer({ customerId, userId: null, email: order?.email || null });

    const out = await sbAdjustCredits({
      customerId,
      delta: creditsToAdd,
      reason: `shopify-order:${order.id || "unknown"}`,
      source: "shopify",
      refType: "shopify-order",
      refId: order.id ? String(order.id) : null,
      reqUserId: null,
      reqEmail: order?.email || null,
    });

    return res.json({
      ok: true,
      message: "Credits added from Shopify order.",
      customerId,
      added: creditsToAdd,
      balance: out.balance,
      source: out.source,
    });
  } catch (err) {
    console.error("Error in /api/credits/shopify-order:", err);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Failed to process Shopify order webhook",
    });
  }
});

// =======================
// Debug credits endpoint — Supabase-only
// =======================
app.get("/api/credits/:customerId", async (req, res) => {
  try {
    const customerId = String(req.params.customerId || "anonymous");

    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
      });
    }

    const history = await sbGetCustomerHistory(customerId);
    return res.json({
      ok: true,
      customerId,
      balance: history?.credits?.balance ?? 0,
      history: history?.credits?.history ?? [],
    });
  } catch (err) {
    console.error("GET /api/credits/:customerId error", err);
    return res.status(500).json({ ok: false, error: "CREDITS_DEBUG_ERROR", message: err?.message || "Failed" });
  }
});

// =======================
// History endpoints — Supabase-only
// =======================
app.get("/history/customer/:customerId", async (req, res) => {
  try {
    const customerId = String(req.params.customerId || "anonymous");

    if (!sbEnabled()) {
      return res.status(500).json({ ok: false, error: "NO_DB", message: "Supabase not configured" });
    }

    const history = await sbGetCustomerHistory(customerId);
    return res.json({
      ok: true,
      ...history,
    });
  } catch (err) {
    console.error("Error in /history/customer/:customerId", err);
    return res.status(500).json({
      ok: false,
      error: "HISTORY_ERROR",
      message: err?.message || "Unexpected error while loading history.",
    });
  }
});

app.get("/history/admin/overview", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) {
      return res.status(500).json({ ok: false, error: "NO_DB", message: "Supabase not configured" });
    }

    const data = await sbGetAdminOverview();
    const generations = data?.generations || [];
    const feedbacks = data?.feedbacks || [];

    return res.json({
      ok: true,
      totals: {
        generations: generations.length,
        feedbacks: feedbacks.length,
      },
      generations,
      feedbacks,
    });
  } catch (err) {
    console.error("Error in /history/admin/overview", err);
    return res.status(500).json({
      ok: false,
      error: "ADMIN_HISTORY_ERROR",
      message: err?.message || "Unexpected error while loading admin overview.",
    });
  }
});

// ============================
// Store remote generation (Replicate/OpenAI result URL -> R2) — unchanged
// ============================
app.post("/store-remote-generation", async (req, res) => {
  try {
    const { url, urls, customerId, folder } = req.body || {};

    const remoteUrl =
      (typeof url === "string" && url) ||
      (Array.isArray(urls) && typeof urls[0] === "string" ? urls[0] : "");

    if (!remoteUrl) return res.status(400).json({ ok: false, error: "NO_URL" });

    const cid = (customerId || "anon").toString();
    const fold = (folder || "generations").toString();

    const resp = await fetch(remoteUrl);
    if (!resp.ok) {
      return res.status(400).json({
        ok: false,
        error: "REMOTE_FETCH_FAILED",
        status: resp.status,
      });
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const uuid = crypto.randomUUID();

    const ext =
      contentType.includes("png")
        ? "png"
        : contentType.includes("jpeg")
          ? "jpg"
          : contentType.includes("webp")
            ? "webp"
            : contentType.includes("gif")
              ? "gif"
              : contentType.includes("mp4")
                ? "mp4"
                : "";

    const key = `${fold}/${cid}/${Date.now()}-${uuid}${ext ? `.${ext}` : ""}`;

    const storedUrl = await r2PutAndSignGet({
      key,
      body: buf,
      contentType,
    });

    return res.json({
      ok: true,
      key,
      url: storedUrl,
      contentType,
      size: buf.length,
      sourceUrl: remoteUrl,
    });
  } catch (err) {
    console.error("POST /store-remote-generation error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED" });
  }
});

// =========================
// R2 Signed Uploads (SIGNED URL ALWAYS) — unchanged
// =========================
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

app.get("/debug/r2", (_req, res) => {
  const missing = [];
  if (!process.env.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
  if (!process.env.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!process.env.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!process.env.R2_BUCKET) missing.push("R2_BUCKET");

  res.json({
    ok: missing.length === 0,
    missing,
    hasEndpointOverride: !!process.env.R2_ENDPOINT,
    nodeVersion: process.version,
  });
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

    const signedUrl = await r2PutAndSignGet({ key, body: buffer, contentType });

    return res.json({
      ok: true,
      key,
      url: signedUrl,
      contentType,
      bytes: buffer.length,
    });
  } catch (err) {
    console.error("POST /api/r2/upload-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "UPLOAD_SIGNED_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(400).json({
        ok: false,
        error: "REMOTE_FETCH_FAILED",
        status: resp.status,
      });
    }

    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const uuid = crypto.randomUUID();
    const extGuess = guessExtFromContentType(contentType);

    const key = `${folder}/${cid}/${Date.now()}-${uuid}${extGuess ? `.${extGuess}` : ""}`;

    const signedUrl = await r2PutAndSignGet({ key, body: buf, contentType });

    return res.json({
      ok: true,
      key,
      url: signedUrl,
      contentType,
      size: buf.length,
      sourceUrl: url,
    });
  } catch (err) {
    console.error("POST /api/r2/store-remote-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "STORE_REMOTE_SIGNED_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});

