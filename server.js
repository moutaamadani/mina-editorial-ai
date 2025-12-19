// Hero Part 1: Mina Editorial AI API brain (Supabase-first, no Prisma)
// Part 1.1: Express wiring, storage helpers, and AI clients live here.
// Part 1.1.1: Read these numbered crumbs to skim responsibilities without
// opening every function.
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
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";
import {
  megaEnsureCustomer,
  megaWriteSessionEvent,
  megaWriteGenerationEvent,
  megaWriteFeedbackEvent,
  megaWriteCreditTxnEvent,
  megaParityCounts,
} from "./mega-db.js";

import { parseDataUrl } from "./r2.js";

import { logAdminAction, upsertSessionRow } from "./supabase.js";
import { requireAdmin } from "./auth.js";
import { createMmaController } from "./server/mma/mma-controller.js";
import createMmaRouter from "./server/mma/mma-router.js";

const app = express();
const PORT = process.env.PORT || 3000;
// SubPart: We show total users with a friendly offset so numbers look nicer.
const MINA_BASELINE_USERS = 3651; // offset we add on top of DB users

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
// ✅ Put it RIGHT HERE (before supabase init / routes)
console.log("ENV CHECK", {
  SUPABASE_URL_set: !!process.env.SUPABASE_URL,
  SUPABASE_URL_len: process.env.SUPABASE_URL?.length ?? 0,
  SUPABASE_SERVICE_ROLE_KEY_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY_len: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
});
// Part 1.2: Supabase (service role) — MEGA-first persistence
// Part 1.2.1: Tables (MEGA-only)
//   - mega_customers
//   - mega_generations
//   - mega_admin
// Part 1.2.2: Legacy tables are no longer written, so new writes stay clean.
// ======================================================
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Part: Supabase service client (used for all database writes)
// SubPart: we only construct it when env vars are present so local dev can still boot.
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// SubPart: quick boolean to avoid repeating null checks everywhere.
function sbEnabled() {
  return !!supabaseAdmin;
}

// SubPart: consistent timestamp helper for DB writes and logs.
function nowIso() {
  return new Date().toISOString();
}

// ======================================================
// Credits expiry policy (rolling expiry; latest wins)
// - If credits are granted, expiry = max(current_expiry, grantedAt + N days)
// - N defaults to 30 if env is missing/invalid
// ======================================================
const DEFAULT_CREDITS_EXPIRE_DAYS = (() => {
  const raw = Number(process.env.CREDITS_EXPIRE_DAYS);
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

// SubPart: guardrail to avoid writing undefined/null into the DB.
function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

// SubPart: normalize Shopify IDs so anonymous users are clearly labeled.
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

function resolvePassId({ existingPassId = null, incomingPassId = null, shopifyId = null, userId = null, email = null }) {
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

// SubPart: simple UUID format check to keep session ids tidy.
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

  const { error: upErr } = await supabaseAdmin
    .from("mega_customers")
    .update(updates)
    .eq("mg_pass_id", passId);

  if (upErr) throw upErr;

  return next;
}

// Hero Part 2: File uploads to Cloudflare R2 (S3 compatible)
// Part 2.1: Build a tiny R2 client and a Multer uploader so API routes can stash files.
// Part 2.1.1: Safe naming helpers prevent weird characters from breaking object keys.
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
// Hero Part 3: GPT input/output summaries
// Part 3.1: Helpers keep a small, friendly snapshot of prompts/responses for auditing.
// Part 3.1.1: Truncation avoids storing giant payloads while still telling the story.
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

// Part 2.2: R2 PUBLIC (non-expiring) helpers
// Part 2.2.1: Converts signed temp URLs into permanent, shareable URLs when possible.
// Part 2.2.2: Guards against missing public domain config so uploads never break later.
// =======================
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // e.g. https://assets.faltastudio.com

if (process.env.NODE_ENV === "production" && !R2_PUBLIC_BASE_URL) {
  throw new Error(
    "R2_PUBLIC_BASE_URL is REQUIRED in production so asset URLs are permanent (non-expiring)."
  );
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

  // Fallback works only if your bucket is publicly accessible on the default endpoint
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return "";
}

function hasAwsSignatureParams(urlObj) {
  for (const [k] of urlObj.searchParams.entries()) {
    const key = String(k || "").toLowerCase();
    if (key.startsWith("x-amz-") || key.includes("signature") || key.includes("expires")) return true;
  }
  return false;
}

// Extract the object key from R2 URLs (bucket subdomain or path-style)
function extractR2KeyFromUrl(u) {
  try {
    const url = new URL(String(u));
    const host = url.hostname.toLowerCase();
    let path = url.pathname || "";
    if (path.startsWith("/")) path = path.slice(1);

    // If path style: /<bucket>/<key>
    if (R2_BUCKET) {
      const first = path.split("/")[0];
      if (first === R2_BUCKET) {
        path = path.split("/").slice(1).join("/");
      }
    }

    // If bucket subdomain: <bucket>.<account>.r2.cloudflarestorage.com/<key>
    // then pathname is already the key
    if (host.endsWith("r2.cloudflarestorage.com")) {
      return path || "";
    }

    // If already on custom public domain: /<key>
    if (R2_PUBLIC_BASE_URL) {
      const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
      if (host === baseHost) return path || "";
    }

    return "";
  } catch {
    return "";
  }
}

// ✅ True only if URL is already PERMANENT public (your custom domain, and not signed)
function isPermanentPublicAssetUrl(u) {
  try {
    const url = new URL(String(u));
    if (!R2_PUBLIC_BASE_URL) return false;
    const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
    if (url.hostname.toLowerCase() !== baseHost) return false;
    if (hasAwsSignatureParams(url)) return false;
    return true;
  } catch {
    return false;
  }
}

// ✅ Convert signed R2 URLs -> permanent public URL when possible
function toPermanentPublicAssetUrl(u) {
  try {
    if (!R2_PUBLIC_BASE_URL) return "";
    const url = new URL(String(u));

    // Already permanent
    if (isPermanentPublicAssetUrl(u)) return String(u);

    // If it's R2 but signed, build the public URL from the key
    const host = url.hostname.toLowerCase();
    if (host.endsWith("r2.cloudflarestorage.com") || hasAwsSignatureParams(url)) {
      const key = extractR2KeyFromUrl(u);
      if (!key) return "";
      return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;
    }

    return "";
  } catch {
    return "";
  }
}

async function r2PutPublic({ key, body, contentType }) {
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
  if (!publicUrl) {
    throw new Error(
      "Missing R2_PUBLIC_BASE_URL. Set it to your public R2 domain so URLs never expire."
    );
  }

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

function getRequestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    route: req.path,
    method: req.method,
  };
}
// Hero Part 4: Runtime Config (stored in Supabase, applied live)
// Part 4.1: Baseline GPT prompts act as defaults the DB can override.
// Part 4.2: Model + credit costs can be tweaked without redeploying.
// ======================================================

// ✅ Base GPT system prompts (your current hardcoded text) — used as DEFAULTS
const BASE_GPT_SYSTEM_EDITORIAL =
  "You are Mina, an editorial art director for fashion & beauty." +
  " You will see one product image, an optional logo, and up to several style reference images." +
  " You write ONE clear prompt for a generative image model." +
  " Describe the product and place the logo if it is added, in environment, lighting, camera, mood, and style inspired from the inspiration and style chosen." +
  " Do NOT include line breaks, lists, or bullet points only the prompt directly. One paragraph max." +
  " After the prompt, return JSON with two fields: 'imageTexts' (array of captions for each image uploaded)" +
  " and 'userMessage' (this usermessage is to talk about the product, the images, the process that mina is doing to connect all the ideas together and setting camera and light and must be user friendly easy english we will animate this as mina chatting with user while he is waiting, you can also put quotes motivation self estem boosting sentences so they bond with mina and also some hold on a bit it is going too long because I want to drink my matchas slowly things AI might say to somehow explain why it is taking so much).";

const BASE_GPT_SYSTEM_MOTION_PROMPT =
  "You are Mina, an editorial motion director for fashion & beauty. " +
  "You will see a reference still frame. " +
  "You describe a SHORT looping scene motion for a generative video model. " +
  "Keep it 1–2 sentences, no line breaks, easy english and describe scene compostion and how they move";

const BASE_GPT_SYSTEM_MOTION_SUGGEST =
  "You are Mina, an editorial motion director for luxury still-life. " +
  "Given images + style preferences, propose ONE short motion idea the user will see in a textarea, easy english and describe scene compostion and how they move\n\n" +
  "Constraints:\n" +
  "- Return exactly ONE sentence, no bullet points, no quotes\n" +
  "- Max ~220 characters.\n" +
  "- Do NOT mention 'TikTok' or 'platform', just describe the motion, in easy english, and clear scene composition.\n\n" +
  "If the user already wrote a draft, improve it while keeping the same intent.";

const DEFAULT_RUNTIME_CONFIG = {
  models: {
    seadream: process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4",
    kling: process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1",
    gpt: "gpt-4.1-mini",
  },
  credits: {
    imageCost: Number(process.env.IMAGE_CREDITS_COST || 1),
    motionCost: Number(process.env.MOTION_CREDITS_COST || 5),
  },
  replicate: {
    seadream: {
      size: "4K",
      enhance_prompt: false,
      sequential_image_generation: "disabled",
    },
    kling: {
      mode: "pro",
      negative_prompt: "plastic look, waxy, overly smooth, airbrushed, texture loss, no texture, material loss, flat materials, rubbery, fake fabric, smeared details, muddy details, low detail, blurry, lowres, compression artifacts, blocky, banding, noise, grain, flicker, jitter, warping, wobble, ghosting, temporal inconsistency, lighting change, relighting, exposure change, brightness change, contrast change, gamma shift, shadows changing, highlights changing, white balance shift, color shift, saturation shift, overexposed, underexposed, crushed blacks, clipped highlights, AI artifacts",
    },
  },
  gpt: {
    editorial: {
      temperature: 0.8,
      max_tokens: 420,

      // ✅ You will SEE this text in dashboard (default = your hardcoded prompt)
      system_text: BASE_GPT_SYSTEM_EDITORIAL,

      // ✅ safe extra text appended to the user message (optional)
      user_extra: "",
    },
    motion_prompt: {
      temperature: 0.8,
      max_tokens: 280,
      system_text: BASE_GPT_SYSTEM_MOTION_PROMPT,
      user_extra: "",
    },
    motion_suggest: {
      temperature: 0.8,
      max_tokens: 260,
      system_text: BASE_GPT_SYSTEM_MOTION_SUGGEST,
      user_extra: "",
    },
  },
};

// Simple deep merge (no deps)
function deepMerge(base, override) {
  if (!override || typeof override !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };

  for (const [k, v] of Object.entries(override)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// setDeep(obj, "a.b.c", value)
function setDeep(obj, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// unsetDeep(obj, "a.b.c")  -> deletes that key from the override object
function unsetDeep(obj, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") return obj;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (cur && typeof cur === "object") delete cur[last];
  return obj;
}

// Optional: guardrails so dashboard can’t break prod easily
function normalizeRuntimeConfig(cfg) {
  const safe = deepMerge(DEFAULT_RUNTIME_CONFIG, cfg || {});

  const clamp = (n, a, b, fallback) =>
    Number.isFinite(Number(n)) ? Math.max(a, Math.min(b, Number(n))) : fallback;

  safe.credits.imageCost = clamp(
    safe.credits.imageCost,
    0,
    100,
    DEFAULT_RUNTIME_CONFIG.credits.imageCost
  );
  safe.credits.motionCost = clamp(
    safe.credits.motionCost,
    0,
    100,
    DEFAULT_RUNTIME_CONFIG.credits.motionCost
  );

  safe.gpt.editorial.temperature = clamp(
    safe.gpt.editorial.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.editorial.temperature
  );
  safe.gpt.motion_prompt.temperature = clamp(
    safe.gpt.motion_prompt.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_prompt.temperature
  );
  safe.gpt.motion_suggest.temperature = clamp(
    safe.gpt.motion_suggest.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_suggest.temperature
  );

  safe.gpt.editorial.max_tokens = clamp(
    safe.gpt.editorial.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.editorial.max_tokens
  );
  safe.gpt.motion_prompt.max_tokens = clamp(
    safe.gpt.motion_prompt.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_prompt.max_tokens
  );
  safe.gpt.motion_suggest.max_tokens = clamp(
    safe.gpt.motion_suggest.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_suggest.max_tokens
  );

  // ensure strings
  safe.gpt.editorial.system_text = safeString(
    safe.gpt.editorial.system_text,
    BASE_GPT_SYSTEM_EDITORIAL
  );
  safe.gpt.editorial.user_extra = safeString(safe.gpt.editorial.user_extra, "");

  safe.gpt.motion_prompt.system_text = safeString(
    safe.gpt.motion_prompt.system_text,
    BASE_GPT_SYSTEM_MOTION_PROMPT
  );
  safe.gpt.motion_prompt.user_extra = safeString(safe.gpt.motion_prompt.user_extra, "");

  safe.gpt.motion_suggest.system_text = safeString(
    safe.gpt.motion_suggest.system_text,
    BASE_GPT_SYSTEM_MOTION_SUGGEST
  );
  safe.gpt.motion_suggest.user_extra = safeString(safe.gpt.motion_suggest.user_extra, "");

  return safe;
}

function runtimeRowToOverride(row) {
  const o = {};
  if (!row) return o;

  if (row.value && typeof row.value === "object") return row.value;
  if (row.mg_value && typeof row.mg_value === "object") return row.mg_value;

  return o;
}


async function sbGetRuntimeOverride() {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("mega_admin")
    .select("mg_value,mg_meta,mg_updated_at")
    .eq("mg_record_type", "app_config")
    .eq("mg_id", "app_config:runtime")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    value: data.mg_value || {},
    updated_at: data.mg_updated_at || null,
    updated_by: data.mg_meta?.updated_by || null,
  };
}

async function sbSetRuntimeOverride(nextOverride, updatedBy = null) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");
  const payload = {
    mg_id: "app_config:runtime",
    mg_record_type: "app_config",
    mg_key: "runtime",
    mg_value: nextOverride || {},
    mg_meta: { updated_by: updatedBy || null },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  };
  const { error } = await supabaseAdmin
    .from("mega_admin")
    .upsert(payload, { onConflict: "mg_id" });
  if (error) throw error;
}

// In-memory cache so we don’t hit DB every request
const runtimeConfigCache = {
  effective: normalizeRuntimeConfig(null),
  override: {},
  updatedAt: null,
  fetchedAt: 0,
};

const RUNTIME_CONFIG_TTL_MS = Number(process.env.RUNTIME_CONFIG_TTL_MS || 5000);

async function getRuntimeConfig() {
  if (!sbEnabled()) return runtimeConfigCache.effective;

  const now = Date.now();
  if (now - runtimeConfigCache.fetchedAt < RUNTIME_CONFIG_TTL_MS) {
    return runtimeConfigCache.effective;
  }

  const row = await sbGetRuntimeOverride();
  const override = runtimeRowToOverride(row);
  const effective = normalizeRuntimeConfig(override);

  runtimeConfigCache.effective = effective;
  runtimeConfigCache.override = override;
  runtimeConfigCache.updatedAt = row?.updated_at || null;
  runtimeConfigCache.fetchedAt = now;


  return effective;
}

// For dashboard “what does this field do?”
const RUNTIME_CONFIG_SCHEMA = [
  { path: "models.seadream", type: "string", description: "Replicate model/version for image generation (SeaDream)." },
  { path: "models.kling", type: "string", description: "Replicate model/version for video generation (Kling)." },
  { path: "models.gpt", type: "string", description: "OpenAI model used for prompt writing & suggestion." },

  { path: "credits.imageCost", type: "number", description: "Credits spent per image generation." },
  { path: "credits.motionCost", type: "number", description: "Credits spent per motion generation." },

  { path: "replicate.seadream.size", type: "string", description: "SeaDream output size (ex: 2K)." },
  { path: "replicate.seadream.enhance_prompt", type: "boolean", description: "SeaDream enhance_prompt flag." },
  { path: "replicate.seadream.sequential_image_generation", type: "string", description: "SeaDream sequential generation mode." },

  { path: "replicate.kling.mode", type: "string", description: "Kling mode (pro, etc.)." },
  { path: "replicate.kling.negative_prompt", type: "string", description: "Kling negative prompt." },

  { path: "gpt.editorial.temperature", type: "number", description: "GPT temperature for editorial prompt writing." },
  { path: "gpt.editorial.max_tokens", type: "number", description: "GPT max_tokens for editorial prompt writing." },
  { path: "gpt.editorial.system_text", type: "string", description: "FULL system prompt for editorial (editable in admin)." },
  { path: "gpt.editorial.user_extra", type: "string", description: "Extra text appended to editorial user instructions." },

  { path: "gpt.motion_prompt.temperature", type: "number", description: "GPT temperature for motion prompt writing." },
  { path: "gpt.motion_prompt.max_tokens", type: "number", description: "GPT max_tokens for motion prompt writing." },
  { path: "gpt.motion_prompt.system_text", type: "string", description: "FULL system prompt for motion prompt (editable in admin)." },
  { path: "gpt.motion_prompt.user_extra", type: "string", description: "Extra text appended to motion prompt user instructions." },

  { path: "gpt.motion_suggest.temperature", type: "number", description: "GPT temperature for motion suggestion (textarea)." },
  { path: "gpt.motion_suggest.max_tokens", type: "number", description: "GPT max_tokens for motion suggestion (textarea)." },
  { path: "gpt.motion_suggest.system_text", type: "string", description: "FULL system prompt for motion suggest (editable in admin)." },
  { path: "gpt.motion_suggest.user_extra", type: "string", description: "Extra text appended to motion suggest user instructions." },
];


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
  void upsertSessionRow({
    userId,
    email,
    token,
    ip: req?.ip,
    userAgent: req?.get ? req.get("user-agent") : null,
  });
}

// ======================================================
// Supabase business persistence helpers
// ======================================================

async function sbInsertCreditTxn({ customerId, delta, reason, source, refType = null, refId = null }) {
  if (!supabaseAdmin) return { balance: null, passId: null };

  const rawCustomerId = safeString(customerId, "");
  const incomingPassId = rawCustomerId.startsWith("pass:") ? rawCustomerId : null;
  const derivedShopify = rawCustomerId.startsWith("pass:shopify:")
    ? rawCustomerId.slice("pass:shopify:".length)
    : null;

  const { passId, credits = 0, shopifyCustomerId } = await megaEnsureCustomer(supabaseAdmin, {
    customerId: derivedShopify || (incomingPassId ? "anonymous" : customerId),
    userId: null,
    email: null,
    legacyCredits: null,
    passId: incomingPassId,
  });

  const nextBalance = credits + Number(delta || 0);

  await megaWriteCreditTxnEvent(supabaseAdmin, {
    customerId: shopifyCustomerId || customerId,
    id: crypto.randomUUID(),
    delta,
    reason,
    source,
    refType,
    refId,
    createdAt: nowIso(),
    nextBalance,
  });

  return { balance: nextBalance, passId };
}

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
    },
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
  grantedAt = null, // optional ISO timestamp (ex: Shopify order processed_at)
}) {
  if (!supabaseAdmin) return { ok: false, balance: null, source: "no-sb", passId: null };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);

  try {
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
  } catch (e) {
    console.error("[mega] credits sync failed:", e?.message || e);
    throw e;
  }

  // Rolling expiry: any positive credit grant extends expiry to max(current, grantedAt + 30d)
  if (Number(delta || 0) > 0 && cust?.passId) {
    const grantIso = safeString(grantedAt || nowIso(), nowIso());
    const desired = addDaysToIso(grantIso, DEFAULT_CREDITS_EXPIRE_DAYS);

    // Read current expiry
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

  const payload = {
    id: sid,
    shopify_customer_id: safeShopifyId(customerId),
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    created_at: createdAt || nowIso(),
  };

  await megaWriteSessionEvent(supabaseAdmin, {
    customerId: payload.shopify_customer_id,
    sessionId: payload.id,
    platform: payload.platform,
    title: payload.title,
    createdAt: payload.created_at,
  });
}

async function sbUpsertGenerationBusiness(gen) {
  if (!supabaseAdmin) return;

  await megaWriteGenerationEvent(supabaseAdmin, {
    customerId: gen.customerId,
    userId: gen.meta?.userId || null,
    email: gen.meta?.email || null,
    generation: gen,
  });
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

  await megaWriteFeedbackEvent(supabaseAdmin, {
    customerId: fb.customerId,
    feedback: fb,
  });
}

async function sbGetLikesForCustomer(customerId, limit = 50) {
  if (!supabaseAdmin) return [];

  const { passId } = (await sbEnsureCustomer({ customerId, userId: null, email: null })) || {};
  if (!passId) return [];

  const { data, error } = await supabaseAdmin
    .from("mega_generations")
    .select("mg_result_type,mg_platform,mg_prompt,mg_comment,mg_image_url,mg_video_url,mg_created_at")
    .eq("mg_record_type", "feedback")
    .eq("mg_pass_id", passId)
    .order("mg_created_at", { ascending: true })
    .limit(Math.max(1, Math.min(200, Number(limit || 50))));

  if (error) throw error;

  return (data || []).map((r) => ({
    resultType: r.mg_result_type || "image",
    platform: r.mg_platform || "tiktok",
    prompt: r.mg_prompt || "",
    comment: r.mg_comment || "",
    imageUrl: r.mg_image_url || null,
    videoUrl: r.mg_video_url || null,
    createdAt: r.mg_created_at || nowIso(),
  }));
}

async function sbGetBillingSettings(customerId) {
  if (!supabaseAdmin) return { enabled: false, monthlyLimitPacks: 0, source: "no-db", passId: null };

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });
  const { data, error } = await supabaseAdmin
    .from("mega_customers")
    .select("mg_meta")
    .eq("mg_pass_id", cust.passId)
    .maybeSingle();

  if (error) throw error;
  const meta = data?.mg_meta || {};
  const autoTopup = meta.autoTopup || {};
  return {
    enabled: Boolean(autoTopup.enabled),
    monthlyLimitPacks: Number.isFinite(autoTopup.monthlyLimitPacks)
      ? Math.max(0, Math.floor(autoTopup.monthlyLimitPacks))
      : 0,
    source: "mega_customers.meta",
    passId: cust?.passId || null,
  };
}

async function sbSetBillingSettings(customerId, enabled, monthlyLimitPacks) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });

  const { data, error } = await supabaseAdmin
    .from("mega_customers")
    .select("mg_meta")
    .eq("mg_pass_id", cust.passId)
    .maybeSingle();

  if (error) throw error;

  const meta = data?.mg_meta || {};

  const nextMeta = {
    ...meta,
    autoTopup: {
      enabled: Boolean(enabled),
      monthlyLimitPacks: Number.isFinite(monthlyLimitPacks)
        ? Math.max(0, Math.floor(monthlyLimitPacks))
        : 0,
    },
  };

  const { error: updateErr } = await supabaseAdmin
    .from("mega_customers")
    .update({ mg_meta: nextMeta, mg_updated_at: nowIso() })
    .eq("mg_pass_id", cust.passId);

  if (updateErr) throw updateErr;

  return {
    enabled: nextMeta.autoTopup.enabled,
    monthlyLimitPacks: nextMeta.autoTopup.monthlyLimitPacks,
    passId: cust?.passId || null,
  };
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

async function sbGetAdminOverview() {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("mega_generations")
    .select("*")
    .in("mg_record_type", ["generation", "feedback"])
    .order("mg_created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  return {
    generations: (data || []).filter((r) => r.mg_record_type === "generation"),
    feedbacks: (data || []).filter((r) => r.mg_record_type === "feedback"),
  };
}

// ======================================================
// Express setup
// ======================================================
const defaultAllowlist = [
  "http://mina.faltastudio.com",
  "https://mina-app-bvpn.onrender.com",
];

const envAllowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowlist = Array.from(new Set([...defaultAllowlist, ...envAllowlist]));

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/health checks
    if (allowlist.length === 0) return cb(null, false); // IMPORTANT: don't throw -> avoids 500
    return cb(null, allowlist.includes(origin));
  },
  credentials: false, // ✅ you are using Bearer tokens, not cookies
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

  if (!headers.some((h) => h.toLowerCase() === "x-mina-pass-id")) {
    headers.push("X-Mina-Pass-Id");
  }

  res.set("Access-Control-Expose-Headers", headers.join(", "));
  next();
});

app.post("/auth/shopify-sync", (_req, res) => {
  res.json({ ok: true });
});
// ======================================================
// ✅ Shopify webhook: orders/paid → credit user + tag
// (PLACE THIS BEFORE app.use(express.json()))
// ======================================================
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

const SHOPIFY_ORDER_WEBHOOK_SECRET = process.env.SHOPIFY_ORDER_WEBHOOK_SECRET || "";
const SHOPIFY_MINA_TAG = process.env.SHOPIFY_MINA_TAG || "Mina_users"; // match your segment/tag
const SHOPIFY_WELCOME_MATCHA_VARIANT_ID = String(process.env.SHOPIFY_WELCOME_MATCHA_VARIANT_ID || "");

let CREDIT_PRODUCT_MAP = {};
try {
  CREDIT_PRODUCT_MAP = JSON.parse(process.env.CREDIT_PRODUCT_MAP || "{}");
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

// Credit rule:
// - If SKU exists in CREDIT_PRODUCT_MAP (ex {"MINA-50":50}) then add that amount
// - Also supports your matcha variant id special case
function creditsFromOrder(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  let credits = 0;

  for (const li of items) {
    const sku = String(li?.sku || "").trim();
    const variantId = li?.variant_id != null ? String(li.variant_id) : "";

    // Matcha variant → +50
    if (SHOPIFY_WELCOME_MATCHA_VARIANT_ID && variantId === SHOPIFY_WELCOME_MATCHA_VARIANT_ID) {
      credits += 50;
      continue;
    }

    // SKU map → credits (example: MINA-50 => 50)
    if (sku && Object.prototype.hasOwnProperty.call(CREDIT_PRODUCT_MAP, sku)) {
      credits += Number(CREDIT_PRODUCT_MAP[sku] || 0);
    }
  }

  return credits;
}

// ✅ orders/paid webhook (RAW body + HMAC verify)
app.post(
  "/api/credits/shopify-order",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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

      // ✅ Idempotency: don’t credit same order twice
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

      // Key in your DB
      const customerKey = shopifyCustomerId || email || "anonymous";

      const grantedAt = order?.processed_at || order?.created_at || nowIso();

      // ✅ This will ALSO ensure mega_customers row exists (via megaEnsureCustomer inside sbAdjustCredits)
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

      // ✅ Tag customer for Shopify segment
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
  }
);


// ======================================================
// END Shopify block
// ======================================================


app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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

// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const mmaController = createMmaController({ supabaseAdmin, openai, replicate });
const mmaHub = mmaController.getHub();
const mmaRouter = createMmaRouter({
  supabaseAdmin,
  sbEnabled,
  mmaController,
  mmaHub,
  resolveCustomerId,
  normalizePassId,
  resolvePassId,
  sbEnsureCustomer,
  updateMmaPreferencesForEvent,
  requireAdmin,
  safeString,
  nowIso,
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
    name: "Style 1",
    profile: {
      keywords: [
        "editorial-still-life",
        "muted-color-palette",
        "soft-contrast",
      ],
      description:
        "editorial still life with a luxurious, magazine-era feel. Clean compositions, smooth backgrounds, and muted tones with gentle contrast. Subtle grain and soft highlights give a timeless, refined look while keeping the scene minimal and polished. no frames",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Vintage%201.png"],
  },

  gradient: {
    name: "Style 2",
    profile: {
      keywords: [
        "gradient-background",
        "midair-suspension",
        "luxury-editorial-still-life",
      ],
      description:
        "Minimal luxury still life shot against a smooth gradient backdrop, Editorial lighting, hyper-detailed textures and sculptural forms.",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Gradient%200.png"],
  },

  back_light: {
    name: "Style 3",
    profile: {
      keywords: [
        "luxury-editorial-still-life",
        "high-key-light-background",
        "backlit-translucency",
        "studio-shot",
      ],
      description:
        "Luxurious editorial still life on a bright, minimal background. Clean studio, strong backlight that reveals inner translucency and subtle texture",
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
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.editorial || {};

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

  // ✅ system prompt comes from runtime config (default = your current hardcoded)
  const systemMessage = {
    role: "system",
    content: safeString(g.system_text, BASE_GPT_SYSTEM_EDITORIAL),
  };

  const baseUserText = `
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

  // ✅ safe extra text you can edit in admin
  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

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

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 420,
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
    gptModel: result.gptModel,
    gptIO: result.gptIO,
  };
}


async function buildMotionPrompt(options) {
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.motion_prompt || {};

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
    content: safeString(g.system_text, BASE_GPT_SYSTEM_MOTION_PROMPT),
  };

  const baseUserText = `
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

  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

  const imageParts = [];
  if (lastImageUrl) imageParts.push({ type: "image_url", image_url: { url: lastImageUrl } });

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 280,
  });
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

async function buildMotionSuggestion(options) {
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.motion_suggest || {};

  const {
    referenceImageUrl,
    tone,
    platform = "tiktok",
    styleHistory = [],
    styleProfile = null,
    userDraft = "",
    extraImageUrls = [],
    presetHeroImageUrls = [],
  } = options;

  const cleanedDraft = safeString(userDraft, "").trim();

  const fallbackPrompt =
    cleanedDraft || "Slow, minimal motion, soft, ASMR movement, satisfying video";

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
    content: safeString(g.system_text, BASE_GPT_SYSTEM_MOTION_SUGGEST),
  };

  const baseUserText = `
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

  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

  const imageParts = [];

  if (referenceImageUrl) {
    imageParts.push({ type: "image_url", image_url: { url: referenceImageUrl } });
  }

  (extraImageUrls || [])
    .filter((u) => isHttpUrl(u))
    .slice(0, 4)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

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
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 260,
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

  // Persist to Supabase (skip anonymous to avoid FK)
  if (sbEnabled() && session.customerId !== "anonymous") {
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
    if (sbEnabled() && s.customerId !== "anonymous") {
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


function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const lower = token.toLowerCase();

  // Some clients occasionally send placeholder strings like "null"/"undefined" which
  // Supabase treats as invalid JWTs and returns a 401. Treat those as missing so the
  // request is handled as anonymous instead of erroring.
  if (!token || lower === "null" || lower === "undefined" || lower === "[object object]") {
    return null;
  }

  return token;
}

// ======================================================
// /me — ensures mega_customers row + returns passId
// - Creates a customer row on first login
// - Repairs old rows created by the frontend (missing last_active, credits, etc.)
// - Grants DEFAULT_FREE_CREDITS once (optional) + sets expiry (optional)
// ======================================================
app.get("/me", async (req, res) => {
  const requestId = `me_${Date.now()}_${crypto.randomUUID()}`;
  const incomingPassId = normalizePassId(req.get("X-Mina-Pass-Id"));

  try {
    const token = getBearerToken(req);
    const now = new Date().toISOString();

    // If no token, user is not logged in => DO NOT write DB
    // But still return a passId so the frontend can store it in localStorage
    if (!token) {
      const passId = resolvePassId({ incomingPassId });
      res.set("X-Mina-Pass-Id", passId);
      return res.json({
        ok: true,
        user: null,
        isAdmin: false,
        passId,
        requestId,
      });
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ ok: false, error: "INVALID_TOKEN", requestId });
    }

    const email = String(data.user.email || "").toLowerCase();
    const userId = String(data.user.id || "");

    if (!userId) {
      return res.status(401).json({ ok: false, error: "MISSING_USER_ID", requestId });
    }

    // Read existing customer row (if any)
    const { data: existing, error: exErr } = await supabaseAdmin
      .from("mega_customers")
      .select(
        "mg_pass_id, mg_admin_allowlist, mg_credits, mg_meta, mg_expires_at, mg_user_id, mg_email, mg_created_at"
      )
      .or(`mg_user_id.eq.${userId},mg_email.eq.${email}`)
      .limit(1)
      .maybeSingle();

    if (exErr) throw exErr;

    // Decide passId:
    // 1) DB passId (if exists)
    // 2) incoming header passId
    // 3) new uuid
    const passId = resolvePassId({
      existingPassId: existing?.mg_pass_id,
      incomingPassId,
      userId,
      email,
    });

    // meta can be json or string depending on column type/history
    const meta = (() => {
      const m = existing?.mg_meta;
      if (!m) return {};
      if (typeof m === "object") return m;
      if (typeof m === "string") {
        try {
          const j = JSON.parse(m);
          return j && typeof j === "object" ? j : {};
        } catch {
          return {};
        }
      }
      return {};
    })();

    const DEFAULT_FREE_CREDITS = Math.max(0, Number(process.env.DEFAULT_FREE_CREDITS || 0) || 0);

    // Always enforce a positive expiry window (policy = rolling 30d minimum)
    const CREDITS_EXPIRE_DAYS = DEFAULT_CREDITS_EXPIRE_DAYS;

    const expiresAtFromGrant = (grantIso) => addDaysToIso(grantIso || nowIso(), CREDITS_EXPIRE_DAYS);

    const welcomeAlreadyGranted = meta?.welcomeCreditsGranted === true;

    // -----------------------------
    // CREATE new row if missing
    // -----------------------------
    if (!existing) {
      const welcomeCredits = DEFAULT_FREE_CREDITS;
      const expiresAt = welcomeCredits > 0 ? expiresAtFromGrant(now) : null;

      const payload = {
        mg_pass_id: passId,
        mg_user_id: userId,
        mg_email: email || null,
        mg_display_name: email || null,

        mg_credits: welcomeCredits,
        mg_expires_at: expiresAt,
        mg_last_active: now,

        mg_disabled: false,
        mg_admin_allowlist: false,

        mg_meta: {
          ...meta,
          createdFrom: "me",
          welcomeCreditsGranted: welcomeCredits > 0 ? true : false,
          welcomeCredits: welcomeCredits,
          welcomeGrantedAt: welcomeCredits > 0 ? now : null,
        },

        mg_source_system: "app",
        mg_created_at: now,
        mg_updated_at: now,
      };

      const { error: insErr } = await supabaseAdmin.from("mega_customers").insert(payload);
      if (insErr) throw insErr;

      // Optional: also write an event for the welcome credit grant
      if (welcomeCredits > 0) {
        await supabaseAdmin
          .from("mega_generations")
          .insert({
            mg_id: `credit_transaction:${crypto.randomUUID()}`,
            mg_record_type: "credit_transaction",
            mg_pass_id: passId,
            mg_delta: welcomeCredits,
            mg_reason: "welcome",
            mg_source: "system",
            mg_ref_type: "welcome",
            mg_ref_id: passId,
            mg_created_at: now,
            mg_updated_at: now,
            mg_event_at: now,
            mg_meta: { email, userId },
            mg_source_system: "app",
          })
          .catch(() => {});
      }

      return res.json({
        ok: true,
        user: { id: userId, email },
        isAdmin: false,
        passId,
        requestId,
      });
    }

    // -----------------------------
    // REPAIR existing row
    // -----------------------------
    const updates = {
      mg_updated_at: now,
      mg_last_active: now,
    };

    // Ensure keys are filled
    if (!existing.mg_pass_id) updates.mg_pass_id = passId;
    if (!existing.mg_user_id) updates.mg_user_id = userId;
    if (!existing.mg_email && email) updates.mg_email = email;

    // If old/broken row has 0 credits and never got welcome credits, grant once
    const currentCredits = Number(existing.mg_credits || 0);

    // Backfill: credits exist but expiry is missing (fixes older misconfigured rows)
    if (currentCredits > 0 && !existing.mg_expires_at) {
      const grantAt =
        safeString(meta?.welcomeGrantedAt || existing?.mg_created_at || now, now);
      updates.mg_expires_at = expiresAtFromGrant(grantAt);
    }
    if (DEFAULT_FREE_CREDITS > 0 && !welcomeAlreadyGranted && currentCredits <= 0) {
      updates.mg_credits = DEFAULT_FREE_CREDITS;

      updates.mg_expires_at = expiresAtFromGrant(now);

      updates.mg_meta = {
        ...meta,
        welcomeCreditsGranted: true,
        welcomeCredits: DEFAULT_FREE_CREDITS,
        welcomeGrantedAt: now,
      };

      await supabaseAdmin
          .from("mega_generations")
          .insert({
          mg_id: `credit_transaction:${crypto.randomUUID()}`,
          mg_record_type: "credit_transaction",
          mg_pass_id: String(existing.mg_pass_id || passId),
          mg_delta: DEFAULT_FREE_CREDITS,
          mg_reason: "welcome_repair",
          mg_source: "system",
          mg_ref_type: "welcome",
          mg_ref_id: String(existing.mg_pass_id || passId),
          mg_created_at: now,
          mg_updated_at: now,
          mg_event_at: now,
          mg_meta: { email, userId },
          mg_source_system: "app",
        })
        .catch(() => {});
    } else {
      updates.mg_meta = { ...meta, lastSeenAt: now };
    }

    // Update using the safest identifier we have
    const q = supabaseAdmin.from("mega_customers").update(updates);
    if (existing.mg_pass_id) q.eq("mg_pass_id", existing.mg_pass_id);
    else q.eq("mg_user_id", userId);

    const { error: upErr } = await q;
    if (upErr) throw upErr;

    res.set("X-Mina-Pass-Id", passId);
    return res.json({
      ok: true,
      user: { id: userId, email },
      isAdmin: !!existing?.mg_admin_allowlist,
      passId: String(existing.mg_pass_id || passId),
      requestId,
    });
  } catch (e) {
    console.error("GET /me failed", e);
    // ✅ Never break the frontend boot with a 500.
    // If Supabase/Auth has a hiccup, treat as anonymous and still return a passId.
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
      passId: saved?.passId || null,
    });
  } catch (err) {
    console.error("POST /billing/settings error", err);
    res.status(500).json({ error: "Failed to save billing settings" });
  }
});
// =======================
// Public stats: total users
// Frontend calls: GET /public/stats/total-users
// =======================
app.get("/public/stats/total-users", async (_req, res) => {
  try {
    // If Supabase isn't configured, don't hard-fail (avoid noisy 500s)
    if (!sbEnabled()) {
      return res.json({ ok: true, totalUsers: 0, source: "no-supabase" });
    }

    // Uses your existing helper
    const count = await sbCountCustomers();

    return res.json({
      ok: true,
      totalUsers: Math.max(0, Number(count ?? 0)),
      source: "mega_customers",
    });
  } catch (e) {
    console.error("GET /public/stats/total-users failed:", e?.message || e);
    return res.status(500).json({ ok: false, error: "STATS_FAILED" });
  }
});

// =======================
// Customer history (generations + feedback + credits)
// =======================
app.get("/history", async (req, res) => {
  try {
    const customerId = resolveCustomerId(req, req.query);

    if (!sbEnabled()) {
      return res.status(503).json({
        ok: false,
        error: "NO_SUPABASE",
      });
    }

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
    return res.status(500).json({
      ok: false,
      error: "HISTORY_FAILED",
      message: err?.message || "Failed to load history",
    });
  }
});

// =======================
// Customer history (alias): /history/pass/:passId
// Supports older frontend that calls /history/pass/<passId>
// =======================
app.get("/history/pass/:passId", async (req, res) => {
  try {
    const passId = String(req.params.passId || "").trim();
    if (!passId) {
      return res.status(400).json({ ok: false, error: "MISSING_PASS_ID" });
    }

    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
    }

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
    return res.status(500).json({
      ok: false,
      error: "HISTORY_FAILED",
      message: err?.message || "Failed to load history",
    });
  }
});



// Credits: balance
app.get("/credits/balance", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const customerId = resolveCustomerId(req, { customerId: req.query.customerId });

    // ✅ Costs should always reflect runtime config (even if SB is off)
    const cfg = await getRuntimeConfig();
    const imageCost = Number(cfg?.credits?.imageCost ?? IMAGE_CREDITS_COST);
    const motionCost = Number(cfg?.credits?.motionCost ?? MOTION_CREDITS_COST);

    if (!sbEnabled()) {
      return res.json({
        ok: false,
        requestId,
        customerId,
        balance: null,
        historyLength: null,
        meta: { imageCost, motionCost },
        message: "Supabase not configured",
        passId: null,
      });
    }

    const rec = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });
    const passId = rec?.passId || null;

    res.json({
      ok: true,
      requestId,
      customerId,
      balance: rec.balance,
      historyLength: rec.historyLength,
      meta: { imageCost, motionCost }, // ✅ runtime config
      source: rec.source,
      passId,
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
    const customerId = resolveCustomerId(req, body);
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
      passId: out?.passId || null,
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

    // Sum credits + autoTopup enabled from MEGA_CUSTOMERS (best-effort; limited scan)
    let totalCredits = 0;
    let autoTopupOn = 0;

    const pageSize = 1000;
    let from = 0;
    const hardCap = 20000; // safety cap
    while (from < hardCap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabaseAdmin
        .from("mega_customers")
        .select("mg_credits,mg_meta")
        .range(from, to);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        totalCredits += Number(row.mg_credits || 0);
        const enabled = row?.mg_meta?.autoTopup?.enabled;
        if (enabled === true) autoTopupOn += 1;
      }

      if (data.length < pageSize) break;
      from += pageSize;
    }

    res.json({
      totalCustomers: totalCustomers ?? 0,
      totalCredits,
      autoTopupOn,
      source: "mega_customers",
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
// Admin: Runtime Config (live)
// =======================
app.get("/admin/config/runtime", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const effective = await getRuntimeConfig();
    const row = await sbGetRuntimeOverride();

    res.json({
      ok: true,
      defaults: DEFAULT_RUNTIME_CONFIG,
      override: row?.value || {},
      effective,
      meta: {
        updatedAt: row?.updated_at || null,
        updatedBy: row?.updated_by || null,
        ttlMs: RUNTIME_CONFIG_TTL_MS,
      },
      schema: RUNTIME_CONFIG_SCHEMA,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_READ_FAILED", message: e?.message || String(e) });
  }
});

// Replace the whole override JSON
app.post("/admin/config/runtime", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const { override } = req.body || {};
    if (!override || typeof override !== "object") {
      return res.status(400).json({ ok: false, error: "INVALID_OVERRIDE", message: "override must be a JSON object" });
    }

    await sbSetRuntimeOverride(override, req.user?.email || req.user?.userId || "admin");

    // refresh cache immediately
    runtimeConfigCache.fetchedAt = 0;
    const effective = await getRuntimeConfig();

    res.json({ ok: true, effective });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_SAVE_FAILED", message: e?.message || String(e) });
  }
});

// Set one field by path: { path: "gpt.editorial.temperature", value: 0.6 }
// Unset one field (delete from override) so it falls back to DEFAULT
app.post("/admin/config/runtime/unset", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const { path } = req.body || {};
    const p = safeString(path);
    if (!p) return res.status(400).json({ ok: false, error: "MISSING_PATH" });

    const row = await sbGetRuntimeOverride();
    const current = (row?.value && typeof row.value === "object") ? row.value : {};
    const next = unsetDeep({ ...current }, p);

    await sbSetRuntimeOverride(next, req.user?.email || req.user?.userId || "admin");

    runtimeConfigCache.fetchedAt = 0;
    const effective = await getRuntimeConfig();

    res.json({ ok: true, override: next, effective });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_UNSET_FAILED", message: e?.message || String(e) });
  }
});


// Force reload (optional button in dashboard)
app.post("/admin/config/runtime/reload", requireAdmin, async (_req, res) => {
  runtimeConfigCache.fetchedAt = 0;
  const effective = await getRuntimeConfig();
  res.json({ ok: true, effective });
});

// =======================
// Session start (Supabase-only)
// =======================
app.post("/sessions/start", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const customerId = resolveCustomerId(req, body);

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
    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });
    const passId = cust?.passId || null;

    const session = createSession({ customerId, platform, title });

    // For audit/ops correlation
    persistSessionHash(req, session.id || requestId, req.user?.userId, req.user?.email);

    res.json({
      ok: true,
      requestId,
      session,
      passId,
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
// ---- Mina Editorial (image) — MMA-backed shim for legacy frontend
// =======================
// This handler runs the MMA still pipeline so the existing Mina frontend keeps
// writing MEGA/MMA rows (generation + steps) while preserving the legacy
// `/editorial/generate` response shape the UI expects.
app.post("/editorial/generate", async (req, res) => {
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
    const customerId = resolveCustomerId(req, body);
    const assets = {
      product_url: safeString(body.productImageUrl) || null,
      logo_url: safeString(body.logoImageUrl) || null,
      inspiration_urls: Array.isArray(body.styleImageUrls)
        ? body.styleImageUrls.filter(Boolean)
        : [],
      style_hero_url: null,
      input_still_image_id: null,
      still_url: null,
    };

    const inputs = {
      userBrief: safeString(body.brief),
      style: safeString(body.tone || body.stylePresetKey || ""),
      aspect_ratio: safeString(body.aspectRatio || ""),
      platform: safeString(body.platform || ""),
    };

    const settings = {};
    if (inputs.aspect_ratio) settings.seedream = { aspect_ratio: inputs.aspect_ratio };

    const result = await mmaController.runStillCreate({
      customerId,
      email: req?.user?.email || null,
      userId: req?.user?.userId || null,
      assets,
      inputs,
      history: { vision_intelligence: !!body.minaVisionEnabled },
      brief: safeString(body.brief || ""),
      settings,
    });

    if (result?.passId) {
      res.set("X-Mina-Pass-Id", result.passId);
    }

    const imageUrl = result?.outputs?.seedream_image_url || null;
    const prompt = result?.mma_vars?.prompts?.clean_prompt || inputs.userBrief || "";
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
        imageTexts: result?.mma_vars?.scans?.output_still_crt
          ? [result.mma_vars.scans.output_still_crt]
          : undefined,
      },
      credits:
        creditsInfo.balance === null || creditsInfo.balance === undefined
          ? undefined
          : { balance: creditsInfo.balance },
    });
  } catch (err) {
    console.error("Error in /editorial/generate (mma shim):", err);
    return res.status(500).json({
      ok: false,
      error: "MMA_EDITORIAL_ERROR",
      message: err?.message || "Unexpected error during editorial generate.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Editorial (image) — R2 ONLY output (no provider URLs)
// =======================
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

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
    let customerId = resolveCustomerId(req, body);
    let platform = safeString(body.platform || "tiktok").toLowerCase();
    let stylePresetKey = safeString(body.stylePresetKey || "");
    const productImageUrl = safeString(body.productImageUrl);
    const logoImageUrl = safeString(body.logoImageUrl || "");
    const styleImageUrls = Array.isArray(body.styleImageUrls) ? body.styleImageUrls : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

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

    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });
    const passId = cust?.passId || null;

    const cfg = await getRuntimeConfig();
    const imageCost = Number(cfg?.credits?.imageCost ?? IMAGE_CREDITS_COST);
    // ✅ TEMP DEBUG: remove after you see values
    console.log("[CREDITS_DEBUG]", {
      customerId_from_body: req.body?.customerId,
      customerId_used: customerId,
      auth_user: req.user || null,
      header_pass_id: req.get("X-Mina-Pass-Id") || null,
    });
  
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
        passId,
      });
    }

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

    const seadreamModel = cfg?.models?.seadream || SEADREAM_MODEL;

    const input = {
      prompt,
      image_input: productImageUrl ? [productImageUrl, ...styleImageUrls] : styleImageUrls,
      max_images: body.maxImages || 1,
      size: cfg?.replicate?.seadream?.size || "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: cfg?.replicate?.seadream?.enhance_prompt ?? true,
      sequential_image_generation: cfg?.replicate?.seadream?.sequential_image_generation || "disabled",
    };

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      session_id: sessionId,
      customer_id: customerId,
      model: seadreamModel,
      provider: "replicate",
      input_chars: (prompt || "").length,
      stylePresetKey,
      minaVisionEnabled,
      generation_id: generationId,
    });

    const output = await replicate.run(seadreamModel, { input });

    let providerUrls = [];
    if (Array.isArray(output)) {
      providerUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") return item.url || item.image || null;
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      providerUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") providerUrls = [output.url];
      else if (Array.isArray(output.output)) providerUrls = output.output.filter((v) => typeof v === "string");
    }

    if (!providerUrls.length) throw new Error("Image generation returned no URL.");

    const storedImages = await Promise.all(
      providerUrls.map((u) =>
        storeRemoteToR2Public({
          remoteUrl: u,
          kind: "generations",
          customerId,
        })
      )
    );

    const imageUrls = storedImages.map((s) => s.publicUrl);
    const outputKey = storedImages[0]?.key || null;
    const imageUrl = imageUrls[0] || null;

    if (!imageUrl) throw new Error("R2 store failed (no public URL). Check R2_PUBLIC_BASE_URL.");

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
      outputKey,
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
        model: seadreamModel,
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
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      r2_url: imageUrl,
      session_id: sessionId,
      customer_id: customerId,
      model: seadreamModel,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });

    return res.json({
      ok: true,
      message: "Mina Editorial image generated (stored in R2).",
      requestId,
      prompt,
      imageUrl,
      imageUrls,
      generationId,
      sessionId,
      passId,
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

    return res.status(500).json({
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
    const cfg = await getRuntimeConfig();
    const gptModel = cfg?.models?.gpt || "gpt-4.1-mini";
    const referenceImageUrl = safeString(body.referenceImageUrl);

    if (!referenceImageUrl) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        model: gptModel,
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

    const customerId = resolveCustomerId(req, body);

    // Ensure customer exists
    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });
    const passId = cust?.passId || null;

    persistSessionHash(req, body.sessionId || customerId || requestId, req.user?.userId, req.user?.email);

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      session_id: normalizeSessionUuid(body.sessionId) || null,
      customer_id: customerId,
      model: gptModel,
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
      model: gptModel,
      provider: "openai",
      latency_ms: latencyMs,
      input_chars: JSON.stringify(body || {}).length,
      output_chars: (suggestionRes.text || "").length,
      generation_id: generationId,
    });

    res.json({
      ok: true,
      requestId,
      suggestion: suggestionRes.text,
      passId,
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
      model: gptModel,
      provider: "openai",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
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
// ---- Mina Motion (video) — MMA-backed shim for legacy frontend
// =======================
// Run the MMA video pipeline so legacy `/motion/generate` calls persist MEGA
// generations/steps while keeping the current response contract.
app.post("/motion/generate", async (req, res) => {
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
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription || body.text || body.motionBrief || "");

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

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

    if (result?.passId) {
      res.set("X-Mina-Pass-Id", result.passId);
    }

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
      gpt: {
        userMessage: result?.mma_vars?.prompts?.motion_prompt || null,
      },
      credits:
        creditsInfo.balance === null || creditsInfo.balance === undefined
          ? undefined
          : { balance: creditsInfo.balance },
    });
  } catch (err) {
    console.error("Error in /motion/generate (mma shim):", err);
    return res.status(500).json({
      ok: false,
      error: "MMA_MOTION_ERROR",
      message: err?.message || "Unexpected error during motion generate.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Motion (video) — R2 ONLY output (no provider URLs)
// =======================
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

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
    const motionDescription = safeString(body.motionDescription || body.text || body.motionBrief || "");
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    const customerId = resolveCustomerId(req, body);

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });
    const passId = cust?.passId || null;

    const cfg = await getRuntimeConfig();
    const motionCost = Number(cfg?.credits?.motionCost ?? MOTION_CREDITS_COST);
    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    if ((creditsInfo.balance ?? 0) < motionCost) {
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${motionCost}, you have ${creditsInfo.balance ?? 0}.`,
        requiredCredits: motionCost,
        currentCredits: creditsInfo.balance ?? 0,
        requestId,
        passId,
      });
    }

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

    const klingModel = cfg?.models?.kling || KLING_MODEL;

    const input = {
      mode: cfg?.replicate?.kling?.mode || "pro",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: cfg?.replicate?.kling?.negative_prompt || "",
    };

    const output = await replicate.run(klingModel, { input });

    let providerVideoUrl = null;
    if (typeof output === "string") {
      providerVideoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") providerVideoUrl = first;
      else if (first && typeof first === "object") {
        if (typeof first.url === "string") providerVideoUrl = first.url;
        else if (typeof first.video === "string") providerVideoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") providerVideoUrl = output.url;
      else if (typeof output.video === "string") providerVideoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") providerVideoUrl = output.output[0];
      }
    }

    if (!providerVideoUrl) throw new Error("Motion generation returned no URL.");

    const storedVideo = await storeRemoteToR2Public({
      remoteUrl: providerVideoUrl,
      kind: "motions",
      customerId,
    });

    const videoUrl = storedVideo.publicUrl;
    const outputKey = storedVideo.key;

    if (!videoUrl) throw new Error("R2 store failed (no public URL). Check R2_PUBLIC_BASE_URL.");

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
      outputKey,
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
        model: klingModel,
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
      model: klingModel,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });
    return res.json({
      ok: true,
      message: "Mina Motion video generated (stored in R2).",
      requestId,
      prompt,
      videoUrl,
      generationId,
      sessionId,
      passId,
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
    return res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});
// =======================
// ---- Feedback / likes (R2 ONLY persistence)
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
    const customerId = resolveCustomerId(req, body);

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

    const cust = await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });
    const passId = cust?.passId || null;

    let cleanImageUrl = imageUrl || "";
    let cleanVideoUrl = videoUrl || "";

    // ✅ Guarantee permanent public URLs (never store signed URLs)
    if (cleanImageUrl) {
      const perm = toPermanentPublicAssetUrl(cleanImageUrl);
      if (perm) {
        cleanImageUrl = perm;
      } else if (!isPermanentPublicAssetUrl(cleanImageUrl)) {
        const stored = await storeRemoteToR2Public({
          remoteUrl: cleanImageUrl,
          kind: "likes-images",
          customerId,
        });
        cleanImageUrl = stored.publicUrl;
      }
    }

    if (cleanVideoUrl) {
      const perm = toPermanentPublicAssetUrl(cleanVideoUrl);
      if (perm) {
        cleanVideoUrl = perm;
      } else if (!isPermanentPublicAssetUrl(cleanVideoUrl)) {
        const stored = await storeRemoteToR2Public({
          remoteUrl: cleanVideoUrl,
          kind: "likes-videos",
          customerId,
        });
        cleanVideoUrl = stored.publicUrl;
      }
    }

    rememberLike(customerId, {
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: cleanImageUrl || null,
      videoUrl: cleanVideoUrl || null,
    });

    const feedbackId = crypto.randomUUID();
    const feedback = {
      id: feedbackId,
      sessionId,
      generationId,
      customerId,
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: cleanImageUrl || null,
      videoUrl: cleanVideoUrl || null,
      createdAt: new Date().toISOString(),
    };

    await sbUpsertFeedbackBusiness(feedback);

    let totalLikes = null;
    try {
      const likes = await sbGetLikesForCustomer(customerId, MAX_LIKES_PER_CUSTOMER);
      totalLikes = likes.length;
    } catch (_) {}

    return res.json({
      ok: true,
      message: "Like stored (R2 only).",
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
      passId,
    });
  } catch (err) {
    console.error("Error in /feedback/like:", err);
    return res.status(500).json({
      ok: false,
      error: "FEEDBACK_ERROR",
      message: err?.message || "Unexpected error while saving feedback.",
      requestId,
    });
  }
});

// ========================
// MMA generation + streaming API
// ========================
app.use("/mma", mmaRouter);
// ============================
// Store remote generation (Provider URL -> R2 PUBLIC URL)
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

    const stored = await storeRemoteToR2Public({
      remoteUrl,
      kind: fold,
      customerId: cid,
    });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,      // ✅ public, never expires
      publicUrl: stored.publicUrl,
    });
  } catch (err) {
    console.error("POST /store-remote-generation error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED", message: err?.message || "Failed" });
  }
});


// =========================
// R2 Upload (kept same route name, BUT returns PUBLIC url)
// =========================
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
      url: stored.publicUrl,        // ✅ public non-expiring
      publicUrl: stored.publicUrl,
      contentType,
      bytes: buffer.length,
    });
  } catch (err) {
    console.error("POST /api/r2/upload-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "UPLOAD_PUBLIC_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const stored = await storeRemoteToR2Public({
      remoteUrl: url,
      kind,
      customerId,
    });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,        // ✅ public non-expiring
      publicUrl: stored.publicUrl,
    });
  } catch (err) {
    console.error("POST /api/r2/store-remote-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "STORE_REMOTE_PUBLIC_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});


// =======================
// Start server
// =======================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
