// ./server/mma/mma-controller.js
import express from "express";
import OpenAI from "openai";
import Replicate from "replicate";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { megaEnsureCustomer, megaWriteSession } from "../../mega-db.js";
import { getSupabaseAdmin } from "../../supabase.js";

import {
  computePassId,
  eventIdentifiers,
  generationIdentifiers,
  makeInitialVars,
  newUuid,
  nowIso,
  stepIdentifiers,
} from "./mma-utils.js";

import { addSseClient, sendDone, sendScanLine, sendStatus } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";

// ============================================================================
// USER-FACING TEXT (EDIT THESE)
// - The ONLY place you should tweak wording.
// - Keep them friendly and NOT technical (no “scanning”, “prompting”, “kling”, etc).
// ============================================================================
const MMA_UI = {
  // Map internal pipeline statuses -> what the frontend sees in SSE status
  statusMap: {
    queued: "working",
    scanning: "working",
    prompting: "working",
    generating: "working",
    postscan: "working",
    suggested: "ready",
    done: "done",
    error: "error",
  },

  // “quick lines” we can emit immediately (no GPT needed)
  quickLines: {
    still_create_start: [
      "One sec—getting everything ready ✨",
      "Alright—setting things up for you 💫",
      "Love it. Let me prep your inputs ✨",
    ],
    still_tweak_start: [
      "Got it—let’s refine that ✨",
      "Okay—making it even better 💫",
      "Let’s polish this up ✅",
    ],
    video_animate_start: [
      "Nice—let’s bring it to life 🎬✨",
      "Okay—animating this for you 🎥",
      "Let’s make it move ✨",
    ],
    video_tweak_start: [
      "Got it—updating the motion 🎬✨",
      "Alright—tweaking the animation 💫",
      "Let’s refine the movement ✅",
    ],
    saved_image: ["Saved ✅", "All set ✅", "Done ✅"],
    saved_video: ["Saved ✅", "Your clip is ready ✅", "Done ✅"],
  },

  // If GPT returns an empty userMessage, use these fallbacks (still friendly)
  fallbacks: {
    scanned: ["Got it ✅", "Noted ✅", "Perfect—got it ✅"],
    thinking: ["Working on it ✨", "Putting it together ✨", "Almost there 💫"],
    final: ["All set ✅", "Here you go ✅", "Done ✅"],
  },

  // Hard rule: userMessages must NOT reveal internals
  // (we inject this into every system prompt that outputs userMessage)
  userMessageRules: [
    "USER MESSAGE RULES (VERY IMPORTANT):",
    "- userMessage must be short, friendly, human.",
    "- Do NOT mention internal steps or tools (no 'scanning', 'prompting', 'model', 'AI', 'Kling', 'Seedream', 'Replicate', 'OpenAI', 'Supabase', 'DB', 'pipeline').",
    "- Do NOT mention errors like CORS/browser/network.",
    "- Do NOT use robotic labels. No status words.",
    "- Max 140 characters.",
  ].join("\n"),
};

function toUserStatus(internalStatus) {
  const s = String(internalStatus || "queued");
  return MMA_UI.statusMap[s] || "working";
}

function pick(arr, fallback = "") {
  const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!a.length) return fallback;
  return a[Math.floor(Math.random() * a.length)];
}

// ============================================================================
// Clients (cached singletons)
// ============================================================================
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

// ============================================================================
// Small helpers
// ============================================================================
function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

function asHttpUrl(u) {
  const s = safeStr(u, "");
  return s.startsWith("http") ? s : "";
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function parseJsonMaybe(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function pushUserMessageLine(vars, text) {
  const t = safeStr(text, "");
  if (!t) return vars;

  const next = { ...(vars || {}) };
  next.userMessages = { ...(next.userMessages || {}) };

  const prev = Array.isArray(next.userMessages.scan_lines) ? next.userMessages.scan_lines : [];
  const index = prev.length;

  next.userMessages.scan_lines = [...prev, { text: t, index }];
  return next;
}

function lastScanLine(vars, fallbackText = "") {
  const lines = vars?.userMessages?.scan_lines;
  const last = Array.isArray(lines) ? lines[lines.length - 1] : null;
  if (last) return last;
  return { text: fallbackText, index: Array.isArray(lines) ? lines.length : 0 };
}

function emitStatus(generationId, internalStatus) {
  // ✅ never leak internal status to UI
  sendStatus(generationId, toUserStatus(internalStatus));
}

function emitLine(generationId, vars, fallbackText = "") {
  const line = lastScanLine(vars, fallbackText);
  sendScanLine(generationId, line);
}

function setCtxAudit(vars, ctx) {
  const next = { ...(vars || {}) };
  next.ctx = { ...(next.ctx || {}), mma_ctx_used: ctx };
  return next;
}

// ============================================================================
// ctx config (editable in mega_admin)
// table: mega_admin row: mg_record_type='app_config', mg_key='mma_ctx', mg_value json
// ============================================================================
async function getMmaCtxConfig(supabase) {
  const defaults = {
    scanner: [
      "You are Mina GPTscanner.",
      "You will be given ONE image. Understand it.",
      'Output STRICT JSON only (no markdown): {"crt":string,"userMessage":string}',
      "crt: short factual description of the image in ONE sentence (max 220 chars).",
      "If it's product/logo/inspiration, hint that in crt.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    like_history: [
      "You are Mina Style Memory.",
      "You will receive a list of the user's recently liked generations (prompts and sometimes images).",
      'Output STRICT JSON only: {"style_history_csv":string}',
      "style_history_csv: comma-separated keywords (5 to 12 items). No hashtags. No sentences.",
      'Example: "editorial still life, luxury, minimal, soft shadows, no lens flare"',
    ].join("\n"),

    reader: [
      "You are Mina Mind — prompt builder for Seedream (still image only).",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string,"userMessage":string}',
      "clean_prompt must be Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists, and use inspirations if provided.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    output_scan: [
      "You are Mina GPTscanner (output scan).",
      "You will be given the GENERATED image.",
      'Output STRICT JSON only (no markdown): {"still_crt":string,"userMessage":string}',
      "still_crt: short description of what the generated image contains (1 sentence, max 220 chars).",
      MMA_UI.userMessageRules,
    ].join("\n"),

    feedback: [
      "You are Mina Feedback Fixer for Seedream still images.",
      "You will receive: generated image + still_crt + user feedback text + previous prompt.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string}',
      "clean_prompt must keep what's good, fix what's bad, and apply feedback precisely.",
    ].join("\n"),

    // ---------------------------
    // MOTION (video) ctx blocks
    // ---------------------------
    motion_suggestion: [
      "You are Mina Motion Suggestion.",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"sugg_prompt":string,"userMessage":string}',
      "sugg_prompt: a simple, short Kling-ready motion prompt. Be clear about motion + camera.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    motion_reader2: [
      "You are Mina Motion Reader — prompt builder for Kling (image-to-video).",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"motion_prompt":string,"userMessage":string}',
      "motion_prompt: Kling-ready. Describe motion, camera movement, atmosphere, pace. Concise but detailed.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    motion_feedback2: [
      "You are Mina Motion Feedback Fixer for Kling (image-to-video).",
      "You will receive: base motion input + feedback_motion + previous motion prompt.",
      'Output STRICT JSON only (no markdown): {"motion_prompt":string}',
      "motion_prompt must keep what's good, fix what's bad, and apply feedback precisely.",
    ].join("\n"),
  };

  try {
    const { data, error } = await supabase
      .from("mega_admin")
      .select("mg_value")
      .eq("mg_record_type", "app_config")
      .eq("mg_key", "mma_ctx")
      .maybeSingle();

    if (error) throw error;

    const overrides = data?.mg_value && typeof data.mg_value === "object" ? data.mg_value : {};
    return { ...defaults, ...overrides };
  } catch {
    return defaults;
  }
}

// ============================================================================
// OpenAI vision JSON helper (Responses API preferred, Chat Completions fallback)
// ============================================================================
function buildResponsesUserContent({ text, imageUrls }) {
  const parts = [];
  const t = safeStr(text, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const u of safeArray(imageUrls)) {
    const url = asHttpUrl(u);
    if (!url) continue;
    parts.push({ type: "input_image", image_url: url });
  }
  return parts;
}

function extractResponsesText(resp) {
  if (resp && typeof resp.output_text === "string") return resp.output_text;
  const out = resp?.output;
  if (!Array.isArray(out)) return "";
  let text = "";
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text || "";
}

async function openaiJsonVision({ model, system, userText, imageUrls }) {
  const openai = getOpenAI();

  // Try Responses API
  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContent({ text: userText, imageUrls }) },
      ];

      const resp = await openai.responses.create({
        model,
        input,
        text: { format: { type: "json_object" } },
      });

      const raw = extractResponsesText(resp);
      const parsed = parseJsonMaybe(raw);

      return { request: { model, input, text: { format: { type: "json_object" } } }, raw, parsed };
    }
  } catch {
    // fallback below
  }

  // Chat Completions fallback
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: safeStr(userText, "") },
        ...safeArray(imageUrls)
          .map(asHttpUrl)
          .filter(Boolean)
          .map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
}

// ============================================================================
// GPT steps
// ============================================================================
async function gptScanImage({ cfg, ctx, kind, imageUrl }) {
  const userText = [`KIND: ${kind}`, "Return JSON only."].join("\n");
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.scanner,
    userText,
    imageUrls: [imageUrl],
  });

  const crt = safeStr(out?.parsed?.crt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return { crt, userMessage, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMakeStyleHistory({ cfg, ctx, likeItems }) {
  const userText = [
    "RECENT_LIKES (prompt + imageUrl):",
    JSON.stringify(likeItems, null, 2).slice(0, 12000),
    "Return JSON only.",
  ].join("\n");

  const imageUrls = likeItems.map((x) => asHttpUrl(x?.imageUrl)).filter(Boolean).slice(0, 8);

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.like_history,
    userText,
    imageUrls,
  });

  const style_history_csv = safeStr(out?.parsed?.style_history_csv, "");
  return { style_history_csv, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptReader({ cfg, ctx, input, imageUrls }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.reader,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: safeArray(imageUrls).slice(0, 10),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return { clean_prompt, userMessage, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptScanOutputStill({ cfg, ctx, imageUrl }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.output_scan,
    userText: "Return JSON only.",
    imageUrls: [imageUrl],
  });

  const still_crt = safeStr(out?.parsed?.still_crt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return { still_crt, userMessage, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptFeedbackFixer({ cfg, ctx, parentImageUrl, stillCrt, feedbackText, previousPrompt }) {
  const input = {
    parent_image_url: parentImageUrl,
    still_crt: safeStr(stillCrt, ""),
    feedback: safeStr(feedbackText, ""),
    previous_prompt: safeStr(previousPrompt, ""),
  };

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.feedback,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: [parentImageUrl],
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "") || safeStr(out?.parsed?.prompt, "") || "";
  return { clean_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

// ---- motion GPT steps (support optional end frame) ----
async function gptMotionSuggestion({ cfg, ctx, startImageUrl, endImageUrl, stillCrt, motionBrief, movementStyle }) {
  const input = {
    start_image_url: startImageUrl,
    end_image_url: asHttpUrl(endImageUrl) || null,
    still_crt: safeStr(stillCrt, ""),
    motion_user_brief: safeStr(motionBrief, ""),
    selected_movement_style: safeStr(movementStyle, ""),
  };

  const images = [startImageUrl, endImageUrl].map(asHttpUrl).filter(Boolean);

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_suggestion,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: images,
  });

  const sugg_prompt = safeStr(out?.parsed?.sugg_prompt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");
  return { sugg_prompt, userMessage, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionReader2({ cfg, ctx, startImageUrl, endImageUrl, stillCrt, motionBrief, movementStyle }) {
  const input = {
    start_image_url: startImageUrl,
    end_image_url: asHttpUrl(endImageUrl) || null,
    still_crt: safeStr(stillCrt, ""),
    motion_user_brief: safeStr(motionBrief, ""),
    selected_movement_style: safeStr(movementStyle, ""),
  };

  const images = [startImageUrl, endImageUrl].map(asHttpUrl).filter(Boolean);

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_reader2,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: images,
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");
  return { motion_prompt, userMessage, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionFeedback2({
  cfg,
  ctx,
  startImageUrl,
  endImageUrl,
  baseInput,
  feedbackMotion,
  previousMotionPrompt,
}) {
  const input = {
    ...baseInput,
    end_image_url: asHttpUrl(endImageUrl) || baseInput?.end_image_url || null,
    feedback_motion: safeStr(feedbackMotion, ""),
    previous_motion_prompt: safeStr(previousMotionPrompt, ""),
  };

  const images = [startImageUrl, endImageUrl].map(asHttpUrl).filter(Boolean);

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_feedback2,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: images,
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "") || "";
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

// ============================================================================
// Replicate helpers (Seedream + Kling)
// ============================================================================
function pickFirstUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return pickFirstUrl(output[0]);
  if (typeof output === "object") {
    if (typeof output.url === "string") return output.url;
    if (typeof output.output === "string") return output.output;
  }
  return "";
}

function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url || assets.styleHeroImageUrl || assets.style_hero_url || assets.styleHeroUrl
  );

  const inspiration = safeArray(
    assets.inspiration_image_urls ||
      assets.inspirationImageUrls ||
      assets.style_image_urls ||
      assets.styleImageUrls
  )
    .map(asHttpUrl)
    .filter(Boolean)
    .slice(0, 4);

  // spec order: product, logo, inspirations, style hero
  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 10);
}

async function runSeedream({ prompt, aspectRatio, imageInputs = [], size, enhancePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const sizeValue = size || cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K";
  const defaultAspect = cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";

  const version =
    process.env.MMA_SEADREAM_VERSION ||
    process.env.MMA_SEADREAM_MODEL_VERSION ||
    cfg?.seadream?.model ||
    "bytedance/seedream-4";

  const neg =
    process.env.NEGATIVE_PROMPT_SEADREAM ||
    process.env.MMA_NEGATIVE_PROMPT_SEADREAM ||
    cfg?.seadream?.negativePrompt ||
    "";

  const finalPrompt = neg ? `${prompt}\n\nAvoid: ${neg}` : prompt;

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 10);

  const enhance_prompt =
    enhancePrompt !== undefined
      ? enhancePrompt
      : cfg?.seadream?.enhancePrompt !== undefined
        ? !!cfg.seadream.enhancePrompt
        : true;

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || finalPrompt }
    : {
        prompt: finalPrompt,
        size: sizeValue,
        aspect_ratio: aspectRatio || defaultAspect,
        enhance_prompt,
        sequential_image_generation: "disabled",
        max_images: 1,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  // enforce required fields
  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.size) input.size = sizeValue;
  if (input.enhance_prompt === undefined) input.enhance_prompt = enhance_prompt;
  if (!input.sequential_image_generation) input.sequential_image_generation = "disabled";
  if (!input.max_images) input.max_images = 1;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
  };
}

// ---- Kling helpers ----
function pickKlingStartImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return (
    asHttpUrl(inputs.start_image_url || inputs.startImageUrl) ||
    asHttpUrl(inputs.parent_output_url || inputs.parentOutputUrl) ||
    asHttpUrl(parent?.mg_output_url) ||
    asHttpUrl(assets.start_image_url || assets.startImageUrl) ||
    asHttpUrl(assets.product_image_url || assets.productImageUrl) ||
    ""
  );
}

function pickKlingEndImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  // allow explicit end image (optional)
  return asHttpUrl(inputs.end_image_url || inputs.endImageUrl) || asHttpUrl(assets.end_image_url || assets.endImageUrl) || "";
}

async function runKling({ prompt, startImage, endImage, duration, mode, negativePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_KLING_VERSION ||
    process.env.MMA_KLING_MODEL_VERSION ||
    cfg?.kling?.model ||
    "kwaivgi/kling-v2.1";

  const defaultDuration = Number(duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    cfg?.kling?.negativePrompt ||
    "";

  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;

  const hasEnd = !!asHttpUrl(endImage);
  const finalMode =
    safeStr(mode, "") ||
    (hasEnd ? "pro" : "") ||
    cfg?.kling?.mode ||
    process.env.MMA_KLING_MODE ||
    "standard";

  const input = forcedInput
    ? { ...forcedInput }
    : {
        mode: finalMode,
        prompt,
        duration: defaultDuration,
        start_image: startImage,
        ...(hasEnd ? { end_image: asHttpUrl(endImage) } : {}),
      };

  if (finalNeg && !input.negative_prompt) input.negative_prompt = finalNeg;
  if (!input.mode) input.mode = finalMode;
  if (!input.prompt) input.prompt = prompt;
  input.duration = Number(input.duration ?? defaultDuration) || defaultDuration;
  if (!input.start_image) input.start_image = startImage;
  if (hasEnd && !input.end_image) input.end_image = asHttpUrl(endImage);

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
  };
}

// ============================================================================
// R2 Public store
// ============================================================================
function getR2() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const publicBase = process.env.R2_PUBLIC_BASE_URL || "";

  const enabled = !!(endpoint && accessKeyId && secretAccessKey && bucket && publicBase);
  const client = enabled
    ? new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      })
    : null;

  return { enabled, client, bucket, publicBase };
}

function guessExt(url, fallback = ".bin") {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return ".jpg";
    if (p.endsWith(".webp")) return ".webp";
    if (p.endsWith(".gif")) return ".gif";
    if (p.endsWith(".mp4")) return ".mp4";
    if (p.endsWith(".webm")) return ".webm";
    if (p.endsWith(".mov")) return ".mov";
    return fallback;
  } catch {
    return fallback;
  }
}

async function storeRemoteToR2Public(url, keyPrefix) {
  const { enabled, client, bucket, publicBase } = getR2();
  if (!enabled || !client) return url;
  if (!url || typeof url !== "string") return url;

  if (publicBase && url.startsWith(publicBase)) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`R2_FETCH_FAILED_${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(url, contentType.includes("video") ? ".mp4" : ".png");
  const objKey = `${keyPrefix}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objKey,
      Body: buf,
      ContentType: contentType,
    })
  );

  return `${publicBase.replace(/\/$/, "")}/${objKey}`;
}

// ============================================================================
// DB helpers
// ============================================================================
async function ensureCustomerRow(passId, { shopifyCustomerId, userId, email }) {
  const out = await megaEnsureCustomer({
    passId,
    shopifyCustomerId: shopifyCustomerId || null,
    userId: userId || null,
    email: email || null,
  });
  return { preferences: out?.preferences || {} };
}

async function ensureSessionForHistory({ passId, sessionId, platform, title, meta }) {
  const sid = safeStr(sessionId, "");
  if (!sid) return;

  try {
    await megaWriteSession({
      passId,
      sessionId: sid,
      platform: safeStr(platform, "web"),
      title: safeStr(title, "Mina session"),
      meta: meta || null,
    });
  } catch {
    // ignore if already exists / schema differences
  }
}

async function writeGeneration({ supabase, generationId, parentId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);

  const inputs = vars?.inputs || {};
  const platform = safeStr(inputs.platform || "web", "web");
  const title = safeStr(inputs.title || "Mina session", "Mina session");
  const sessionId = safeStr(inputs.session_id || inputs.sessionId || "", "");

  const contentType = mode === "video" ? "video" : "image";

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: parentId ? `generation:${parentId}` : null,
    mg_pass_id: passId,

    // ✅ what your /history route expects
    mg_session_id: sessionId || null,
    mg_platform: platform,
    mg_title: title,
    mg_type: contentType,
    mg_content_type: contentType,

    mg_status: "queued",
    mg_mma_status: "queued",
    mg_mma_mode: mode,
    mg_mma_vars: vars,
    mg_prompt: null,
    mg_output_url: null,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
}

async function writeStep({ supabase, generationId, passId, stepNo, stepType, payload }) {
  const identifiers = stepIdentifiers(generationId, stepNo);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: `generation:${generationId}`,
    mg_pass_id: passId || null,
    mg_step_type: stepType,
    mg_payload: payload,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
}

async function finalizeGeneration({ supabase, generationId, url, prompt }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: "done",
      mg_mma_status: "done",
      mg_output_url: url,
      mg_prompt: prompt,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateVars({ supabase, generationId, vars }) {
  await supabase
    .from("mega_generations")
    .update({ mg_mma_vars: vars, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateStatus({ supabase, generationId, status }) {
  await supabase
    .from("mega_generations")
    .update({ mg_status: status, mg_mma_status: status, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function fetchParentGenerationRow(supabase, parentGenerationId) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select(
      "mg_pass_id, mg_output_url, mg_prompt, mg_mma_vars, mg_mma_mode, mg_status, mg_error, mg_session_id, mg_platform, mg_title"
    )
    .eq("mg_generation_id", parentGenerationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// Likes are stored in mega_generations as mg_record_type='feedback' in your setup.
// We try mg_payload first; then mg_meta fallback.
function extractFeedbackPayload(row) {
  const p = parseJsonMaybe(row?.mg_payload);
  if (p) return p;
  const m = parseJsonMaybe(row?.mg_meta);
  if (!m) return null;
  if (m.payload && typeof m.payload === "object") return m.payload;
  return m;
}

// ✅ Dedup liked items so they NEVER repeat in the style memory input
async function fetchRecentLikedItems({ supabase, passId, limit }) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_payload, mg_meta, mg_event_at, mg_created_at")
    .eq("mg_record_type", "feedback")
    .eq("mg_pass_id", passId)
    .order("mg_event_at", { ascending: false })
    .limit(Math.max(60, limit * 8));

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const liked = [];
  const seen = new Set();

  for (const r of rows) {
    const payload = extractFeedbackPayload(r);
    if (!payload) continue;

    const isLiked = payload.liked === true;
    if (!isLiked) continue;

    const genId = safeStr(payload.generation_id || payload.generationId || r.mg_generation_id, "");
    const prompt = safeStr(payload.prompt, "");
    const imageUrl = safeStr(payload.imageUrl || payload.image_url || payload.url, "");

    const key =
      genId ? `g:${genId}` : imageUrl ? `u:${imageUrl}` : prompt ? `p:${prompt}` : "";

    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    liked.push({
      generationId: genId || null,
      prompt,
      imageUrl,
      createdAt: r.mg_event_at || r.mg_created_at || null,
    });

    if (liked.length >= limit) break;
  }

  return liked;
}

// ✅ Upsert-like behavior for feedback rows (prevents duplicates in /history joins)
async function upsertFeedbackRow({ supabase, passId, generationId, liked, payload }) {
  const gid = safeStr(generationId, "");
  if (!gid) return;

  const imageUrl = safeStr(payload?.imageUrl || payload?.image_url || payload?.url || payload?.output_url, "");
  const prompt = safeStr(payload?.prompt, "");

  // Find newest existing feedback row for (passId, generationId)
  let existing = null;
  try {
    const { data, error } = await supabase
      .from("mega_generations")
      .select("mg_event_id, mg_created_at, mg_event_at")
      .eq("mg_record_type", "feedback")
      .eq("mg_pass_id", passId)
      .eq("mg_generation_id", gid)
      .order("mg_event_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error) existing = data || null;
  } catch {
    existing = null;
  }

  const feedbackPayload = {
    ...(typeof payload === "object" && payload ? payload : {}),
    liked: !!liked,
    generation_id: gid,
    prompt,
    imageUrl,
  };

  // Update if exists
  if (existing?.mg_event_id) {
    await supabase
      .from("mega_generations")
      .update({
        mg_payload: feedbackPayload,
        mg_meta: { source: "mma", event_type: liked ? "like" : "dislike" },
        mg_event_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_record_type", "feedback")
      .eq("mg_pass_id", passId)
      .eq("mg_generation_id", gid)
      .eq("mg_event_id", existing.mg_event_id);

    // Best-effort cleanup: delete older duplicates if they exist
    try {
      const { data: dups } = await supabase
        .from("mega_generations")
        .select("mg_event_id")
        .eq("mg_record_type", "feedback")
        .eq("mg_pass_id", passId)
        .eq("mg_generation_id", gid)
        .order("mg_event_at", { ascending: false })
        .limit(25);

      const ids = (Array.isArray(dups) ? dups : [])
        .map((x) => safeStr(x?.mg_event_id, ""))
        .filter(Boolean);

      const keep = existing.mg_event_id;
      const toDelete = ids.filter((id) => id && id !== keep);

      if (toDelete.length) {
        // Supabase "in" filter
        await supabase
          .from("mega_generations")
          .delete()
          .eq("mg_record_type", "feedback")
          .eq("mg_pass_id", passId)
          .eq("mg_generation_id", gid)
          .in("mg_event_id", toDelete);
      }
    } catch {
      // ignore cleanup errors
    }

    return;
  }

  // Insert new feedback row
  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_record_type: "feedback", // override (we want feedback rows, not generic events)
    mg_generation_id: gid,
    mg_pass_id: passId,
    mg_parent_id: `generation:${gid}`,
    mg_payload: feedbackPayload,
    mg_meta: { source: "mma", event_type: liked ? "like" : "dislike" },
    mg_event_at: nowIso(),
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
}

// ============================================================================
// STILL CREATE PIPELINE
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  try {
    // ---- scanning ----
    await updateStatus({ supabase, generationId, status: "scanning" });
    emitStatus(generationId, "scanning");

    working = setCtxAudit(working, ctx);
    working.scans = { ...(working.scans || {}) };

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_create_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const assets = working?.assets || {};
    const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
    const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

    const inspUrls = safeArray(
      assets.inspiration_image_urls || assets.inspirationImageUrls || assets.style_image_urls || assets.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean)
      .slice(0, 4);

    // product
    if (productUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "product", imageUrl: productUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_product",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "product", imageUrl: productUrl },
          request: scan.request,
          raw: scan.raw,
          output: { crt: scan.crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.product_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    }

    // logo
    if (logoUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "logo", imageUrl: logoUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_logo",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "logo", imageUrl: logoUrl },
          request: scan.request,
          raw: scan.raw,
          output: { crt: scan.crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.logo_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    }

    // inspirations
    working.scans.inspiration_crt = Array.isArray(working.scans.inspiration_crt) ? working.scans.inspiration_crt : [];
    for (let i = 0; i < inspUrls.length; i++) {
      const imageUrl = inspUrls[i];
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: `inspiration_${i + 1}`, imageUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_inspiration",
        payload: {
          ctx: ctx.scanner,
          input: { kind: `inspiration_${i + 1}`, imageUrl },
          request: scan.request,
          raw: scan.raw,
          output: { crt: scan.crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.inspiration_crt = [...working.scans.inspiration_crt, scan.crt || ""];
      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    }

    // ---- optional like history -> style keywords ----
    try {
      const visionOn = !!working?.history?.vision_intelligence;
      const likeLimit = visionOn ? 5 : 20;

      const likes = await fetchRecentLikedItems({ supabase, passId, limit: likeLimit });
      if (likes.length) {
        const t0 = Date.now();
        const style = await gptMakeStyleHistory({ cfg, ctx, likeItems: likes });

        await writeStep({
          supabase,
          generationId,
          passId,
          stepNo: stepNo++,
          stepType: "gpt_like_history",
          payload: {
            ctx: ctx.like_history,
            input: { vision_intelligence: visionOn, limit: likeLimit, likes },
            request: style.request,
            raw: style.raw,
            output: { style_history_csv: style.style_history_csv, parsed_ok: style.parsed_ok },
            timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
            error: null,
          },
        });

        working.history = { ...(working.history || {}), style_history_csv: style.style_history_csv || null };
        await updateVars({ supabase, generationId, vars: working });
      }
    } catch {
      // optional
    }

    // ---- prompting ----
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    const readerInput = {
      product_crt: safeStr(working?.scans?.product_crt, ""),
      logo_crt: safeStr(working?.scans?.logo_crt, ""),
      inspiration_crt: Array.isArray(working?.scans?.inspiration_crt) ? working.scans.inspiration_crt : [],
      userBrief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      platform: safeStr(working?.inputs?.platform || "default", "default"),
      aspect_ratio: safeStr(working?.inputs?.aspect_ratio, ""),
      style_history_csv: safeStr(working?.history?.style_history_csv, ""),
      preferences: preferences || {},
    };

    const readerImages = [productUrl, logoUrl, ...inspUrls].map(asHttpUrl).filter(Boolean);

    const tReader = Date.now();
    const prompts = await gptReader({ cfg, ctx, input: readerInput, imageUrls: readerImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_reader",
      payload: {
        ctx: ctx.reader,
        input: readerInput,
        request: prompts.request,
        raw: prompts.raw,
        output: { clean_prompt: prompts.clean_prompt, userMessage: prompts.userMessage, parsed_ok: prompts.parsed_ok },
        timing: { started_at: new Date(tReader).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - tReader },
        error: null,
      },
    });

    working.prompts = { ...(working.prompts || {}), clean_prompt: prompts.clean_prompt || "" };
    working = pushUserMessageLine(working, prompts.userMessage || pick(MMA_UI.fallbacks.thinking));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    // ---- generating ----
    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    const usedPrompt = safeStr(working?.prompts?.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_PROMPT");

    const imageInputs = buildSeedreamImageInputs(working);
    const aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      cfg?.seadream?.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    const { input, out, timing } = await runSeedream({
      prompt: usedPrompt,
      aspectRatio,
      imageInputs,
      size: cfg?.seadream?.size,
      enhancePrompt: cfg?.seadream?.enhancePrompt,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "seedream_generate",
      payload: { input, output: out, timing, error: null },
    });

    const url = pickFirstUrl(out);
    if (!url) throw new Error("SEADREAM_NO_URL");

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    // ---- postscan ----
    await updateStatus({ supabase, generationId, status: "postscan" });
    emitStatus(generationId, "postscan");

    const tScan = Date.now();
    const outScan = await gptScanOutputStill({ cfg, ctx, imageUrl: remoteUrl });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_scan_output",
      payload: {
        ctx: ctx.output_scan,
        input: { imageUrl: remoteUrl },
        request: outScan.request,
        raw: outScan.raw,
        output: { still_crt: outScan.still_crt, userMessage: outScan.userMessage, parsed_ok: outScan.parsed_ok },
        timing: { started_at: new Date(tScan).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - tScan },
        error: null,
      },
    });

    working.scans = { ...(working.scans || {}), still_crt: outScan.still_crt || null };
    working = pushUserMessageLine(working, outScan.userMessage || pick(MMA_UI.quickLines.saved_image));
    working.userMessages = { ...(working.userMessages || {}), final_line: pick(MMA_UI.fallbacks.final) };

    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    console.error("[mma] still create pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    emitStatus(generationId, "error");
    sendDone(generationId, toUserStatus("error"));
  }
}

// ============================================================================
// STILL TWEAK PIPELINE
// ============================================================================
async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    emitStatus(generationId, "scanning");

    working = setCtxAudit(working, ctx);
    working.scans = { ...(working.scans || {}) };

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    // reuse still_crt if parent already has it
    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
    let stillCrt = safeStr(parentVars?.scans?.still_crt, "") || safeStr(parentVars?.still_crt, "");

    let stepNo = 1;

    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: parentUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_output_parent",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: parentUrl },
          request: scan.request,
          raw: scan.raw,
          output: { still_crt: scan.still_crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;
      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    } else {
      working.scans.still_crt = stillCrt || null;
      await updateVars({ supabase, generationId, vars: working });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    const t1 = Date.now();
    const fix = await gptFeedbackFixer({
      cfg,
      ctx,
      parentImageUrl: parentUrl,
      stillCrt,
      feedbackText,
      previousPrompt: safeStr(parent?.mg_prompt, ""),
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_feedback_still",
      payload: {
        ctx: ctx.feedback,
        input: {
          parent_image_url: parentUrl,
          still_crt: stillCrt,
          feedback: feedbackText,
          previous_prompt: safeStr(parent?.mg_prompt, ""),
          preferences: preferences || {},
        },
        request: fix.request,
        raw: fix.raw,
        output: { clean_prompt: fix.clean_prompt, parsed_ok: fix.parsed_ok },
        timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
        error: null,
      },
    });

    const usedPrompt = safeStr(fix.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_FEEDBACK_PROMPT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    working = pushUserMessageLine(working, pick(MMA_UI.fallbacks.thinking));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    const aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      cfg?.seadream?.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    const forcedInput = {
      prompt: usedPrompt,
      size: cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: !!cfg?.seadream?.enhancePrompt,
      sequential_image_generation: "disabled",
      max_images: 1,
      image_input: [parentUrl], // ✅ tweak spec: ONLY parent image
    };

    const t2 = Date.now();
    const { input, out: seedOut, timing } = await runSeedream({
      prompt: usedPrompt,
      aspectRatio,
      imageInputs: [parentUrl],
      size: cfg?.seadream?.size,
      enhancePrompt: cfg?.seadream?.enhancePrompt,
      input: forcedInput,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "seedream_generate_tweak",
      payload: { input, output: seedOut, timing, error: null },
    });

    const seedUrl = pickFirstUrl(seedOut);
    if (!seedUrl) throw new Error("SEADREAM_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(seedUrl, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await updateStatus({ supabase, generationId, status: "postscan" });
    emitStatus(generationId, "postscan");

    const t3 = Date.now();
    const scanNew = await gptScanOutputStill({ cfg, ctx, imageUrl: remoteUrl });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_scan_output",
      payload: {
        ctx: ctx.output_scan,
        input: { imageUrl: remoteUrl },
        request: scanNew.request,
        raw: scanNew.raw,
        output: { still_crt: scanNew.still_crt, userMessage: scanNew.userMessage, parsed_ok: scanNew.parsed_ok },
        timing: { started_at: new Date(t3).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t3 },
        error: null,
      },
    });

    working.scans = { ...(working.scans || {}), still_crt: scanNew.still_crt || stillCrt || "" };
    working = pushUserMessageLine(working, scanNew.userMessage || pick(MMA_UI.fallbacks.final));
    working.userMessages = { ...(working.userMessages || {}), final_line: pick(MMA_UI.fallbacks.final) };

    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    console.error("[mma] still tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    emitStatus(generationId, "error");
    sendDone(generationId, toUserStatus("error"));
  }
}

// ============================================================================
// VIDEO ANIMATE PIPELINE (Kling)
// ============================================================================
async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    emitStatus(generationId, "scanning");

    working = setCtxAudit(working, ctx);
    working.scans = { ...(working.scans || {}) };

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_animate_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage = pickKlingStartImage(working, parent);
    const endImage = pickKlingEndImage(working, parent);

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO");

    // keep for audit
    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    // still_crt reuse if parent has it
    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
    let stillCrt =
      safeStr(parentVars?.scans?.still_crt, "") ||
      safeStr(parentVars?.still_crt, "") ||
      safeStr(working?.scans?.still_crt, "");

    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: startImage });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_start_image",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: startImage },
          request: scan.request,
          raw: scan.raw,
          output: { still_crt: scan.still_crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;

      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    } else {
      working.scans.still_crt = stillCrt || null;
      await updateVars({ supabase, generationId, vars: working });
    }

    // ---- prompting ----
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    const motionBrief =
      safeStr(working?.inputs?.motion_user_brief, "") ||
      safeStr(working?.inputs?.motionBrief, "") ||
      safeStr(working?.inputs?.brief, "") ||
      safeStr(working?.inputs?.prompt, "");

    const movementStyle =
      safeStr(working?.inputs?.selected_movement_style, "") ||
      safeStr(working?.inputs?.movement_style, "") ||
      safeStr(working?.inputs?.movementStyle, "");

    const typeForMe =
      working?.inputs?.type_for_me === true ||
      working?.inputs?.typeForMe === true ||
      working?.inputs?.use_suggestion === true;

    const suggestOnly = working?.inputs?.suggest_only === true || working?.inputs?.suggestOnly === true;

    if (typeForMe) {
      const t1 = Date.now();
      const sugg = await gptMotionSuggestion({
        cfg,
        ctx,
        startImageUrl: startImage,
        endImageUrl: endImage,
        stillCrt,
        motionBrief,
        movementStyle,
      });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_motion_suggestion",
        payload: {
          ctx: ctx.motion_suggestion,
          input: {
            start_image_url: startImage,
            end_image_url: endImage || null,
            still_crt: stillCrt,
            motion_user_brief: motionBrief,
            selected_movement_style: movementStyle,
          },
          request: sugg.request,
          raw: sugg.raw,
          output: { sugg_prompt: sugg.sugg_prompt, userMessage: sugg.userMessage, parsed_ok: sugg.parsed_ok },
          timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
          error: null,
        },
      });

      working.prompts = { ...(working.prompts || {}), sugg_prompt: sugg.sugg_prompt || "" };
      working = pushUserMessageLine(working, sugg.userMessage || pick(MMA_UI.fallbacks.thinking));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);

      if (suggestOnly) {
        await supabase
          .from("mega_generations")
          .update({
            mg_status: "suggested",
            mg_mma_status: "suggested",
            mg_prompt: working?.prompts?.sugg_prompt || null,
            mg_updated_at: nowIso(),
          })
          .eq("mg_generation_id", generationId)
          .eq("mg_record_type", "generation");

        emitStatus(generationId, "suggested");
        sendDone(generationId, toUserStatus("suggested"));
        return;
      }
    }

    const providedSugg = safeStr(working?.inputs?.sugg_prompt || working?.inputs?.suggPrompt, "");
    const suggPrompt = providedSugg || safeStr(working?.prompts?.sugg_prompt, "");
    let finalMotionPrompt = suggPrompt;

    if (!finalMotionPrompt) {
      const t2 = Date.now();
      const rdr = await gptMotionReader2({
        cfg,
        ctx,
        startImageUrl: startImage,
        endImageUrl: endImage,
        stillCrt,
        motionBrief,
        movementStyle,
      });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_reader2_motion",
        payload: {
          ctx: ctx.motion_reader2,
          input: {
            start_image_url: startImage,
            end_image_url: endImage || null,
            still_crt: stillCrt,
            motion_user_brief: motionBrief,
            selected_movement_style: movementStyle,
          },
          request: rdr.request,
          raw: rdr.raw,
          output: { motion_prompt: rdr.motion_prompt, userMessage: rdr.userMessage, parsed_ok: rdr.parsed_ok },
          timing: { started_at: new Date(t2).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t2 },
          error: null,
        },
      });

      working.prompts = { ...(working.prompts || {}), motion_prompt: rdr.motion_prompt || "" };
      finalMotionPrompt = rdr.motion_prompt || "";

      working = pushUserMessageLine(working, rdr.userMessage || pick(MMA_UI.fallbacks.thinking));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    } else {
      working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
      await updateVars({ supabase, generationId, vars: working });
    }

    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_PROMPT");

    // ---- generating ----
    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    const duration = Number(working?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

    const t3 = Date.now();
    const { input, out, timing } = await runKling({
      prompt: finalMotionPrompt,
      startImage,
      endImage,
      duration,
      mode,
      negativePrompt: neg,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "kling_generate",
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("KLING_NO_URL");

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    working.userMessages = { ...(working.userMessages || {}), final_line: pick(MMA_UI.fallbacks.final) };
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    console.error("[mma] video animate pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    emitStatus(generationId, "error");
    sendDone(generationId, toUserStatus("error"));
  }
}

// ============================================================================
// VIDEO TWEAK PIPELINE (Kling)
// ============================================================================
async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    emitStatus(generationId, "scanning");

    working = setCtxAudit(working, ctx);
    working.scans = { ...(working.scans || {}) };

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};

    const startImage =
      asHttpUrl(working?.inputs?.start_image_url || working?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.parent_output_url || parentVars?.inputs?.parentOutputUrl) ||
      asHttpUrl(parent?.mg_output_url) ||
      "";

    const endImage =
      asHttpUrl(working?.inputs?.end_image_url || working?.inputs?.endImageUrl) ||
      asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl) ||
      "";

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO_TWEAK");

    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    // still_crt reuse or scan
    let stillCrt =
      safeStr(parentVars?.scans?.still_crt, "") ||
      safeStr(parentVars?.still_crt, "") ||
      safeStr(working?.scans?.still_crt, "");

    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: startImage });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_start_image",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: startImage },
          request: scan.request,
          raw: scan.raw,
          output: { still_crt: scan.still_crt, userMessage: scan.userMessage, parsed_ok: scan.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;

      working = pushUserMessageLine(working, scan.userMessage || pick(MMA_UI.fallbacks.scanned));
      await updateVars({ supabase, generationId, vars: working });
      emitLine(generationId, working);
    } else {
      working.scans.still_crt = stillCrt || null;
      await updateVars({ supabase, generationId, vars: working });
    }

    // ---- prompting ----
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    const motionBrief =
      safeStr(working?.inputs?.motion_user_brief, "") ||
      safeStr(parentVars?.inputs?.motion_user_brief, "") ||
      safeStr(parentVars?.inputs?.motionBrief, "") ||
      safeStr(parentVars?.inputs?.brief, "");

    const movementStyle =
      safeStr(working?.inputs?.selected_movement_style, "") ||
      safeStr(parentVars?.inputs?.selected_movement_style, "") ||
      safeStr(parentVars?.inputs?.movement_style, "") ||
      safeStr(parentVars?.inputs?.movementStyle, "");

    const feedbackMotion =
      safeStr(working?.feedback?.motion_feedback, "") ||
      safeStr(working?.feedback?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackMotion) throw new Error("MISSING_MOTION_FEEDBACK");

    const baseInput = {
      start_image_url: startImage,
      end_image_url: endImage || null,
      still_crt: stillCrt,
      motion_user_brief: motionBrief,
      selected_movement_style: movementStyle,
    };

    const prevMotionPrompt = safeStr(parentVars?.prompts?.motion_prompt, "") || safeStr(parent?.mg_prompt, "");

    const t1 = Date.now();
    const fix = await gptMotionFeedback2({
      cfg,
      ctx,
      startImageUrl: startImage,
      endImageUrl: endImage,
      baseInput,
      feedbackMotion,
      previousMotionPrompt: prevMotionPrompt,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_feedback2_motion",
      payload: {
        ctx: ctx.motion_feedback2,
        input: { ...baseInput, feedback_motion: feedbackMotion, previous_motion_prompt: prevMotionPrompt },
        request: fix.request,
        raw: fix.raw,
        output: { motion_prompt: fix.motion_prompt, parsed_ok: fix.parsed_ok },
        timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
        error: null,
      },
    });

    const finalMotionPrompt = safeStr(fix.motion_prompt, "");
    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_FEEDBACK_PROMPT");

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    working = pushUserMessageLine(working, pick(MMA_UI.fallbacks.thinking));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    // ---- generating ----
    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    const duration =
      Number(working?.inputs?.duration ?? parentVars?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) ||
      5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      safeStr(parentVars?.inputs?.kling_mode || parentVars?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      safeStr(parentVars?.inputs?.negative_prompt || parentVars?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

    const t2 = Date.now();
    const { input, out, timing } = await runKling({
      prompt: finalMotionPrompt,
      startImage,
      endImage,
      duration,
      mode,
      negativePrompt: neg,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "kling_generate_tweak",
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("KLING_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    working.userMessages = { ...(working.userMessages || {}), final_line: pick(MMA_UI.fallbacks.final) };

    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    console.error("[mma] video tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    emitStatus(generationId, "error");
    sendDone(generationId, toUserStatus("error"));
  }
}

// ============================================================================
// Public handlers
// ============================================================================
export async function handleMmaStillTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "still",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  // ✅ HISTORY COMPAT: reuse parent session if possible
  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Image session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "still_tweak" },
  });

  vars.meta = { ...(vars.meta || {}), flow: "still_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent?.mg_output_url || null };

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "still",
  });

  runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }).catch((e) =>
    console.error("[mma] still tweak pipeline error", e)
  );

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaVideoTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const generationId = newUuid();

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "video",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Image session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "video_tweak" },
  });

  vars.meta = { ...(vars.meta || {}), flow: "video_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_generation_id: parentGenerationId };

  // keep parent start/end images if present (audit + consistent tweak)
  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const parentStart = asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl);
  const parentEnd = asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl);

  if (parentStart) vars.inputs.start_image_url = parentStart;
  if (parentEnd) vars.inputs.end_image_url = parentEnd;

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "video",
  });

  runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }).catch((err) => {
    console.error("[mma] video tweak pipeline error", err);
  });

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentId =
    body?.parent_generation_id ||
    body?.parentGenerationId ||
    body?.generation_id ||
    null;

  // If video and we have a parent, fetch parent early so we can reuse session/platform/title
  const parent = mode === "video" && parentId ? await fetchParentGenerationRow(supabase, parentId) : null;

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode,
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  // ✅ HISTORY COMPAT: ALWAYS set session/platform/title
  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    (parent ? safeStr(parent?.mg_session_id, "") : "") ||
    newUuid();

  const platform =
    safeStr(body?.platform || body?.inputs?.platform, "") || (parent ? safeStr(parent?.mg_platform, "") : "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") ||
    (parent ? safeStr(parent?.mg_title, "") : "") ||
    (mode === "video" ? "Video session" : "Image session");

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: mode === "video" ? "video_animate" : "still_create" },
  });

  // Set meta flow BEFORE writeGeneration (so it’s persisted immediately)
  if (mode === "still") {
    vars.meta = { ...(vars.meta || {}), flow: "still_create" };
  } else if (mode === "video") {
    vars.meta = { ...(vars.meta || {}), flow: "video_animate", parent_generation_id: parentId || null };
    if (parent?.mg_output_url) {
      vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent.mg_output_url };
    }
  }

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  if (mode === "still") {
    await updateVars({ supabase, generationId, vars });

    runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }).catch((err) =>
      console.error("[mma] still create pipeline error", err)
    );
  } else if (mode === "video") {
    await updateVars({ supabase, generationId, vars });

    runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }).catch((err) =>
      console.error("[mma] video animate pipeline error", err)
    );
  } else {
    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "BAD_MODE", message: `Unsupported mode: ${mode}` },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");
  }

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaEvent(body) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventType = safeStr(body?.event_type || body?.eventType, "unknown");
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};

  const generationId = safeStr(body?.generation_id || body?.generationId || payload?.generation_id || payload?.generationId, "");

  // ✅ IMPORTANT: like/dislike MUST be stored as a single feedback row (prevents history duplicates)
  if (eventType === "like" || eventType === "dislike") {
    const liked = eventType === "like" ? true : false;

    await upsertFeedbackRow({
      supabase,
      passId,
      generationId,
      liked,
      payload,
    });

    // preference updates (kept minimal like you had)
    if (payload?.hard_block) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_mma_preferences")
        .eq("mg_pass_id", passId)
        .maybeSingle();

      const prefs = data?.mg_mma_preferences || {};
      const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
      const tagWeights = { ...(prefs.tag_weights || {}) };

      hardBlocks.add(payload.hard_block);
      tagWeights[payload.hard_block] = -999;

      await supabase
        .from("mega_customers")
        .update({
          mg_mma_preferences: { ...prefs, hard_blocks: Array.from(hardBlocks), tag_weights: tagWeights },
          mg_mma_preferences_updated_at: nowIso(),
          mg_updated_at: nowIso(),
        })
        .eq("mg_pass_id", passId);
    }

    return { event_id: null, status: "ok" };
  }

  // Other events: store as normal event rows
  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: generationId || null,
    mg_pass_id: passId,
    mg_parent_id: generationId ? `generation:${generationId}` : null,
    mg_meta: { event_type: eventType || "unknown", payload: payload || {} },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });

  // preference updates kept minimal here (same logic you had)
  if (eventType === "preference_set") {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences || {};
    const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
    const tagWeights = { ...(prefs.tag_weights || {}) };

    if (payload?.hard_block) {
      hardBlocks.add(payload.hard_block);
      tagWeights[payload.hard_block] = -999;
    }

    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: { ...prefs, hard_blocks: Array.from(hardBlocks), tag_weights: tagWeights },
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  }

  return { event_id: eventId, status: "ok" };
}

// ============================================================================
// Fetch + admin helpers
// ============================================================================
export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error, mg_mma_mode")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: toUserStatus(data.mg_mma_status || data.mg_status),
    mma_vars: data.mg_mma_vars || {},
    outputs: {
      seedream_image_url: data.mg_mma_mode === "still" ? data.mg_output_url : null,
      kling_video_url: data.mg_mma_mode === "video" ? data.mg_output_url : null,
    },
    prompt: data.mg_prompt || null,
    error: data.mg_error || null,
  };
}

export async function listSteps(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "mma_step")
    .order("mg_step_no", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function listErrors() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_admin")
    .select("*")
    .eq("mg_record_type", "error")
    .order("mg_created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}

// ============================================================================
// Router factory
// ============================================================================
export function createMmaController() {
  const router = express.Router();

  router.post("/still/create", async (req, res) => {
    try {
      const result = await handleMmaCreate({ mode: "still", body: req.body });
      res.json(result);
    } catch (err) {
      console.error("[mma] still/create error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] still tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      const result = await handleMmaCreate({ mode: "video", body: req.body });
      res.json(result);
    } catch (err) {
      console.error("[mma] video/animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const result = await handleMmaEvent(req.body || {});
      res.json(result);
    } catch (err) {
      console.error("[mma] events error", err);
      res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      const payload = await fetchGeneration(req.params.generation_id);
      if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
      res.json(payload);
    } catch (err) {
      console.error("[mma] fetch generation error", err);
      res.status(500).json({ error: "MMA_FETCH_FAILED", message: err?.message });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(500).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders?.();

    const { data } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const status = toUserStatus(data?.mg_mma_status || "queued"); // ✅ don’t leak internal status

    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));
    registerSseClient(req.params.generation_id, res, { scanLines, status });
  });

  router.get("/admin/mma/errors", async (_req, res) => {
    try {
      const errors = await listErrors();
      res.json({ errors });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
    }
  });

  router.get("/admin/mma/steps/:generation_id", async (req, res) => {
    try {
      const steps = await listSteps(req.params.generation_id);
      res.json({ steps });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
    }
  });

  return router;
}

export default createMmaController;
