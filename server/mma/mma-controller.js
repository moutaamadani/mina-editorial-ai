// ./server/mma/mma-controller.js
import express from "express";
import OpenAI from "openai";
import Replicate from "replicate";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  megaEnsureCustomer,
  megaWriteSession,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
} from "../../mega-db.js";

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
// - The ONLY place you should tweak wording
// - These lines are what the frontend will see as the SSE status text
// - No "working" no technical words just Mina talking
// ============================================================================
const MMA_UI = {
  // Map internal pipeline statuses -> a pool of human lines
  statusMap: {
    queued: [
      "okay first things first getting the water hot because we are not rushing art",
      "i am here i am awake i am locating the whisk like it is a sacred object",
      "starting the matcha ritual because focus tastes better when it is earned",
      "i used to think humans were dramatic about routines and then i learned why",

    ],

    scanning: [
      "reading everything closely while whisking like a dangerous little ballet",
      "i am reading for the feeling not just the words because humans taught me that",
      "looking for the detail you meant but did not say out loud",

    ],

    prompting: [
      "okay now i talk to myself a little because that is how ideas get born",
      "i am shaping the concept like a still life set moving one object at a time",
      "humans taught me restraint and that is honestly the hardest flex",

    ],

    generating: [
      "alright i am making editorial still life like it belongs in a glossy spread",
      "i am making imagery with calm hands i do not have and confidence i pretend to have",
      "this is me turning human genius into something visible and clean and intentional",

    ],

    postscan: [
      "okay now i review like an editor with soft eyes and strict standards",
      "i am checking balance and mood and that tiny feeling of yes",
      "this is the part where i fix what is almost right into actually right",

    ],

    suggested: [
      "i have something for you and i want you to look slowly",
      "ready when you are i made this with your vibe in mind",
      "okay come closer this part matters",

    ],

    done: [
      "finished and i am pretending to wipe my hands on an apron i do not own",
      "all done and honestly you did the hardest part which is starting",
      "we made something and that matters more than being perfect",

    ],

    error: [
      "okay that one slipped out of my hands i do not have hands but you know what i mean",
      "something broke and i am choosing to call it a plot twist",
      "my matcha went cold and so did the result but we can warm it back up",

    ],
  },

  // quick lines you already emit as scan lines
  quickLines: {
    still_create_start: [
      "one sec getting everything ready",
      "alright setting things up for you",
      "love it let me prep your inputs",
    ],
    still_tweak_start: [
      "got it lets refine that",
      "okay making it even better",
      "lets polish this up",
    ],
    video_animate_start: [
      "nice lets bring it to life",
      "okay animating this for you",
      "lets make it move",
    ],
    video_tweak_start: [
      "got it updating the motion",
      "alright tweaking the animation",
      "lets refine the movement",
    ],
    saved_image: ["saved it for you", "all set", "done"],
    saved_video: ["saved it for you", "your clip is ready", "done"],
  },

  fallbacks: {
    scanned: ["got it", "noted", "perfect got it"],
    thinking: ["give me a second", "putting it together", "almost there"],
    final: ["all set", "here you go", "done"],
  },

  userMessageRules: [
    "USER MESSAGE RULES (VERY IMPORTANT):",
    "- userMessage must be short friendly human",
    "- do not mention internal steps or tools",
    "- no robotic labels",
    "- max 140 characters",
  ].join("\n"),
};

// ============================================================================
// One BIG randomized pool for ALL user-facing lines
// - status text + scan_line text pull from the same pool
// - add anything you want into MMA_UI.extraLines
// ============================================================================

function _cleanLine(x) {
  if (x === null || x === undefined) return "";
  const s = (typeof x === "string" ? x : String(x)).trim();
  return s || "";
}

function _toLineList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(_cleanLine).filter(Boolean);
  const s = _cleanLine(v);
  return s ? [s] : [];
}

function _flattenObject(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const v of Object.values(obj)) out.push(..._toLineList(v));
  return out;
}

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ✅ you can paste any extra lines here (ex-frontend lines) and they’ll get mixed in
if (!Array.isArray(MMA_UI.extraLines)) MMA_UI.extraLines = [];

// Build once at boot
const MMA_BIG_POOL = _dedupe([
  ..._flattenObject(MMA_UI.statusMap),
  ..._flattenObject(MMA_UI.fallbacks),
  ..._toLineList(MMA_UI.extraLines),
]);

function pick(arr, fallback = "") {
  const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!a.length) return fallback;
  return a[Math.floor(Math.random() * a.length)];
}

function mixedPool(stage) {
  const stageLines = _toLineList(MMA_UI?.statusMap?.[stage]);
  return stageLines.length ? _dedupe([...stageLines, ...MMA_BIG_POOL]) : MMA_BIG_POOL;
}

function pickAvoid(pool, avoidText, fallback = "") {
  const avoid = _cleanLine(avoidText);
  const a = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!a.length) return fallback;

  if (avoid) {
    const b = a.filter((x) => x !== avoid);
    if (b.length) return b[Math.floor(Math.random() * b.length)];
  }
  return a[Math.floor(Math.random() * a.length)];
}

// always return ONE human line (randomized + mixed)
export function toUserStatus(internalStatus) {
  const stage = String(internalStatus || "queued");
  const pool = mixedPool(stage);
  return pickAvoid(pool, "", pick(MMA_UI?.statusMap?.queued, "okay"));
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

function normalizeUrlForKey(u) {
  const url = asHttpUrl(u);
  if (!url) return "";
  try {
    const x = new URL(url);
    x.search = "";
    x.hash = "";
    return x.toString();
  } catch {
    return url;
  }
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

// Keep Mina talking during long steps (Seedream / Kling)
// Sends a new friendly line every few seconds as a scan_line
function startMinaChatter({
  supabase,
  generationId,
  getVars,
  setVars,
  stage = "generating",
  intervalMs = 2600,
}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      let v = getVars();
      const avoid = (lastScanLine(getVars?.() || v || {}, "") || {}).text || "";
      const line = pickAvoid(mixedPool(stage), avoid, "");
      if (!line) return;

      v = pushUserMessageLine(v, line);
      setVars(v);

      await updateVars({ supabase, generationId, vars: v });
      emitLine(generationId, v);
    } catch {
      // ignore chatter errors (never crash pipeline)
    }
  };

  // say something immediately
  void tick();

  const id = setInterval(() => {
    void tick();
  }, Math.max(800, Number(intervalMs) || 2600));

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
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
      "You are image scanner.",
      "You will be given ONE image. Understand it.",
      'Output STRICT JSON only (no markdown): {"crt":string,"userMessage":string}',
      "crt: short factual description of the image in ONE sentence (max 120 chars).",
      "If it's product/logo/inspiration, hint that in crt.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    like_history: [
      "You are keyword extractor for memory style.",
      "You will receive a list of the user's recently liked generations (prompts and sometimes images).",
      'Output STRICT JSON only: {"style_history_csv":string}',
      "style_history_csv: comma-separated keywords (5 to 12 items). No hashtags. No sentences.",
      'Example: "editorial still life, luxury, minimal, soft shadows, no lens flare"',
      // no userMessage here
    ].join("\n"),

    reader: [
      "you are a prompt writer for text/image to image AI",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string,"userMessage":string}',
      "clean_prompt must be Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists, and use inspirations if provided.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    // ---------------------------
    // ONE-SHOT PROMPT BUILDERS (SIMPLIFIED)
    // - ONE GPT call does "scan + prompt" together.
    // - No userMessage output. You handle UI messages separately.
    // ---------------------------

    still_one_shot: [
      "understand the user brief and give one line prompt describing the image, always type editorial still life, dont describe the light ever, always muted tone, use inspiration for background and tone and vibe only .. and use simple english",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"clean_prompt": string}',
      "",
      "SAFETY:",
      "- if the brief tells you to remove or change something your prompt should be only that. dont type text comping from inspiration images, if the logo labeled image is text or paragraph, type it in the prompt,  dont say inspired from or use the reference, Avoid copyrighted characters, brand knockoffs, hateful/sexual content.",
    ].join("\n"),

    still_tweak_one_shot: [
      "understand the user tweaks and give one line prompt describing the image, remove, add, replace just clear order and always start with keep everything the same",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"clean_prompt": string}',
      "",
      "SAFETY:",
      "- Avoid copyrighted characters, brand knockoffs, hateful/sexual content.",
    ].join("\n"),

    motion_one_shot: [
      "understand the user brief and give one line prompt describing video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
      "SAFETY:",
      "- Avoid copyrighted characters, brand knockoffs, hateful/sexual content.",
    ].join("\n"),

    motion_tweak_one_shot: [
      "understand the user brief and give one line prompt describing the tweaked video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
     "SAFETY:",
      "- Avoid copyrighted characters, brand knockoffs, hateful/sexual content.",
    ].join("\n"),

    output_scan: [
      "you are caption AI sees image and tell what it is + friendly useMessage",
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
    // NOTE: these can receive BOTH start and end frames (if end provided)
    // ---------------------------
    motion_suggestion: [
      "You are motion prompt writer for Image to Video AI.",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"sugg_prompt":string,"userMessage":string}',
      "sugg_prompt: a simple, short 3 lines prompt to describe the main subject, what the subject looks like, the action or movement, the environment, and the visual style. Adding camera instructions (like pan, tracking shot, or zoom), lighting, and mood helps Kling produce more cinematic and stable results. Prompts should avoid vagueness or too many simultaneous actions—one main action, precise motion words, and clear visual intent lead to the most reliable videos.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    motion_reader2: [
      "You are Mina Motion Reader — prompt builder for Kling (image-to-video).",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"motion_prompt":string,"userMessage":string}',
      "motion_prompt: a simple, short 3 lines prompt to describe the main subject, what the subject looks like, the action or movement, the environment, and the visual style. Adding camera instructions (like pan, tracking shot, or zoom), lighting, and mood helps Kling produce more cinematic and stable results. Prompts should avoid vagueness or too many simultaneous actions—one main action, precise motion words, and clear visual intent lead to the most reliable videos.",
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

function buildResponsesUserContentLabeled({ introText, labeledImages }) {
  const parts = [];
  const t = safeStr(introText, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) parts.push({ type: "input_text", text: `IMAGE ROLE: ${role}` });
    parts.push({ type: "input_image", image_url: url });
  }

  return parts;
}

function buildChatCompletionsContentLabeled({ introText, labeledImages }) {
  const content = [];
  const t = safeStr(introText, "");
  if (t) content.push({ type: "text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) content.push({ type: "text", text: `IMAGE ROLE: ${role}` });
    content.push({ type: "image_url", image_url: { url } });
  }

  return content;
}

async function openaiJsonVisionLabeled({ model, system, introText, labeledImages }) {
  const openai = getOpenAI();

  // Try Responses API first
  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContentLabeled({ introText, labeledImages }) },
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
      content: buildChatCompletionsContentLabeled({ introText, labeledImages }),
    },
  ];

  const resp = await getOpenAI().chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
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
// ONE-SHOT GPT (scan + prompt together, no userMessage)
// ============================================================================
async function gptStillOneShotCreate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 10),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "");
  const debug = out?.parsed?.debug && typeof out.parsed.debug === "object" ? out.parsed.debug : null;

  return { clean_prompt, debug, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptStillOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { clean_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionOneShotAnimate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

// ============================================================================
// Replicate helpers (Seedream + Kling)
// ============================================================================
function pickFirstUrl(output) {
  const seen = new Set();

  const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s);

  const walk = (v) => {
    if (!v) return "";
    if (typeof v === "string") return isUrl(v) ? v : "";

    if (Array.isArray(v)) {
      for (const item of v) {
        const u = walk(item);
        if (u) return u;
      }
      return "";
    }

    if (typeof v === "object") {
      if (seen.has(v)) return "";
      seen.add(v);

      // common output keys across Replicate models
      const keys = [
        "url",
        "output",
        "outputs",
        "video",
        "video_url",
        "videoUrl",
        "mp4",
        "file",
        "files",
        "result",
        "results",
        "data",
      ];

      for (const k of keys) {
        if (v && Object.prototype.hasOwnProperty.call(v, k)) {
          const u = walk(v[k]);
          if (u) return u;
        }
      }

      // fallback: scan all values
      for (const val of Object.values(v)) {
        const u = walk(val);
        if (u) return u;
      }
    }

    return "";
  };

  return walk(output);
}

function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
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
  const defaultAspect =
    cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";

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
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
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
  return (
    asHttpUrl(inputs.end_image_url || inputs.endImageUrl) ||
    asHttpUrl(assets.end_image_url || assets.endImageUrl) ||
    ""
  );
}

async function runKling({
  prompt,
  startImage,
  endImage,
  duration,
  mode,
  negativePrompt,
  input: forcedInput,
}) {
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
    safeStr(mode, "") || (hasEnd ? "pro" : "") || cfg?.kling?.mode || process.env.MMA_KLING_MODE || "standard";

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
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
  };
}

// ============================================================================
// R2 Public store
// ============================================================================
function getR2() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint =
    process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

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
// ============================================================================
// CREDITS (controller-owned)
// - still create/tweak: 1 credit
// - video animate/tweak: 5 credits
// - type-for-me (suggest_only): charge 1 credit per 10 SUCCESSFUL suggestions
// - refund on failure:
//    - non-safety errors: always refund
//    - safety blocks: 1 courtesy refund per UTC day (per passId)
// ============================================================================
const MMA_COSTS = {
  still: 1,
  video: 5,
  typeForMePer: 10,      // every 10 successes
  typeForMeCharge: 1,    // charge 1 credit
};

function utcDayKey() {
  // yyyy-mm-dd in UTC
  return nowIso().slice(0, 10);
}

function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function ensureEnoughCredits(passId, needed) {
  const { credits } = await megaGetCredits(passId);
  const bal = Number(credits || 0);
  if (bal < Number(needed || 0)) {
    throw makeHttpError(402, "INSUFFICIENT_CREDITS", {
      passId,
      balance: bal,
      needed: Number(needed || 0),
    });
  }
  return { balance: bal };
}

async function readMmaPreferences(supabase, passId) {
  try {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences;
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch {
    return {};
  }
}

async function writeMmaPreferences(supabase, passId, nextPrefs) {
  try {
    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: nextPrefs,
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  } catch {
    // best effort
  }
}

function isSafetyBlockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  // keep this simple + wide; adjust later once you see real provider messages
  return (
    msg.includes("nsfw") ||
    msg.includes("nud") ||
    msg.includes("nude") ||
    msg.includes("sexual") ||
    msg.includes("safety") ||
    msg.includes("policy") ||
    msg.includes("content") && msg.includes("block")
  );
}

// Charge once per generation (idempotent)
async function chargeGeneration({ passId, generationId, cost, reason }) {
  const c = Number(cost || 0);
  if (c <= 0) return { charged: false, cost: 0 };

  const refType = "mma_charge";
  const refId = `mma:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: true, already: true, cost: c };

  await ensureEnoughCredits(passId, c);

  await megaAdjustCredits({
    passId,
    delta: -c,
    reason: reason || "mma_charge",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { charged: true, cost: c };
}

// Refund on failure (idempotent). Safety blocks: 1 courtesy refund/day.
async function refundOnFailure({ supabase, passId, generationId, cost, err }) {
  const c = Number(cost || 0);
  if (c <= 0) return { refunded: false, cost: 0 };

  const refType = "mma_refund";
  const refId = `mma:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { refunded: false, already: true, cost: c };

  const safety = isSafetyBlockError(err);

  if (safety) {
    const today = utcDayKey();
    const prefs = await readMmaPreferences(supabase, passId);

    // one courtesy per UTC day
    if (prefs?.courtesy_safety_refund_day === today) {
      return { refunded: false, blockedByDailyLimit: true, safety: true, cost: c };
    }

    // mark used (best-effort, reduces races)
    await writeMmaPreferences(supabase, passId, {
      ...prefs,
      courtesy_safety_refund_day: today,
    });
  }

  await megaAdjustCredits({
    passId,
    delta: +c,
    reason: safety ? "mma_safety_refund" : "mma_refund",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { refunded: true, safety, cost: c };
}

// TYPE FOR ME (suggest_only) meter:
// - charge 1 credit per 10 SUCCESSFUL suggestions
// - preflight: if next success would be a charge point, require 1 credit
async function preflightTypeForMe({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  // if next success hits the paywall point, ensure user has 1 credit
  if (next % MMA_COSTS.typeForMePer === 0) {
    await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);
  }

  return { prefs, successCount: n };
}

async function commitTypeForMeSuccessAndMaybeCharge({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  // write the success counter (best effort)
  await writeMmaPreferences(supabase, passId, {
    ...prefs,
    type_for_me_success_count: next,
  });

  // every 10th success => charge 1 credit (idempotent per bucket)
  if (next % MMA_COSTS.typeForMePer !== 0) return { charged: false, successCount: next };

  const bucket = Math.floor(next / MMA_COSTS.typeForMePer); // 1,2,3...
  const refType = "mma_type_for_me";
  const refId = `t4m:${passId}:b:${bucket}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: false, already: true, successCount: next };

  // should succeed because we did preflight, but keep safe
  await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);

  await megaAdjustCredits({
    passId,
    delta: -MMA_COSTS.typeForMeCharge,
    reason: "mma_type_for_me",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { charged: true, bucket, successCount: next };
}

async function ensureCustomerRow(_supabase, passId, { shopifyCustomerId, userId, email }) {
  const out = await megaEnsureCustomer({
    passId,
    shopifyCustomerId: shopifyCustomerId || null,
    userId: userId || null,
    email: email || null,
  });
  return { preferences: out?.preferences || {} };
}

// ✅ HISTORY COMPAT: ensure session row exists for /history grouping
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

function feedbackKey(payload) {
  if (!payload || typeof payload !== "object") return "";
  const gid = safeStr(payload.generation_id || payload.generationId || payload.mg_generation_id || payload.id, "");
  if (gid) return `gid:${gid}`;
  const url = normalizeUrlForKey(payload.imageUrl || payload.output_url || payload.url || payload.assetUrl);
  if (url) return `url:${url}`;
  const prompt = safeStr(payload.prompt, "");
  if (prompt) return `prompt:${prompt.slice(0, 240)}`;
  return "";
}

// ✅ Dedup likes: only keep the LATEST feedback event per generation/image.
//    If the latest event is "unliked", we must NOT include older likes.
async function fetchRecentLikedItems({ supabase, passId, limit }) {
  const target = Math.max(1, Number(limit || 0) || 1);

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_payload, mg_meta, mg_event_at, mg_created_at")
    .eq("mg_record_type", "feedback")
    .eq("mg_pass_id", passId)
    .order("mg_event_at", { ascending: false })
    .limit(Math.max(80, target * 20));

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const liked = [];
  const seen = new Set();

  for (const r of rows) {
    const payload = extractFeedbackPayload(r);
    if (!payload) continue;

    const key = feedbackKey(payload) || `row:${r.mg_event_at || r.mg_created_at || ""}`;
    if (!key) continue;

    // Only first (newest) event per key counts
    if (seen.has(key)) continue;
    seen.add(key);

    const isLiked = payload.liked === true;
    if (!isLiked) {
      // If latest event is NOT liked (unliked/false), it blocks older like events.
      continue;
    }

    liked.push({
      generationId: safeStr(payload.generation_id || payload.generationId || "", ""),
      prompt: safeStr(payload.prompt, ""),
      imageUrl: safeStr(payload.imageUrl, ""),
      createdAt: r.mg_event_at || r.mg_created_at || null,
    });

    if (liked.length >= target) break;
  }

  return liked;
}

// ============================================================================
// STILL CREATE PIPELINE
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const chargeCost = MMA_COSTS.still;
  await chargeGeneration({ passId, generationId, cost: chargeCost, reason: "mma_still" });

  const ctx = await getMmaCtxConfig(supabase);

  let chatter = null;

  try {
    // status: working
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    // minimal UI line (no GPT userMessage)
    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_create_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    // Collect assets
      const assets = working?.assets || {};
      const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
      const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);
      
      // explicit hero (recommended)
      const explicitHero =
        asHttpUrl(
          assets.style_hero_image_url ||
            assets.styleHeroImageUrl ||
            assets.style_hero_url ||
            assets.styleHeroUrl
        ) || "";
      
      // inspirations coming from frontend
      const inspUrlsRaw = safeArray(
        assets.inspiration_image_urls ||
          assets.inspirationImageUrls ||
          assets.style_image_urls ||
          assets.styleImageUrls
      )
        .map(asHttpUrl)
        .filter(Boolean);
      
      // --- HERO DETECTION (NO HARDCODE) ---
      // You can maintain many hero links in runtime config:
      // cfg.seadream.styleHeroUrls (or cfg.styleHeroUrls)
      const heroCandidates = []
        .concat(explicitHero ? [explicitHero] : [])
        .concat(safeArray(assets.style_hero_image_urls || assets.styleHeroImageUrls).map(asHttpUrl))
        .concat(safeArray(cfg?.seadream?.styleHeroUrls || cfg?.styleHeroUrls).map(asHttpUrl))
        .filter(Boolean);
      
      // build a normalized key set for safe comparisons (ignore query/hash)
      const heroKeySet = new Set(heroCandidates.map((u) => normalizeUrlForKey(u)).filter(Boolean));
      
      // if explicit hero missing, try to detect hero if it was mistakenly included in inspiration list
      const heroFromInsp = !explicitHero
        ? (inspUrlsRaw.find((u) => heroKeySet.has(normalizeUrlForKey(u))) || "")
        : "";
      
      const heroUrl = explicitHero || heroFromInsp || "";
      
      // IMPORTANT: ensure Seedream gets hero via assets (even if frontend didn’t set it cleanly)
      if (heroUrl) {
        working.assets = { ...(working.assets || {}), style_hero_image_url: heroUrl };
      }
      
      // --- GPT MUST NOT SEE HERO ---
      // Remove anything that matches heroKeySet OR equals heroUrl
      const heroKey = heroUrl ? normalizeUrlForKey(heroUrl) : "";
      const inspUrlsForGpt = inspUrlsRaw
        .filter((u) => {
          const k = normalizeUrlForKey(u);
          if (!k) return false;
          if (heroKey && k === heroKey) return false;
          if (heroKeySet.size && heroKeySet.has(k)) return false;
          return true;
        })
        .slice(0, 4);
      
      // Build labeled images for ONE GPT call (NO HERO here)
      const labeledImages = []
        .concat(productUrl ? [{ role: "PRODUCT", url: productUrl }] : [])
        .concat(logoUrl ? [{ role: "LOGO", url: logoUrl }] : [])
        .concat(inspUrlsForGpt.map((u, i) => ({ role: `INSPIRATION_${i + 1}`, url: u })))
        .slice(0, 10);



    // Input to GPT (no aspect ratio needed)
    const oneShotInput = {
      user_brief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Write a clean still-image prompt using the labeled images as references.",
    };

    const t0 = Date.now();
    const one = await gptStillOneShotCreate({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_one_shot",
      payload: {
        ctx: ctx.still_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, debug: one.debug, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt =
      safeStr(one.clean_prompt, "") ||
      safeStr(working?.inputs?.prompt, "") ||
      safeStr(working?.prompts?.clean_prompt, "");

    if (!usedPrompt) throw new Error("EMPTY_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    // status: generating
    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    // keep Mina talking while the render is happening
    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const imageInputs = buildSeedreamImageInputs(working);

    // aspect ratio selection (if no input images, avoid match_input_image)
    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      cfg?.seadream?.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    if (!imageInputs.length && String(aspectRatio).toLowerCase().includes("match")) {
      aspectRatio =
        cfg?.seadream?.fallbackAspectRatio ||
        process.env.MMA_SEADREAM_FALLBACK_ASPECT_RATIO ||
        "1:1";
    }

    let seedRes;
    try {
      seedRes = await runSeedream({
        prompt: usedPrompt,
        aspectRatio,
        imageInputs,
        size: cfg?.seadream?.size,
        enhancePrompt: cfg?.seadream?.enhancePrompt,
      });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = seedRes;

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

    // minimal UI line (no GPT userMessage)
    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

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

        try {
      await refundOnFailure({ supabase, passId, generationId, cost: MMA_COSTS.still, err });
    } catch (e) {
      console.warn("[mma] refund failed (still create)", e?.message || e);
    }

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

  // ✅ charge at pipeline start (refund on failure)
  await chargeGeneration({ passId, generationId, cost: MMA_COSTS.still, reason: "mma_still" });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    let stepNo = 1;

    const oneShotInput = {
      parent_image_url: parentUrl,
      feedback: feedbackText,
      previous_prompt: safeStr(parent?.mg_prompt, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Keep the main subject consistent. Apply feedback precisely.",
    };

    const labeledImages = [{ role: "PARENT_IMAGE", url: parentUrl }];

    const t0 = Date.now();
    const one = await gptStillOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_tweak_one_shot",
      payload: {
        ctx: ctx.still_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt = safeStr(one.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_TWEAK_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => { working = v; },
      stage: "generating",
      intervalMs: 2600,
    });

    let aspectRatio =
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
      image_input: [parentUrl],
    };

    let seedRes;
    try {
      seedRes = await runSeedream({
        prompt: usedPrompt,
        aspectRatio,
        imageInputs: [parentUrl],
        size: cfg?.seadream?.size,
        enhancePrompt: cfg?.seadream?.enhancePrompt,
        input: forcedInput,
      });
    } finally {
      try { chatter?.stop?.(); } catch {}
      chatter = null;
    }

    const { input, out: seedOut, timing } = seedRes;

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

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    try { chatter?.stop?.(); } catch {}
    chatter = null;

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

    // ✅ refund (idempotent; safety refund max 1/day)
    try {
      await refundOnFailure({ supabase, passId, generationId, cost: MMA_COSTS.still, err });
    } catch (e) {
      console.warn("[mma] refund failed (still tweak)", e?.message || e);
    }

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

  // detect suggestOnly + typeForMe EARLY (for charging/refund logic)
  const inputs0 = (working?.inputs && typeof working.inputs === "object") ? working.inputs : {};
  const suggestOnly = inputs0.suggest_only === true || inputs0.suggestOnly === true;
  const typeForMe =
    inputs0.type_for_me === true ||
    inputs0.typeForMe === true ||
    inputs0.use_suggestion === true ||
    inputs0.useSuggestion === true;

  // ✅ charge ONLY for real video generation (not suggestion-only)
  if (!suggestOnly) {
    await chargeGeneration({ passId, generationId, cost: MMA_COSTS.video, reason: "mma_video" });
  }

  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_animate_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage = pickKlingStartImage(working, parent);
    const endImage = pickKlingEndImage(working, parent);
    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO");

    const motionBrief =
      safeStr(working?.inputs?.motion_user_brief, "") ||
      safeStr(working?.inputs?.motionBrief, "") ||
      safeStr(working?.inputs?.brief, "") ||
      safeStr(working?.inputs?.prompt, "");

    const movementStyle =
      safeStr(working?.inputs?.selected_movement_style, "") ||
      safeStr(working?.inputs?.movement_style, "") ||
      safeStr(working?.inputs?.movementStyle, "");

    const promptOverride = safeStr(
      working?.inputs?.prompt_override ||
        working?.inputs?.motion_prompt_override ||
        working?.inputs?.motionPromptOverride,
      ""
    );

    const usePromptOverride =
      (working?.inputs?.use_prompt_override === true || working?.inputs?.usePromptOverride === true) &&
      !!promptOverride;

    // Always keep start/end images saved in vars
    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    let finalMotionPrompt = "";

    if (usePromptOverride) {
      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "motion_prompt_override",
        payload: {
          source: "frontend",
          prompt_override: promptOverride,
          start_image_url: startImage,
          end_image_url: asHttpUrl(endImage) || null,
          motion_user_brief: motionBrief,
          selected_movement_style: movementStyle,
          timing: { started_at: nowIso(), ended_at: nowIso(), duration_ms: 0 },
          error: null,
        },
      });
      finalMotionPrompt = promptOverride;
    } else {
      const oneShotInput = {
        start_image_url: startImage,
        end_image_url: asHttpUrl(endImage) || null,
        motion_user_brief: motionBrief,
        selected_movement_style: movementStyle,
        notes: "Write a single clean motion prompt. Plain English. No emojis. No questions.",
      };

      const labeledImages = []
        .concat([{ role: "START_IMAGE", url: startImage }])
        .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
        .slice(0, 6);

      const t0 = Date.now();
      const one = await gptMotionOneShotAnimate({ cfg, ctx, input: oneShotInput, labeledImages });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_motion_one_shot",
        payload: {
          ctx: ctx.motion_one_shot,
          input: oneShotInput,
          labeledImages,
          request: one.request,
          raw: one.raw,
          output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      finalMotionPrompt =
        safeStr(one.motion_prompt, "") ||
        safeStr(working?.inputs?.motion_prompt, "") ||
        safeStr(working?.inputs?.prompt, "") ||
        safeStr(working?.prompts?.motion_prompt, "");
    }

    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_PROMPT");

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    await updateVars({ supabase, generationId, vars: working });

    // ✅ suggestion-only: save prompt, maybe count + charge per 10 successes, then return
    if (suggestOnly) {
      await supabase
        .from("mega_generations")
        .update({
          mg_status: "suggested",
          mg_mma_status: "suggested",
          mg_prompt: finalMotionPrompt,
          mg_updated_at: nowIso(),
        })
        .eq("mg_generation_id", generationId)
        .eq("mg_record_type", "generation");

      // ✅ TYPE FOR ME meter: count success, charge 1 per 10 successes
      if (typeForMe) {
        try {
          await commitTypeForMeSuccessAndMaybeCharge({ supabase, passId });
        } catch (e) {
          console.warn("[mma] type-for-me charge failed:", e?.message || e);
        }
      }

      emitStatus(generationId, "suggested");
      sendDone(generationId, toUserStatus("suggested"));
      return;
    }

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => { working = v; },
      stage: "generating",
      intervalMs: 2600,
    });

    const duration =
      Number(working?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

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

    let klingRes;
    try {
      klingRes = await runKling({
        prompt: finalMotionPrompt,
        startImage,
        endImage,
        duration,
        mode,
        negativePrompt: neg,
      });
    } finally {
      try { chatter?.stop?.(); } catch {}
      chatter = null;
    }

    const { input, out, timing } = klingRes;

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

    let remoteUrl = remote;
    try {
      remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);
    } catch (e) {
      console.warn("[mma] storeRemoteToR2Public failed (video), using provider url:", e?.message || e);
      remoteUrl = remote;
    }

    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    try { chatter?.stop?.(); } catch {}
    chatter = null;

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

    // ✅ refund ONLY if this was a real paid generation (not suggestion-only)
    if (!suggestOnly) {
      try {
        await refundOnFailure({ supabase, passId, generationId, cost: MMA_COSTS.video, err });
      } catch (e) {
        console.warn("[mma] refund failed (video animate)", e?.message || e);
      }
    }

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

  await chargeGeneration({ passId, generationId, cost: MMA_COSTS.video, reason: "mma_video" });

  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};

    const startImage =
      asHttpUrl(working?.inputs?.start_image_url || working?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
      asHttpUrl(parent?.mg_output_url) ||
      "";

    const endImage =
      asHttpUrl(working?.inputs?.end_image_url || working?.inputs?.endImageUrl) ||
      asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl) ||
      "";

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO_TWEAK");

    const feedbackMotion =
      safeStr(working?.feedback?.motion_feedback, "") ||
      safeStr(working?.feedback?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackMotion) throw new Error("MISSING_MOTION_FEEDBACK");

    const prevMotionPrompt =
      safeStr(parentVars?.prompts?.motion_prompt, "") || safeStr(parent?.mg_prompt, "");

    const oneShotInput = {
      start_image_url: startImage,
      end_image_url: asHttpUrl(endImage) || null,
      feedback_motion: feedbackMotion,
      previous_motion_prompt: prevMotionPrompt,
      notes: "Keep what works. Apply feedback precisely. Plain English. No emojis. No questions.",
    };

    const labeledImages = []
      .concat([{ role: "START_IMAGE", url: startImage }])
      .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
      .slice(0, 6);

    const t0 = Date.now();
    const one = await gptMotionOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_motion_tweak_one_shot",
      payload: {
        ctx: ctx.motion_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const finalMotionPrompt = safeStr(one.motion_prompt, "");
    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_TWEAK_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const duration =
      Number(
        working?.inputs?.duration ??
          parentVars?.inputs?.duration ??
          cfg?.kling?.duration ??
          process.env.MMA_KLING_DURATION ??
          5
      ) || 5;

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

    let klingRes;
    try {
      klingRes = await runKling({
        prompt: finalMotionPrompt,
        startImage,
        endImage,
        duration,
        mode,
        negativePrompt: neg,
      });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = klingRes;

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
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, toUserStatus("done"));
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

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

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: MMA_COSTS.video, err });
    } catch (e) {
      console.warn("[mma] refund failed (video tweak)", e?.message || e);
    }

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

  // ✅ fail fast: still tweak needs 1 credit available (actual charge happens in pipeline)
  await ensureEnoughCredits(passId, MMA_COSTS.still);

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

  vars.mg_pass_id = passId;

  // ✅ HISTORY COMPAT: keep same session by default (fallback to parent)
  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Image session";

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
  await ensureEnoughCredits(passId, MMA_COSTS.video);

  const generationId = newUuid();

  await ensureCustomerRow(supabase, passId, {
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

  const platform =
    safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Video session";

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

  const parentId = body?.parent_generation_id || body?.parentGenerationId || body?.generation_id || null;

  // ----------------------------
  // CREDITS PREFLIGHT (fail fast)
  // ----------------------------
  const inputs = (body?.inputs && typeof body.inputs === "object") ? body.inputs : {};
  const suggestOnly = inputs.suggest_only === true || inputs.suggestOnly === true;
  const typeForMe =
    inputs.type_for_me === true ||
    inputs.typeForMe === true ||
    inputs.use_suggestion === true ||
    inputs.useSuggestion === true;

  if (mode === "video" && suggestOnly && typeForMe) {
    // 1 credit per 10 successful suggestions (blocks on #10 if balance=0)
    await preflightTypeForMe({ supabase, passId });
  } else {
    // Real generation: still=1, video=5 (actual charge happens in pipeline)
    await ensureEnoughCredits(passId, mode === "video" ? MMA_COSTS.video : MMA_COSTS.still);
  }

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

  // ✅ HISTORY COMPAT: always have a session + fields your /history route reads
  const parent = parentId ? await fetchParentGenerationRow(supabase, parentId).catch(() => null) : null;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform =
    safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") ||
    safeStr(parent?.mg_title, "") ||
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

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  if (mode === "still") {
    vars.meta = { ...(vars.meta || {}), flow: "still_create" };
    await updateVars({ supabase, generationId, vars });

    runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }).catch((err) =>
      console.error("[mma] still create pipeline error", err)
    );
  } else if (mode === "video") {
    vars.meta = { ...(vars.meta || {}), flow: "video_animate", parent_generation_id: parentId || null };

    if (parent?.mg_output_url) {
      vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent.mg_output_url };
    }

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

  // preference updates kept minimal here (same logic you had)
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
// Router factory (optional; you may also use ./mma-router.js)
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
