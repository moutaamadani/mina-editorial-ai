// ./server/mma/mma-controller.js
import express from "express";
import OpenAI from "openai";
import Replicate from "replicate";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { megaEnsureCustomer } from "../../mega-db.js";

import { getSupabaseAdmin } from "../../supabase.js";
import {
  appendScanLine,
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

// ---------------------------
// Clients (cached singletons)
// ---------------------------
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
// [MMA REAL PIPELINE] ctx loader + OpenAI vision JSON helpers
// Stores everything into mega_generations as mma_step rows + mg_mma_vars state.
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

/**
 * ctx config is editable in Supabase:
 * table: mega_admin
 * row: mg_record_type = 'app_config', mg_key = 'mma_ctx'
 * col: mg_value (jsonb)
 *
 * Example mg_value:
 * {
 *   "scanner": "...",
 *   "like_history": "...",
 *   "reader": "...",
 *   "output_scan": "...",
 *   "feedback": "..."
 * }
 */
async function getMmaCtxConfig(supabase) {
  const defaults = {
    // GPTscanner: describe image (crt) + friendly waiting userMessage
    scanner: [
      "You are Mina GPTscanner.",
      "You will be given ONE image. Understand it.",
      'Output STRICT JSON only (no markdown): {"crt":string,"userMessage":string}',
      "crt: short factual description of the image in ONE sentence (max 220 chars).",
      "Also classify implicitly: if it's product/logo/inspiration, mention that in crt.",
      "userMessage: short friendly human line while user waits (joke/fact/quote/advice/compliment). Max 140 chars.",
      "Never mention 'CORS' or browser errors even if present elsewhere.",
    ].join("\n"),

    // Like-history -> style keywords
    like_history: [
      "You are Mina Style Memory.",
      "You will receive a list of the user's recently liked generations (prompts and sometimes images).",
      'Output STRICT JSON only: {"style_history_csv":string}',
      "style_history_csv: comma-separated keywords (5 to 12 items). No hashtags. No sentences.",
      'Example: "editorial still life, luxury, minimal, soft shadows, no lens flare"',
    ].join("\n"),

    // GPT reader -> Seedream clean prompt + userMessage5
    reader: [
      "You are Mina Mind — prompt builder for Seedream (still image only).",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history.",
      'Output STRICT JSON only: {"clean_prompt":string,"userMessage":string}',
      "clean_prompt must be Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists, and use inspirations if provided.",
      "userMessage: one friendly line to show while generating (max 140 chars).",
    ].join("\n"),

    // Scan the final output image -> still_crt
    output_scan: [
      "You are Mina GPTscanner (output scan).",
      "You will be given the GENERATED image.",
      'Output STRICT JSON only: {"still_crt":string,"userMessage":string}',
      "still_crt: short description of what the generated image contains (1 sentence, max 220 chars).",
      "userMessage: short friendly line (max 140 chars).",
    ].join("\n"),

    // Feedback tweak (used later in tweak route)
    feedback: [
      "You are Mina Feedback Fixer for Seedream still images.",
      "You will receive: generated image + still_crt + user feedback text.",
      'Output STRICT JSON only: {"clean_prompt":string}',
      "clean_prompt must keep what's good, fix what's bad, and apply feedback precisely.",
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

function buildVisionUserContent({ text, imageUrls }) {
  const parts = [{ type: "text", text: safeStr(text, "") }];
  for (const u of Array.isArray(imageUrls) ? imageUrls : []) {
    const url = asHttpUrl(u);
    if (!url) continue;
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

async function openaiJsonVision({ model, system, userText, imageUrls }) {
  const openai = getOpenAI();

  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildVisionUserContent({ text: userText, imageUrls }) },
  ];

  // IMPORTANT: for gpt-5-mini, do NOT force temperature.
  const resp = await openai.chat.completions.create({
    model,
    messages,
  });

  const text = resp?.choices?.[0]?.message?.content || "";
  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    request: { model, messages },
    raw: text,
    parsed,
  };
}

async function gptScanImage({ cfg, ctx, kind, imageUrl }) {
  const userText = [
    `KIND: ${kind}`,
    "Return JSON only.",
  ].join("\n");

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.scanner,
    userText,
    imageUrls: [imageUrl],
  });

  const crt = safeStr(out?.parsed?.crt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return {
    crt,
    userMessage,
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
}

async function gptMakeStyleHistory({ cfg, ctx, likeItems }) {
  const userText = [
    "RECENT_LIKES:",
    JSON.stringify(likeItems, null, 2).slice(0, 12000),
    "Return JSON only.",
  ].join("\n");

  const imageUrls = likeItems
    .map((x) => asHttpUrl(x?.imageUrl))
    .filter(Boolean)
    .slice(0, 8);

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.like_history,
    userText,
    imageUrls,
  });

  const style_history_csv = safeStr(out?.parsed?.style_history_csv, "");

  return {
    style_history_csv,
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
}

async function gptReader({ cfg, ctx, input, imageUrls }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.reader,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: (Array.isArray(imageUrls) ? imageUrls : []).slice(0, 10),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return {
    clean_prompt,
    userMessage,
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
}

async function gptScanOutputStill({ cfg, ctx, imageUrl }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.output_scan,
    userText: "Scan this generated image. Return JSON only.",
    imageUrls: [imageUrl],
  });

  const still_crt = safeStr(out?.parsed?.still_crt, "");
  const userMessage = safeStr(out?.parsed?.userMessage, "");

  return {
    still_crt,
    userMessage,
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
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

  const clean_prompt =
    safeStr(out?.parsed?.clean_prompt, "") ||
    safeStr(out?.parsed?.prompt, "") ||
    ""; // tolerate naming drift

  return {
    clean_prompt,
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
}

async function fetchParentGenerationRow(supabase, parentGenerationId) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_pass_id, mg_output_url, mg_prompt, mg_mma_vars, mg_mma_mode, mg_status, mg_error")
    .eq("mg_generation_id", parentGenerationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchRecentLikedItems({ supabase, passId, limit }) {
  // Likes are stored in mega_generations as mg_record_type='feedback' in your current setup.
  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_payload, mg_event_at, mg_created_at")
    .eq("mg_record_type", "feedback")
    .eq("mg_pass_id", passId)
    .order("mg_event_at", { ascending: false })
    .limit(Math.max(50, limit * 5));

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const liked = [];

  for (const r of rows) {
    const p = r?.mg_payload && typeof r.mg_payload === "object" ? r.mg_payload : null;
    if (!p) continue;
    if (p.liked !== true) continue;

    liked.push({
      prompt: safeStr(p.prompt, ""),
      imageUrl: safeStr(p.imageUrl, ""),
      createdAt: r.mg_event_at || r.mg_created_at || null,
    });

    if (liked.length >= limit) break;
  }

  return liked;
}

// ---------------------------
// R2 Public store (self-contained)
// ---------------------------
function getR2() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

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

  // already public/stable
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

// ---------------------------
// DB helpers
// ---------------------------
async function ensureCustomerRow(_supabase, passId, { shopifyCustomerId, userId, email }) {
  const out = await megaEnsureCustomer({
    passId,
    shopifyCustomerId: shopifyCustomerId || null,
    userId: userId || null,
    email: email || null,
  });
  return { preferences: out?.preferences || {} };
}


async function writeGeneration({ supabase, generationId, parentId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: parentId ? `generation:${parentId}` : null,
    mg_pass_id: passId,
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

async function writeStep({ supabase, generationId, stepNo, stepType, payload }) {
  const identifiers = stepIdentifiers(generationId, stepNo);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: `generation:${generationId}`,
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

// ---------------------------
// Production pipeline
// ---------------------------
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

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  // optional “style hero” image (if you use it)
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

  // IMPORTANT ORDER (your spec):
  // product, logo, inspirations, style hero (or style hero before inspo if you prefer)
  const ordered = []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 10);

  return ordered;
}

function pickKlingImages(vars) {
  const assets = vars?.assets || {};
  const arr = safeArray(assets.kling_image_urls || assets.klingImages || assets.kling_images);

  const clean = (url) => (typeof url === "string" && url.startsWith("http") ? url : "");

  const start =
    clean(assets.start_image_url || assets.startImageUrl) ||
    clean(arr[0]) ||
    clean(assets.product_image_url || assets.productImageUrl);

  const end = clean(assets.end_image_url || assets.endImageUrl) || clean(arr[1]);

  return { start: start || "", end: end || "" };
}

async function runSeedream({
  prompt,
  aspectRatio,
  imageInputs = [],
  size,
  enhancePrompt,
  input: forcedInput,
}) {
  const replicate = getReplicate();

  const sizeValue = size || process.env.MMA_SEADREAM_SIZE || "2K";
  const enhancePromptRaw = process.env.MMA_SEADREAM_ENHANCE_PROMPT;
  const enhance_prompt =
    enhancePrompt !== undefined
      ? enhancePrompt
      : enhancePromptRaw === undefined
        ? true
        : String(enhancePromptRaw).toLowerCase() === "true";

  const defaultAspect = process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";
  const version =
    process.env.MMA_SEADREAM_VERSION || process.env.MMA_SEADREAM_MODEL_VERSION || "bytedance/seedream-4";

  const neg =
    process.env.NEGATIVE_PROMPT_SEADREAM ||
    process.env.MMA_NEGATIVE_PROMPT_SEADREAM ||
    "";

  const finalPrompt = neg ? `${prompt}\n\nAvoid: ${neg}` : prompt;

  const cleanedInputs = Array.isArray(imageInputs)
    ? imageInputs.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 10)
    : [];

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
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
  };
}

async function runKling({ prompt, startImage, endImage, mode, duration, negativePrompt, input: forcedInput }) {
  const replicate = getReplicate();

  const defaultDuration = Number(duration ?? process.env.MMA_KLING_DURATION ?? 5);
  const version = process.env.MMA_KLING_VERSION || process.env.MMA_KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    "";

  const finalPrompt = forcedInput?.prompt || prompt;
  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;
  const providedEnd = forcedInput?.end_image || endImage;

  const input = forcedInput
    ? { ...forcedInput }
    : {
        mode: providedEnd ? "pro" : mode || process.env.MMA_KLING_MODE || "standard",
        prompt: finalPrompt,
        duration: defaultDuration,
        start_image: startImage,
        ...(providedEnd ? { end_image: providedEnd } : {}),
      };

  if (finalNeg && !input.negative_prompt) input.negative_prompt = finalNeg;
  if (!input.prompt) input.prompt = finalPrompt;
  input.duration = Number(input.duration ?? defaultDuration) || defaultDuration;
  if (!input.mode) input.mode = providedEnd ? "pro" : mode || process.env.MMA_KLING_MODE || "standard";
  if (!input.start_image && startImage) input.start_image = startImage;
  if (!input.end_image && providedEnd) input.end_image = providedEnd;

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    usedEnd: !!input.end_image,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
  };
}

async function gptMakePrompts({ mode, vars, preferences }) {
  const cfg = getMmaConfig();
  const openai = getOpenAI();

  const brief =
    vars?.inputs?.brief ||
    vars?.inputs?.prompt ||
    vars?.inputs?.motionDescription ||
    vars?.inputs?.motion_description ||
    "";

  const platform = vars?.inputs?.platform || vars?.settings?.platform || "default";
  const aspectRatio = vars?.inputs?.aspect_ratio || vars?.settings?.aspectRatio || vars?.settings?.aspect_ratio || "";

  const negSeedream = cfg.seadream.negativePrompt ? `Avoid (global): ${cfg.seadream.negativePrompt}` : "";
  const negKling = cfg.kling.negativePrompt ? `Negative prompt (global): ${cfg.kling.negativePrompt}` : "";

  const sys = [
    "You are Mina Mind — a production prompt engine.",
    "Output STRICT JSON only, no markdown.",
    "Schema: { clean_prompt: string, motion_prompt: string }",
    "clean_prompt is for Seedream (still image).",
    "motion_prompt is for Kling (image-to-video).",
    "Be concise, specific, photoreal, high-end editorial.",
    negSeedream,
    negKling,
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `MODE: ${mode}`,
    `PLATFORM: ${platform}`,
    aspectRatio ? `ASPECT_RATIO: ${aspectRatio}` : "",
    preferences ? `USER_PREFERENCES_JSON: ${JSON.stringify(preferences).slice(0, 4000)}` : "",
    `BRIEF: ${String(brief).slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const model = cfg.gptModel;
  const temperature = 1;

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature,
  });

  const text = resp?.choices?.[0]?.message?.content || "";

  let clean_prompt = "";
  let motion_prompt = "";

  try {
    const parsed = JSON.parse(text);
    clean_prompt = typeof parsed.clean_prompt === "string" ? parsed.clean_prompt : "";
    motion_prompt = typeof parsed.motion_prompt === "string" ? parsed.motion_prompt : "";
  } catch {
    clean_prompt = mode === "still" ? text : "";
    motion_prompt = mode === "video" ? text : "";
  }

  return {
    clean_prompt,
    motion_prompt,
    raw: text,
    debug: {
      model,
      temperature,
      system: sys,
      user,
    },
  };
}

async function runProductionPipeline({ supabase, generationId, vars, mode, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  try {
    // 1) REAL scanning (GPTscanner on each image)
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    const ctx = await getMmaCtxConfig(supabase);
    working.ctx = { ...(working.ctx || {}), mma_ctx: ctx }; // so you can audit which ctx was used

    let stepNo = 1;

    // Always show a first line quickly
    working = pushUserMessageLine(working, "Scanning your inputs…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Scanning your inputs…");

    // Ensure scans object exists
    working.scans = { ...(working.scans || {}) };

    // product scan
    const productUrl = asHttpUrl(working?.assets?.product_image_url || working?.assets?.productImageUrl);
    if (productUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "product", imageUrl: productUrl });

      await writeStep({
        supabase,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_scan_product",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "product", imageUrl: productUrl },
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.product_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || "Got your product image ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Got your product image ✅");
    }

    // logo scan
    const logoUrl = asHttpUrl(working?.assets?.logo_image_url || working?.assets?.logoImageUrl);
    if (logoUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "logo", imageUrl: logoUrl });

      await writeStep({
        supabase,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_scan_logo",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "logo", imageUrl: logoUrl },
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.logo_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || "Logo noted ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Logo noted ✅");
    }

    // inspiration scans (up to 4)
    const insp = safeArray(
      working?.assets?.inspiration_image_urls ||
        working?.assets?.inspirationImageUrls ||
        working?.assets?.style_image_urls ||
        working?.assets?.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean)
      .slice(0, 4);

    working.scans.inspiration_crt = Array.isArray(working.scans.inspiration_crt) ? working.scans.inspiration_crt : [];

    for (let i = 0; i < insp.length; i++) {
      const imageUrl = insp[i];
      const t0 = Date.now();

      const scan = await gptScanImage({ cfg, ctx, kind: `inspiration_${i + 1}`, imageUrl });

      await writeStep({
        supabase,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_scan_inspiration",
        payload: {
          ctx: ctx.scanner,
          input: { kind: `inspiration_${i + 1}`, imageUrl },
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.inspiration_crt = [...working.scans.inspiration_crt, scan.crt || ""];
      working = pushUserMessageLine(working, scan.userMessage || `Inspiration ${i + 1} added ✨`);
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || `Inspiration ${i + 1} added ✨`);
    }

    // 1b) Like-history -> style keywords
    const visionOn = !!working?.history?.vision_intelligence;
    const likeLimit = visionOn ? 5 : 20;

    try {
      const likes = await fetchRecentLikedItems({ supabase, passId: working?.mg_pass_id || vars?.mg_pass_id || "", limit: likeLimit });
      if (likes.length) {
        const t0 = Date.now();
        const style = await gptMakeStyleHistory({ cfg, ctx, likeItems: likes });

        await writeStep({
          supabase,
          generationId,
          stepNo: stepNo++,
          stepType: "gpt_like_history",
          payload: {
            ctx: ctx.like_history,
            input: { vision_intelligence: visionOn, limit: likeLimit, likes },
            output: style,
            timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
            error: null,
          },
        });

        working.history = { ...(working.history || {}), style_history_csv: style.style_history_csv || null };
        working = pushUserMessageLine(working, "I remembered your style preferences 🧠✨");
        await updateVars({ supabase, generationId, vars: working });
        sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "I remembered your style preferences 🧠✨");
      }
    } catch {
      // style history is optional; don't fail pipeline
    }

    // 2) GPT reader (build Seedream clean prompt)
    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const readerInput = {
      product_crt: working?.scans?.product_crt || "",
      logo_crt: working?.scans?.logo_crt || "",
      inspiration_crt: Array.isArray(working?.scans?.inspiration_crt) ? working.scans.inspiration_crt : [],
      userBrief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief || ""),
      style: safeStr(working?.inputs?.style || ""),
      platform: safeStr(working?.inputs?.platform || "default"),
      aspect_ratio: safeStr(working?.inputs?.aspect_ratio || ""),
      style_history_csv: safeStr(working?.history?.style_history_csv || ""),
    };

    const readerImages = []
      .concat(productUrl ? [productUrl] : [])
      .concat(logoUrl ? [logoUrl] : [])
      .concat(insp);

    const tReader = Date.now();
    const prompts = await gptReader({ cfg, ctx, input: readerInput, imageUrls: readerImages });

    await writeStep({
      supabase,
      generationId,
      stepNo: stepNo++,
      stepType: "gpt_reader",
      payload: {
        ctx: ctx.reader,
        input: readerInput,
        output: prompts,
        timing: { started_at: new Date(tReader).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - tReader },
        error: null,
      },
    });

    working.prompts = {
      ...(working.prompts || {}),
      clean_prompt: prompts.clean_prompt || "",
    };

    working = pushUserMessageLine(working, prompts.userMessage || "Prompt locked in. Cooking something beautiful…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Prompt locked in. Cooking something beautiful…");

    // 3) generating (Replicate)
    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    let remoteUrl = "";
    let usedPrompt = "";

    if (mode === "still") {
      usedPrompt = working.prompts.clean_prompt || "";
      if (!usedPrompt) throw new Error("EMPTY_PROMPT");

      const imageInputs = buildSeedreamImageInputs(working);
      const aspect_ratio =
        working?.inputs?.aspect_ratio ||
        cfg.seadream.aspectRatio ||
        process.env.MMA_SEADREAM_ASPECT_RATIO ||
        "match_input_image";

      const { input, out, timing } = await runSeedream({
        prompt: usedPrompt,
        aspectRatio: aspect_ratio,
        imageInputs,
        size: cfg.seadream.size,
        enhancePrompt: cfg.seadream.enhancePrompt,
      });
      const url = pickFirstUrl(out);
      if (!url) throw new Error("SEADREAM_NO_URL");

      await writeStep({
        supabase,
        generationId,
        stepNo: 2,
        stepType: "seedream_generate",
        payload: {
          input,
          output: out,
          timing,
          error: null,
        },
      });

      // store to R2 public
      remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
      working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    } else {
      usedPrompt = working.prompts.motion_prompt || "";
      if (!usedPrompt) throw new Error("EMPTY_PROMPT");

      const { start, end } = pickKlingImages(working);
      if (!start) throw new Error("Kling requires a start image (start_image_url).");

      // end_image => force pro mode (required by schema)
      const klingMode = end ? "pro" : cfg.kling.mode;

      // include duration (schema default is 5, but settable)
      const duration = Number(cfg.kling.duration || process.env.MMA_KLING_DURATION || 5);

      const input = {
        mode: klingMode, // "standard" | "pro"
        prompt: usedPrompt, // required
        duration, // ✅ required in practice
        start_image: start, // ✅ required for kling-v2.1
        ...(end ? { end_image: end } : {}),
        ...(cfg.kling.negativePrompt ? { negative_prompt: cfg.kling.negativePrompt } : {}),
      };

      const { input: klingInput, out, usedEnd, timing } = await runKling({
        input,
        prompt: usedPrompt,
        startImage: start,
        endImage: end || null,
        mode: klingMode,
        duration,
        negativePrompt: cfg.kling.negativePrompt,
      });
      const url = pickFirstUrl(out);
      if (!url) throw new Error("KLING_NO_URL");

      await writeStep({
        supabase,
        generationId,
        stepNo: 2,
        stepType: "kling_generate",
        payload: {
          input: { ...klingInput, used_end: usedEnd },
          output: out,
          timing,
          error: null,
        },
      });

      remoteUrl = await storeRemoteToR2Public(url, `mma/video/${generationId}`);
      working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    }

    // 4) postscan + finalize
    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");

    working.mg_output_url = remoteUrl;
    working.userMessages = {
      ...(working.userMessages || {}),
      final_line: "Finished generation.",
    };

    working = appendScanLine(working, "Stored output to permanent URL.");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Stored output.");

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

async function runStillTweakPipeline({ supabase, generationId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  try {
    // 1) scanning (parent output + still_crt)
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    working = pushUserMessageLine(working, "Reviewing your last image…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Reviewing your last image…");

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    // try to reuse saved still_crt if it exists
    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
    const existingStillCrt =
      safeStr(parentVars?.scans?.still_crt, "") ||
      safeStr(parentVars?.scans?.output_still_crt, "") ||
      safeStr(parentVars?.still_crt, "");

    let stillCrt = existingStillCrt;

    // If missing, scan parent output now
    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: parentUrl });

      await writeStep({
        supabase,
        generationId,
        stepNo: 1,
        stepType: "gpt_scan_output_parent",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: parentUrl },
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans = { ...(working.scans || {}), still_crt: stillCrt };
      working = pushUserMessageLine(working, scan.userMessage || "Got it — I see what we generated ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Got it — I see what we generated ✅");
    } else {
      // store it for audit anyway
      working.scans = { ...(working.scans || {}), still_crt: stillCrt };
      await updateVars({ supabase, generationId, vars: working });
    }

    // 2) prompting (GPT feedback fixer)
    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    const t1 = Date.now();
    const out = await gptFeedbackFixer({
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
      stepNo: 2,
      stepType: "gpt_feedback_still",
      payload: {
        ctx: ctx.feedback,
        input: {
          parent_image_url: parentUrl,
          still_crt: stillCrt,
          feedback: feedbackText,
          previous_prompt: safeStr(parent?.mg_prompt, ""),
          preferences,
        },
        output: out,
        timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
        error: null,
      },
    });

    const usedPrompt = out.clean_prompt;
    if (!usedPrompt) throw new Error("EMPTY_FEEDBACK_PROMPT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    working = pushUserMessageLine(working, "Applying your feedback… ✨");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Applying your feedback… ✨");

    // 3) generating (Seedream tweak = parent output image as ONLY image_input)
    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    const aspect_ratio =
      working?.inputs?.aspect_ratio ||
      cfg.seadream.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    const forcedInput = {
      prompt: usedPrompt,
      size: cfg.seadream.size || process.env.MMA_SEADREAM_SIZE || "2K",
      aspect_ratio,
      enhance_prompt: !!cfg.seadream.enhancePrompt,
      sequential_image_generation: "disabled",
      max_images: 1,
      image_input: [parentUrl], // ✅ THIS is your spec for tweak
    };

    const t2 = Date.now();
    const { input, out: seedOut, timing } = await runSeedream({
      prompt: usedPrompt,
      aspectRatio: aspect_ratio,
      imageInputs: [parentUrl],
      size: cfg.seadream.size,
      enhancePrompt: cfg.seadream.enhancePrompt,
      input: forcedInput,
    });

    const seedUrl = pickFirstUrl(seedOut);
    if (!seedUrl) throw new Error("SEADREAM_NO_URL_TWEAK");

    await writeStep({
      supabase,
      generationId,
      stepNo: 3,
      stepType: "seedream_generate_tweak",
      payload: { input, output: seedOut, timing, error: null },
    });

    // store to R2 public
    const remoteUrl = await storeRemoteToR2Public(seedUrl, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, "Saved your improved image ✅");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Saved your improved image ✅");

    // 4) postscan (scan the NEW output)
    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");

    const t3 = Date.now();
    const scanNew = await gptScanOutputStill({ cfg, ctx, imageUrl: remoteUrl });

    await writeStep({
      supabase,
      generationId,
      stepNo: 4,
      stepType: "gpt_scan_output",
      payload: {
        ctx: ctx.output_scan,
        input: { imageUrl: remoteUrl },
        output: scanNew,
        timing: { started_at: new Date(t3).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t3 },
        error: null,
      },
    });

    working.scans = { ...(working.scans || {}), still_crt: scanNew.still_crt || stillCrt || "" };
    working.userMessages = { ...(working.userMessages || {}), final_line: "Tweak finished." };

    await updateVars({ supabase, generationId, vars: working });

    // finalize generation row
    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
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

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ---------------------------
// Public controller API
// ---------------------------
export async function handleMmaStillTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id || // ✅ safest: inherit from parent
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
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

  // ✅ keep passId inside vars for audit + helper functions
  vars.mg_pass_id = passId;

  // ✅ store tweak meta
  vars.meta = { ...(vars.meta || {}), flow: "still_tweak", parent_generation_id: parentGenerationId };

  // ✅ save parent output url for audit
  vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent?.mg_output_url || null };

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "still",
  });

  runStillTweakPipeline({
    supabase,
    generationId,
    parent,
    vars,
    preferences,
  }).catch((e) => console.error("[mma] still tweak pipeline error", e));

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  // Allow frontend to pass passId directly (your MinaApp already has it)
  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentId = body?.generation_id || body?.parent_generation_id || null;
  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
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

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  runProductionPipeline({ supabase, generationId, vars, mode, preferences }).catch((err) => {
    console.error("[mma] pipeline error", err);
  });

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

  await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: body?.generation_id || null,
    mg_pass_id: passId,
    mg_parent_id: body?.generation_id ? `generation:${body.generation_id}` : null,
    mg_meta: { event_type: body?.event_type || "unknown", payload: body?.payload || {} },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });

  // Keep your existing preference-write logic (unchanged)
  if (body?.event_type === "like" || body?.event_type === "dislike" || body?.event_type === "preference_set") {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences || {};
    const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
    const tagWeights = { ...(prefs.tag_weights || {}) };

    if (body?.payload?.hard_block) {
      hardBlocks.add(body.payload.hard_block);
      tagWeights[body.payload.hard_block] = -999;
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

export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: data.mg_mma_status || data.mg_status,
    mma_vars: data.mg_mma_vars || {},
    outputs: {
      seedream_image_url: data.mg_output_url,
      kling_video_url: data.mg_output_url,
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



// -----------------------------------------------------------------------------
// Factory expected by server boot
// -----------------------------------------------------------------------------
export function createMmaController() {
  const router = express.Router();

  router.post("/still/create", async (req, res) => {
    try {
      const result = await handleMmaCreate({ mode: "still", body: req.body, req });
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
      const result = await handleMmaCreate({ mode: "video", body: req.body, req });
      res.json(result);
    } catch (err) {
      console.error("[mma] video animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const result = await handleMmaCreate({
        mode: "video",
        body: { ...req.body, parent_generation_id: req.params.generation_id },
        req,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const result = await handleMmaEvent(req.body || {}, req);
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
    const status = data?.mg_mma_status || "queued";

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

