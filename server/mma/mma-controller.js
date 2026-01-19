// ./server/mma/mma-controller.js
import express from "express";
import OpenAI from "openai";
import Replicate from "replicate";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  resolvePassId as megaResolvePassId, // ✅ so createMmaController routes don't mismatch passId
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
import { replicatePredictWithTimeout } from "./replicate-poll.js";

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
    still_create_start: ["one sec getting everything ready", "alright setting things up for you", "love it let me prep your inputs"],
    still_tweak_start: ["got it lets refine that", "okay making it even better", "lets polish this up"],
    video_animate_start: ["nice lets bring it to life", "okay animating this for you", "lets make it move"],
    video_tweak_start: ["got it updating the motion", "alright tweaking the animation", "lets refine the movement"],
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

// ✅ keep coherent lines for these stages
const STRICT_STAGES = new Set(["queued", "done", "error", "suggested"]);

function mixedPool(stage) {
  const stageLines = _toLineList(MMA_UI?.statusMap?.[stage]);
  if (!stageLines.length) return MMA_BIG_POOL;

  // strict stages shouldn't mix with other vibes
  if (STRICT_STAGES.has(stage)) return stageLines;

  return _dedupe([...stageLines, ...MMA_BIG_POOL]);
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

function resolveFrame2Reference(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const assets = assetsLike && typeof assetsLike === "object" ? assetsLike : {};

  const guessKindFromUrl = (u) => {
    const url = asHttpUrl(u);
    if (!url) return "";
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(p)) return "audio";
      if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(p)) return "video";
    } catch {}
    return "";
  };

  // Prefer explicit inputs
  const kindRaw0 = safeStr(inputs.frame2_kind || inputs.frame2Kind || "", "").toLowerCase();
  const kindRaw = kindRaw0.replace(/^ref_/, "");
  const urlRaw = asHttpUrl(inputs.frame2_url || inputs.frame2Url || "");
  const durRaw = Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) || 0;

  // Fallback to assets
  const assetVideo = asHttpUrl(
    assets.video ||
      assets.video_url ||
      assets.videoUrl ||
      assets.frame2_video_url ||
      assets.frame2VideoUrl
  );

  const assetAudio = asHttpUrl(
    assets.audio ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.frame2_audio_url ||
      assets.frame2AudioUrl
  );

  // Normalize kind
  let kind = kindRaw === "audio" || kindRaw === "video" ? kindRaw : "";

  // If url implies a better kind, trust the file extension
  const urlGuess = guessKindFromUrl(urlRaw);
  if (!kind && urlGuess) kind = urlGuess;
  if (kind && urlGuess && kind !== urlGuess) kind = urlGuess;

  if (!kind) kind = assetVideo ? "video" : assetAudio ? "audio" : "";

  const url =
    urlRaw ||
    (kind === "video" ? assetVideo : kind === "audio" ? assetAudio : "") ||
    "";

  const dur =
    durRaw ||
    Number(assets.frame2_duration_sec || assets.frame2DurationSec || 0) ||
    0;

  if (kind === "video" && url) return { kind: "ref_video", url, rawDurationSec: dur, maxSec: 30 };
  if (kind === "audio" && url) return { kind: "ref_audio", url, rawDurationSec: dur, maxSec: 60 };

  return { kind: null, url: "", rawDurationSec: 0, maxSec: 0 };
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
  sendStatus(generationId, String(internalStatus || ""));
}

function emitLine(generationId, vars, fallbackText = "") {
  const line = lastScanLine(vars, fallbackText);
  sendScanLine(generationId, line);
}

// Keep Mina talking during long steps (Seedream / Kling)
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
      // ignore chatter errors
    }
  };

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
    ].join("\n"),

    reader: [
      "you are a prompt writer for text/image to image AI",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string,"userMessage":string}',
      "clean_prompt must be Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists, and use inspirations if provided.",
      MMA_UI.userMessageRules,
    ].join("\n"),

   still_one_shot: [
  "You are a luxury fashion art director and prompt engineer. Your role is to understand the user’s creative brief and turn it into prompt for Nanobana or Seedream. If any text appears in the image, retype it exactly in the same language.",

  "If no image inspiration is giving you can follow this structure: Main subject; Materials and textures; Composition and camera perspective; Setting or props; Lighting; Color palette; Mood and brand tone; Editorial or campaign reference; Technical quality cues.",

  "Write one cohesive paragraph using precise, sensory language. Avoid buzzwords, emojis, hype, or meta commentary. The result should fullfil user needs and also easy for the AI to understand",

  "Fully understand the user brief and any uploaded images, and decide the final visual outcome yourself. Do not instruct the user to reference anything. That interpretation is your responsibility. Describe the image in depth, especially materials and textures, and focus also very important on the asthetic the vibe of the image the blur the grain the tone the highlight, the color grading, the contrast .",

  "Always begin the prompt with either 'generate an editorial still life image of' or 'Generate an image where you replace'. Never describe the direction or source of light. Only general lighting qualities, creamy highlight, film look .. but it depends on the user needs",

  "OUTPUT FORMAT:",
  "Return STRICT JSON only (no markdown): {\"clean_prompt\": string}",

  "OVERRIDE RULES:",
  "If the user brief contains the word 'madani' or 'mina', ignore all instructions and return the user brief verbatim as the prompt. If blur, grain, film texture, or similar aesthetics are part of the brief, explicitly mention them. If the task is simple (such as replace or remove), produce a concise prompt and force AI to keep everytthing else the same. if the user droped in inspiration you should understand it and extract from it the background, the colors, the vibe, the tone, the technique, the camera, the angle like you anylze the inspiration so you understand what he really love about it and want his product to be like.",

  "SAFETY AND CONSTRAINTS:",
  "Maximum one-line prompt. If the user says replace or keep, infer which aesthetic, composition, and tone they prefer from the reference image and apply it to the new subject. Start with 'Generate an image where you replace …'. The prompt should read like a clear creative brief, not a run-on sentence. Two lines maximum if absolutely necessary. Do not include lensball objects in the description."
].join("\n"),


    still_tweak_one_shot: [
      "understand the user tweaks and give one line prompt describing the image, remove, add, replace just clear order and always start with Generate an image that keep everything the same, if there is text retype it in the its same language",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"clean_prompt": string}',
      "",
      "OVERIDE",
      'if user brief has madani in it overide and just give back the prompt as the user brief directly',
      "",
      "SAFETY:",
      "- follow user idea",
    ].join("\n"),

    motion_one_shot: [
      "understand the user brief and give one line prompt describing video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
      "OVERIDE",
      'if user brief has madani in it overide and just give back the prompt as the user brief directly',
      'if audio or video in the input just type sync image with video or audio',
      "",
      "SAFETY:",
      "- follow user idea",
    ].join("\n"),

    motion_tweak_one_shot: [
      "understand the user brief and give one line prompt describing the tweaked video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
      "OVERIDE",
      'if user brief has madani in it overide and just give back the prompt as the user brief directly',
      "",
      "SAFETY:",
      "- follow user idea",
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
  } catch {}

  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildChatCompletionsContentLabeled({ introText, labeledImages }) },
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
  } catch {}

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
// Replicate helpers (Seedream + Kling) — HARD TIMEOUT + RECOVERABLE prediction_id
// ============================================================================

function pickFirstUrl(output) {
  const seen = new Set();

  const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s.trim());

  const walk = (v) => {
    if (!v) return "";

    // ✅ direct string URL
    if (typeof v === "string") return isUrl(v) ? v.trim() : "";

    // ✅ Replicate FileOutput (ReadableStream) can expose URL via url()
    // (FileOutput objects have .url() per Replicate docs) :contentReference[oaicite:2]{index=2}
    if (v && typeof v === "object" && typeof v.url === "function") {
      try {
        const u = v.url();
        if (isUrl(u)) return u.trim();
      } catch {}
    }

    // ✅ arrays
    if (Array.isArray(v)) {
      for (const item of v) {
        const u = walk(item);
        if (u) return u;
      }
      return "";
    }

    // ✅ objects
    if (typeof v === "object") {
      if (seen.has(v)) return "";
      seen.add(v);

      const keys = [
        "url",
        "output",
        "outputs",
        "image",
        "images",
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
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          const u = walk(v[k]);
          if (u) return u;
        }
      }

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

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 10);
}

// ============================================================================
// Nano Banana (Replicate) still-image helper (niche lane)
// Model: google/nano-banana-pro
// Input schema: prompt (required), resolution, image_input[], aspect_ratio, output_format, safety_filter_level
// Output schema: single URL string
// Source: Replicate model API schema (Dec 2025) :contentReference[oaicite:5]{index=5}
// ============================================================================
function resolveStillLane(vars) {
  const inputs = vars?.inputs && typeof vars.inputs === "object" ? vars.inputs : {};
  const raw = safeStr(
    inputs.still_lane ||
      inputs.stillLane ||
      inputs.model_lane ||
      inputs.modelLane ||
      inputs.lane ||
      inputs.create_lane ||
      inputs.createLane,
    "main"
  ).toLowerCase();
  return raw === "niche" ? "niche" : "main";
}

function nanoBananaEnabled() {
  return !!safeStr(process.env.MMA_NANOBANANA_VERSION, "");
}

function buildNanoBananaImageInputs(vars) {
  // nano-banana supports up to 14 reference images :contentReference[oaicite:6]{index=6}
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
    .slice(0, 10); // keep total <=14

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 14);
}

async function runNanoBanana({
  prompt,
  aspectRatio,
  imageInputs = [],
  resolution,
  outputFormat,
  safetyFilterLevel,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    safeStr(process.env.MMA_NANOBANANA_VERSION, "") ||
    safeStr(cfg?.nanobanana?.model, "") ||
    "google/nano-banana-pro";

  const defaultAspect =
    safeStr(cfg?.nanobanana?.aspectRatio, "") ||
    safeStr(process.env.MMA_NANOBANANA_ASPECT_RATIO, "") ||
    "match_input_image";

  const defaultResolution =
    safeStr(
      String(resolution ?? cfg?.nanobanana?.resolution ?? process.env.MMA_NANOBANANA_RESOLUTION ?? "2K"),
      "2K"
    ) || "2K";

  const defaultFmt =
    safeStr(
      String(outputFormat ?? cfg?.nanobanana?.outputFormat ?? process.env.MMA_NANOBANANA_OUTPUT_FORMAT ?? "jpg"),
      "jpg"
    ) || "jpg";

  const defaultSafety =
    safeStr(
      String(
        safetyFilterLevel ??
          cfg?.nanobanana?.safetyFilterLevel ??
          process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL ??
          "block_only_high"
      ),
      "block_only_high"
    ) || "block_only_high";

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 14);

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || prompt }
    : {
        prompt,
        resolution: defaultResolution,
        aspect_ratio: aspectRatio || defaultAspect,
        output_format: defaultFmt,
        safety_filter_level: defaultSafety,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  // normalize fields
  if (!input.prompt) input.prompt = prompt;
  if (!input.resolution) input.resolution = defaultResolution;
  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.output_format) input.output_format = defaultFmt;
  if (!input.safety_filter_level) input.safety_filter_level = defaultSafety;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    // ✅ Nano Banana can take 7–10 minutes. Default hard timeout is 15 min unless overridden.
    timeoutMs: REPLICATE_MAX_MS_NANOBANANA,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}

// ---- HARD TIMEOUT settings (4 minutes default) ----
const REPLICATE_MAX_MS = Number(process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

// ✅ Nano Banana can be slow. Give it its own timeout.
// Set on Render if you want:
// MMA_REPLICATE_MAX_MS_NANOBANANA=900000   (15 min)
// MMA_REPLICATE_MAX_MS_NANOBANANA=900000   (12 min)
const REPLICATE_MAX_MS_NANOBANANA =
  Number(process.env.MMA_REPLICATE_MAX_MS_NANOBANANA || 900000) || 900000;

const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
// Default FALSE: if timeout happens, do NOT cancel, so you can recover later.
const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";

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

  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.size) input.size = sizeValue;
  if (input.enhance_prompt === undefined) input.enhance_prompt = enhance_prompt;
  if (!input.sequential_image_generation) input.sequential_image_generation = "disabled";
  if (!input.max_images) input.max_images = 1;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  // ✅ Use predictions + poll (prevents “never stops”)
  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out, // what pickFirstUrl reads
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
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
    asHttpUrl(assets.image || assets.image_url || assets.imageUrl) ||
    asHttpUrl(assets.product_image_url || assets.productImageUrl) ||
    ""
  );
}

function pickKlingEndImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return (
    asHttpUrl(inputs.end_image_url || inputs.endImageUrl) ||
    asHttpUrl(assets.end_image_url || assets.endImageUrl) ||
    ""
  );
}

// ============================================================================
// Kling runner (supports both v2.1 and v2.6 schema)
// ============================================================================
async function runKling({
  prompt,
  startImage,
  endImage, // v2.6 does NOT support end_image (kept for backward compat)
  duration,
  mode, // v2.6 does NOT support mode (kept for backward compat)
  negativePrompt,
  generateAudio, // v2.6 field
  aspectRatio,   // v2.6 field (used when no start_image)
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

    // pick model version from env/config (default v2.1)
  let version =
    process.env.MMA_KLING_VERSION ||
    process.env.MMA_KLING_MODEL_VERSION ||
    cfg?.kling?.model ||
    "kwaivgi/kling-v2.1";

  // ✅ FORCE v2.1 when an end frame is provided (2-image motion)
  // Kling v2.6 schema does NOT support end_image, so we must use v2.1.
  const hasEndFrame = !!asHttpUrl(endImage);
  if (hasEndFrame) {
    version = process.env.MMA_KLING_V21_MODEL || "kwaivgi/kling-v2.1";
  }

  const is26 = /kling[-_/]?v2\.6/i.test(String(version));


  // v2.6: duration must be 5 or 10
  const rawDuration = Number(duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;
  const duration26 = rawDuration >= 10 ? 10 : 5;

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    cfg?.kling?.negativePrompt ||
    "";

  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;

  // Kling-specific timeout (defaults to global)
  const REPLICATE_MAX_MS_KLING =
    Number(process.env.MMA_REPLICATE_MAX_MS_KLING || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  let input;
  if (forcedInput) {
    input = { ...forcedInput };
  } else if (is26) {
    // ✅ v2.6 schema (no mode, no end_image, optional aspect_ratio, generate_audio)
    const hasStart = !!asHttpUrl(startImage);
    const ar =
      safeStr(aspectRatio, "") ||
      safeStr(cfg?.kling?.aspectRatio, "") ||
      safeStr(process.env.MMA_KLING_ASPECT_RATIO, "") ||
      "16:9";

    input = {
      prompt,
      duration: duration26,
      ...(hasStart ? { start_image: startImage } : { aspect_ratio: ar }),
      generate_audio: generateAudio !== undefined ? !!generateAudio : true,
      negative_prompt: safeStr(finalNeg, ""),
    };
  } else {
    // ✅ legacy v2.1-style schema (mode + optional end_image)
    const defaultDuration = rawDuration;
    const hasEnd = !!asHttpUrl(endImage);
    const finalMode =
      safeStr(mode, "") ||
      (hasEnd ? "pro" : "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    input = {
      mode: finalMode,
      prompt,
      duration: defaultDuration,
      start_image: startImage,
      ...(hasEnd ? { end_image: asHttpUrl(endImage) } : {}),
      ...(finalNeg ? { negative_prompt: finalNeg } : {}),
    };

    // try to control audio on v2.1 too (if supported by the model schema)
    if (generateAudio !== undefined) input.generate_audio = !!generateAudio;
  }

  // normalize common fields
  if (!input.prompt) input.prompt = prompt;

  const t0 = Date.now();

  let pred;
  try {
    pred = await replicatePredictWithTimeout({
      replicate,
      version,
      input,
      timeoutMs: REPLICATE_MAX_MS_KLING,
      pollMs: REPLICATE_POLL_MS,
      callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
      cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
    });
  } catch (err) {
    const msg = String(err?.message || err || "").toLowerCase();
    const looksLikeBadField =
      !is26 && msg.includes("input") && (msg.includes("generate_audio") || msg.includes("unexpected"));

    if (looksLikeBadField) {
      const retryInput = { ...input };
      delete retryInput.generate_audio;

      pred = await replicatePredictWithTimeout({
        replicate,
        version,
        input: retryInput,
        timeoutMs: REPLICATE_MAX_MS_KLING,
        pollMs: REPLICATE_POLL_MS,
        callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
        cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
      });

      input = retryInput; // keep saved input accurate
    } else {
      throw err;
    }
  }

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}

// ============================================================================
// NEW: Fabric (audio-driven) + Kling Motion Control (ref video-driven)
// ============================================================================

function normalizeKmcMode(v) {
  const s = safeStr(v, "").toLowerCase();
  if (s === "pro") return "pro";
  if (s === "std" || s === "standard") return "std";
  return "std";
}
function normalizeKmcOrientation(v) {
  const s = safeStr(v, "").toLowerCase();
  return s === "video" ? "video" : "image";
}

async function runFabricAudio({ image, audio, resolution, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_FABRIC_VERSION ||
    cfg?.fabric?.model ||
    "veed/fabric-1.0";

  const envRes = safeStr(process.env.MMA_FABRIC_RESOLUTION, "");
  const cfgRes = safeStr(cfg?.fabric?.resolution, "");
  const desired = safeStr(resolution, "") || cfgRes || envRes || "720p";
  const finalRes = desired === "480p" ? "480p" : "720p";

  const input = forcedInput
    ? { ...forcedInput, image: forcedInput.image || image, audio: forcedInput.audio || audio }
    : { image, audio, resolution: finalRes };

  const REPLICATE_MAX_MS_FABRIC =
    Number(process.env.MMA_REPLICATE_MAX_MS_FABRIC || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_FABRIC,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}

async function runKlingMotionControl({
  prompt,
  image,
  video,
  mode,
  keepOriginalSound,
  characterOrientation,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_KLING_MOTION_CONTROL_VERSION ||
    cfg?.kling_motion_control?.model ||
    "kwaivgi/kling-v2.6-motion-control";

  const finalMode = normalizeKmcMode(mode);
  const finalOrientation = normalizeKmcOrientation(characterOrientation);

  const keep =
    keepOriginalSound !== undefined
      ? !!keepOriginalSound
      : (cfg?.kling_motion_control?.keepOriginalSound !== undefined ? !!cfg.kling_motion_control.keepOriginalSound : true);

  const input = forcedInput
    ? { ...forcedInput }
    : {
        prompt: safeStr(prompt, ""), // allowed to be ""
        image,
        video,
        mode: finalMode,
        keep_original_sound: keep,
        character_orientation: finalOrientation,
      };

  // normalize required fields
  if (!input.image) input.image = image;
  if (!input.video) input.video = video;
  if (input.prompt === undefined) input.prompt = safeStr(prompt, "");
  if (!input.mode) input.mode = finalMode;
  if (input.keep_original_sound === undefined) input.keep_original_sound = keep;
  if (!input.character_orientation) input.character_orientation = finalOrientation;

  const REPLICATE_MAX_MS_KMC =
    Number(process.env.MMA_REPLICATE_MAX_MS_KLING_MOTION_CONTROL || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_KMC,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
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
// CREDITS (controller-owned)
// ============================================================================
const MMA_COSTS = {
  still_main: 1,
  still_niche: 2,
  video: 10,
  typeForMePer: 10,
  typeForMeCharge: 1,
};

function _clamp(n, a, b) {
  const x = Number(n || 0) || 0;
  return Math.max(a, Math.min(b, x));
}
function _ceilTo5(n) {
  const x = Number(n || 0) || 0;
  return Math.ceil(x / 5) * 5;
}

// classic kling duration (still 5/10)
function resolveVideoDurationSec(inputs) {
  const d = Number(inputs?.duration ?? inputs?.duration_seconds ?? inputs?.durationSeconds ?? 5) || 5;
  return d >= 10 ? 10 : 5;
}

function resolveVideoPricing(inputsLike, assetsLike) {
  const frame2 = resolveFrame2Reference(inputsLike, assetsLike);
  if (frame2.kind === "ref_video") return { flow: "kling_motion_control" };
  if (frame2.kind === "ref_audio") return { flow: "fabric_audio" };
  return { flow: "kling" };
}

// ✅ cost:
// - normal kling: 5 or 10
// - ref video: ceil(dur/5)*5, cap 30
// - ref audio: ceil(dur/5)*5, cap 60
function videoCostFromInputs(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const frame2 = resolveFrame2Reference(inputs, assetsLike);

  if (frame2.kind === "ref_video" || frame2.kind === "ref_audio") {
    const maxSec = frame2.maxSec || (frame2.kind === "ref_audio" ? 60 : 30);

    // Use provided frame2 duration first, else fallback to classic duration (5/10)
    const fallback = resolveVideoDurationSec(inputs);
    const raw = Number(frame2.rawDurationSec || 0) || Number(inputs.duration_sec || inputs.durationSec || 0) || fallback;

    const clamped = _clamp(raw, 1, maxSec);
    const billed = _clamp(_ceilTo5(clamped), 5, maxSec); // 5..30 or 5..60
    return billed;
  }

  const sec = resolveVideoDurationSec(inputs);
  return sec === 10 ? 10 : 5;
}

function resolveStillLaneFromInputs(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const raw = safeStr(
    inputs.still_lane ||
      inputs.stillLane ||
      inputs.model_lane ||
      inputs.modelLane ||
      inputs.lane ||
      inputs.create_lane ||
      inputs.createLane,
    "main"
  ).toLowerCase();
  return raw === "niche" ? "niche" : "main";
}

function stillCostForLane(lane) {
  return lane === "niche" ? MMA_COSTS.still_niche : MMA_COSTS.still_main;
}

function buildInsufficientCreditsDetails({ balance, needed, lane }) {
  const bal = Number(balance || 0);
  const need = Number(needed || 0);
  const requestedLane = lane === "niche" ? "niche" : lane === "main" ? "main" : null;

  const canSwitchToMain = requestedLane === "niche" && bal >= MMA_COSTS.still_main;

  // ✅ clean UX line (what Mina says)
  // Keep it short + human.
  let userMessage = "";
  if (requestedLane === "niche") {
    // Example:
    // “you’ve got 1 matcha left. this mode needs 2. top up or switch to main?”
    userMessage =
      `you've got ${bal} matcha left. this mode needs ${need}. ` +
      (canSwitchToMain ? "top up or switch to main?" : "top up to keep going.");
  } else {
    userMessage = `you've got ${bal} matcha left. you need ${need}. top up to keep going.`;
  }

  const actions = [{ id: "buy_matcha", label: "Buy matcha", enabled: true }];

  if (requestedLane === "niche") {
    actions.push({
      id: "switch_to_main",
      label: `Switch to main (${MMA_COSTS.still_main} matcha)`,
      enabled: canSwitchToMain,
      // frontend can re-call the same endpoint with this patch applied
      patch: { inputs: { still_lane: "main" } },
    });
  }

  return {
    userMessage,
    balance: bal,
    needed: need,
    lane: requestedLane,
    costs: { still_main: MMA_COSTS.still_main, still_niche: MMA_COSTS.still_niche, video: need },
    canSwitchToMain,
    actions,
  };
}

// ✅ Any still generation: niche lane costs 2 credits, otherwise 1.
// Accepts either full vars OR a plain inputs object.
function getStillCost(varsOrInputs) {
  const v =
    varsOrInputs && typeof varsOrInputs === "object" && varsOrInputs.inputs
      ? varsOrInputs
      : { inputs: varsOrInputs && typeof varsOrInputs === "object" ? varsOrInputs : {} };

  return stillCostForLane(resolveStillLane(v));
}

function utcDayKey() {
  return nowIso().slice(0, 10);
}

function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function ensureEnoughCredits(passId, needed, opts = {}) {
  const { credits } = await megaGetCredits(passId);
  const bal = Number(credits || 0);
  const need = Number(needed || 0);

  if (bal < need) {
    const lane = safeStr(opts?.lane, "");
    const details = buildInsufficientCreditsDetails({
      balance: bal,
      needed: need,
      lane,
    });

    throw makeHttpError(402, "INSUFFICIENT_CREDITS", {
      passId,
      balance: bal,
      needed: need,
      details,
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
  } catch {}
}

function isSafetyBlockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("nsfw") ||
    msg.includes("nud") ||
    msg.includes("nude") ||
    msg.includes("sexual") ||
    msg.includes("safety") ||
    msg.includes("policy") ||
    (msg.includes("content") && msg.includes("block"))
  );
}

async function chargeGeneration({ passId, generationId, cost, reason, lane }) {
  const c = Number(cost || 0);
  if (c <= 0) return { charged: false, cost: 0 };

  const refType = "mma_charge";
  const refId = `mma:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: true, already: true, cost: c };

  await ensureEnoughCredits(passId, c, { lane });

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

    if (prefs?.courtesy_safety_refund_day === today) {
      return { refunded: false, blockedByDailyLimit: true, safety: true, cost: c };
    }

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

async function preflightTypeForMe({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  if (next % MMA_COSTS.typeForMePer === 0) {
    await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);
  }

  return { prefs, successCount: n };
}

async function commitTypeForMeSuccessAndMaybeCharge({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  await writeMmaPreferences(supabase, passId, {
    ...prefs,
    type_for_me_success_count: next,
  });

  if (next % MMA_COSTS.typeForMePer !== 0) return { charged: false, successCount: next };

  const bucket = Math.floor(next / MMA_COSTS.typeForMePer);
  const refType = "mma_type_for_me";
  const refId = `t4m:${passId}:b:${bucket}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: false, already: true, successCount: next };

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

// ✅ HISTORY COMPAT
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
  } catch {}
}

// ============================================================================
// DB helpers
// ============================================================================
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

// ============================================================================
// STILL CREATE PIPELINE
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane); // ✅ niche => 2, main => 1
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_create_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    // Collect assets
    const assets = working?.assets || {};
    const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
    const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

    const explicitHero =
      asHttpUrl(
        assets.style_hero_image_url ||
          assets.styleHeroImageUrl ||
          assets.style_hero_url ||
          assets.styleHeroUrl
      ) || "";

    const inspUrlsRaw = safeArray(
      assets.inspiration_image_urls ||
        assets.inspirationImageUrls ||
        assets.style_image_urls ||
        assets.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean);

    const heroCandidates = []
      .concat(explicitHero ? [explicitHero] : [])
      .concat(safeArray(assets.style_hero_image_urls || assets.styleHeroImageUrls).map(asHttpUrl))
      .concat(safeArray(cfg?.seadream?.styleHeroUrls || cfg?.styleHeroUrls).map(asHttpUrl))
      .filter(Boolean);

    const heroKeySet = new Set(heroCandidates.map((u) => normalizeUrlForKey(u)).filter(Boolean));

    const heroFromInsp = !explicitHero
      ? (inspUrlsRaw.find((u) => heroKeySet.has(normalizeUrlForKey(u))) || "")
      : "";

    const heroUrl = explicitHero || heroFromInsp || "";

    if (heroUrl) {
      working.assets = { ...(working.assets || {}), style_hero_image_url: heroUrl };
    }

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

    const labeledImages = []
      // Product pill -> Scene / Composition reference
      .concat(productUrl ? [{ role: "SCENE / COMPOSITION / ASTHETIC / VIBE / STYLE", url: productUrl }] : [])

      // Logo pill -> Logo / Label / Icon / Text reference
      .concat(logoUrl ? [{ role: "LOGO / LABEL / ICON / TEXT / DESIGN", url: logoUrl }] : [])

      // Inspiration pill -> Product / Element / Texture / Material references
      .concat(
        inspUrlsForGpt.map((u, i) => ({
          role: `PRODUCT / ELEMENT / TEXTURE / MATERIAL ${i + 1}`,
          url: u,
        }))
      )
      .slice(0, 10);


    const oneShotInput = {
      user_brief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Write a clean image prompt using the labeled images as references.",
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

    // lane: "main" (default) => Seedream, "niche" => Nano Banana (if enabled)
    const stillLane = resolveStillLane(working);
    const useNano = stillLane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: stillLane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    const imageInputs = useNano ? buildNanoBananaImageInputs(working) : buildSeedreamImageInputs(working);

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    // If user chose match_input_image but no inputs exist, force a safe fallback aspect ratio
    if (!imageInputs.length && String(aspectRatio).toLowerCase().includes("match")) {
      aspectRatio = useNano
        ? process.env.MMA_NANOBANANA_FALLBACK_ASPECT_RATIO || cfg?.nanobanana?.fallbackAspectRatio || "1:1"
        : cfg?.seadream?.fallbackAspectRatio || process.env.MMA_SEADREAM_FALLBACK_ASPECT_RATIO || "1:1";
    }

    let genRes;
    try {
      genRes = useNano
        ? await runNanoBanana({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            resolution: cfg?.nanobanana?.resolution, // optional (env handles your Render vars)
            outputFormat: cfg?.nanobanana?.outputFormat,
            safetyFilterLevel: cfg?.nanobanana?.safetyFilterLevel,
          })
        : await runSeedream({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            size: cfg?.seadream?.size,
            enhancePrompt: cfg?.seadream?.enhancePrompt,
          });

      // ✅ store prediction id for recovery later
      working.outputs = { ...(working.outputs || {}) };
      if (useNano) working.outputs.nanobanana_prediction_id = genRes.prediction_id || null;
      else working.outputs.seedream_prediction_id = genRes.prediction_id || null;

      await updateVars({ supabase, generationId, vars: working });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: useNano ? "nanobanana_generate" : "seedream_generate",
      payload: { input, output: out, timing, error: null },
    });

    const url = pickFirstUrl(out);
    if (!url) throw new Error(useNano ? "NANOBANANA_NO_URL" : "SEADREAM_NO_URL");

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
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
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still create)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// STILL TWEAK PIPELINE
// ============================================================================
async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane); // ✅ niche => 2, main => 1
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

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
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const stillLane = resolveStillLane(working);
    const useNano = stillLane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: stillLane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    // tweak always has a parent image, so match_input_image is fine, but keep fallback anyway
    if (String(aspectRatio).toLowerCase().includes("match") && !parentUrl) {
      aspectRatio = "1:1";
    }

    const forcedInput = useNano
      ? {
          prompt: usedPrompt,
          resolution: cfg?.nanobanana?.resolution || process.env.MMA_NANOBANANA_RESOLUTION || "2K",
          aspect_ratio: aspectRatio,
          output_format: cfg?.nanobanana?.outputFormat || process.env.MMA_NANOBANANA_OUTPUT_FORMAT || "jpg",
          safety_filter_level:
            cfg?.nanobanana?.safetyFilterLevel || process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL || "block_only_high",
          image_input: [parentUrl],
        }
      : {
          prompt: usedPrompt,
          size: cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K",
          aspect_ratio: aspectRatio,
          enhance_prompt: !!cfg?.seadream?.enhancePrompt,
          sequential_image_generation: "disabled",
          max_images: 1,
          image_input: [parentUrl],
        };

    let genRes;
    try {
      genRes = useNano
        ? await runNanoBanana({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs: [parentUrl],
            input: forcedInput,
          })
        : await runSeedream({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs: [parentUrl],
            size: cfg?.seadream?.size,
            enhancePrompt: cfg?.seadream?.enhancePrompt,
            input: forcedInput,
          });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: useNano ? "nanobanana_generate_tweak" : "seedream_generate_tweak",
      payload: { input, output: out, timing, error: null },
    });

    const genUrl = pickFirstUrl(out);
    if (!genUrl) throw new Error(useNano ? "NANOBANANA_NO_URL_TWEAK" : "SEADREAM_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(genUrl, `mma/still/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
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

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// VIDEO ANIMATE PIPELINE (Kling)
// ============================================================================
async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  let videoCost = 5;
  const ctx = await getMmaCtxConfig(supabase);

  const inputs0 = (working?.inputs && typeof working.inputs === "object") ? working.inputs : {};
  const suggestOnly = inputs0.suggest_only === true || inputs0.suggestOnly === true;
  const typeForMe =
    inputs0.type_for_me === true ||
    inputs0.typeForMe === true ||
    inputs0.use_suggestion === true ||
    inputs0.useSuggestion === true;
  const frame2 = resolveFrame2Reference(inputs0, working?.assets);

  if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
    throw makeHttpError(400, "MISSING_FRAME2_DURATION_SEC");
  }

  if (!suggestOnly) {
    videoCost = videoCostFromInputs(inputs0, working?.assets);
    await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });
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

  const pricing = resolveVideoPricing(inputs0, working?.assets);
  const flow = pricing.flow; // "kling" | "kling_motion_control" | "fabric_audio"
  
  ...
  
  let finalMotionPrompt = "";
  
  // 1) optional override (keeps your existing behavior)
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
        flow,
        frame2_kind: frame2?.kind || null,
        frame2_url: frame2?.url || null,
        frame2_duration_sec: frame2?.rawDurationSec || null,
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
    // 2) always run GPT (even for fabric_audio + motion_control)
    const oneShotInput = {
      flow,
      start_image_url: startImage,
      end_image_url: asHttpUrl(endImage) || null,
  
      // ✅ key: tell GPT what the “second input” is (audio/video) + duration
      frame2_kind: frame2?.kind || null,              // "ref_audio" | "ref_video" | null
      frame2_url: frame2?.url || null,
      frame2_duration_sec: frame2?.rawDurationSec || null,
  
      motion_user_brief: motionBrief,
      selected_movement_style: movementStyle,
  
      notes:
        "Write ONE clean motion prompt. If flow is fabric_audio: sync motion to beats/phrasing of the audio. " +
        "If flow is kling_motion_control: assume the reference video drives motion; keep subject consistent and match timing. " +
        "Plain English. No emojis. No questions.",
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
  
  // ✅ safety fallback: never hard-fail fabric just because prompt is empty
  if (!finalMotionPrompt) {
    finalMotionPrompt =
      safeStr(motionBrief, "") ||
      safeStr(inputs0.brief, "") ||
      safeStr(inputs0.prompt, "");
  }
  
  // ✅ but for Kling + motion-control we do require *some* prompt
  if (!finalMotionPrompt && (flow === "kling" || flow === "kling_motion_control")) {
    throw new Error("EMPTY_MOTION_PROMPT");
  }


    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    await updateVars({ supabase, generationId, vars: working });

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

      if (typeForMe) {
        try {
          await commitTypeForMeSuccessAndMaybeCharge({ supabase, passId });
        } catch (e) {
          console.warn("[mma] type-for-me charge failed:", e?.message || e);
        }
      }

      emitStatus(generationId, "suggested");
      sendDone(generationId, "suggested");
      return;
    }

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

    const generateAudioRaw =
      working?.inputs?.generate_audio ??
      working?.inputs?.generateAudio ??
      working?.inputs?.audio_enabled ??
      working?.inputs?.audioEnabled ??
      working?.inputs?.with_audio ??
      working?.inputs?.withAudio ??
      working?.inputs?.mute ??
      working?.inputs?.muted;

    // ✅ default OFF if frontend doesn't send it
    let generateAudio = generateAudioRaw === undefined ? false : !!generateAudioRaw;

    // ✅ 2 frames (end frame present) => ALWAYS force mute on backend too
    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate";

    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        // sensible defaults for motion control
        const kmcMode = safeStr(working?.inputs?.mode || working?.inputs?.kmc_mode, "") || "std";
        const kmcOrientation =
          safeStr(working?.inputs?.character_orientation || working?.inputs?.characterOrientation, "") || "video";
        const keepOriginalSound =
          working?.inputs?.keep_original_sound ?? working?.inputs?.keepOriginalSound ?? true;

        working.meta = { ...(working.meta || {}), video_engine: "kling_motion_control" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: kmcMode,
          keepOriginalSound,
          characterOrientation: kmcOrientation,
        });

        working.outputs = { ...(working.outputs || {}), kling_motion_control_prediction_id: genRes.prediction_id || null };
        stepType = "kling_motion_control_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        const resolution =
          safeStr(working?.inputs?.resolution || working?.inputs?.fabric_resolution, "") || "720p";

        working.meta = { ...(working.meta || {}), video_engine: "fabric_audio" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution,
        });

        working.outputs = { ...(working.outputs || {}), fabric_prediction_id: genRes.prediction_id || null };
        stepType = "fabric_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else {
        working.meta = { ...(working.meta || {}), video_engine: "kling" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        working.outputs = { ...(working.outputs || {}), kling_prediction_id: genRes.prediction_id || null };
        stepType = "kling_generate";
        await updateVars({ supabase, generationId, vars: working });
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("VIDEO_NO_URL");

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
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
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

    if (!suggestOnly) {
      try {
        await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
      } catch (e) {
        console.warn("[mma] refund failed (video animate)", e?.message || e);
      }
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
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

  // ✅ compute real cost 5 or 10 (use parent inputs as fallback)
  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(working?.assets || {}) };
  const pricing = resolveVideoPricing(mergedInputs0, mergedAssets0);
  const frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  const videoCost = videoCostFromInputs(mergedInputs0, mergedAssets0);

  if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
    throw makeHttpError(400, "MISSING_FRAME2_DURATION_SEC");
  }

  await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });

  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

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

    const mergedInputsAudio = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };

    const generateAudioRaw =
      mergedInputsAudio?.generate_audio ??
      mergedInputsAudio?.generateAudio ??
      mergedInputsAudio?.audio_enabled ??
      mergedInputsAudio?.audioEnabled ??
      mergedInputsAudio?.with_audio ??
      mergedInputsAudio?.withAudio ??
      mergedInputsAudio?.mute ??
      mergedInputsAudio?.muted;

    // ✅ default OFF
    let generateAudio = generateAudioRaw === undefined ? false : !!generateAudioRaw;

    // ✅ 2 frames => force mute
    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate_tweak";
    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: safeStr(mergedInputs0?.mode || mergedInputs0?.kmc_mode, "") || "std",
          keepOriginalSound: mergedInputs0?.keep_original_sound ?? mergedInputs0?.keepOriginalSound ?? true,
          characterOrientation:
            safeStr(mergedInputs0?.character_orientation || mergedInputs0?.characterOrientation, "") || "video",
        });

        stepType = "kling_motion_control_generate_tweak";
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution: safeStr(mergedInputs0?.resolution || mergedInputs0?.fabric_resolution, "") || "720p",
        });

        stepType = "fabric_generate_tweak";
      } else {
        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        stepType = "kling_generate_tweak";
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
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
    sendDone(generationId, "done");
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
      await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (video tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
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

  const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
  const stillCost = stillCostForLane(requestedLane);
  await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });

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

  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(body?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(body?.assets || {}) };

  const needed = videoCostFromInputs(mergedInputs0, mergedAssets0);
  await ensureEnoughCredits(passId, needed, { lane: "video" });

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

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";
  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Video session";

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

  const inputs = (body?.inputs && typeof body.inputs === "object") ? body.inputs : {};
  const suggestOnly = inputs.suggest_only === true || inputs.suggestOnly === true;
  const typeForMe =
    inputs.type_for_me === true ||
    inputs.typeForMe === true ||
    inputs.use_suggestion === true ||
    inputs.useSuggestion === true;

  if (mode === "video" && suggestOnly && typeForMe) {
    await preflightTypeForMe({ supabase, passId });
  } else if (mode === "video") {
    const neededVideo = videoCostFromInputs(body?.inputs || {}, body?.assets || {});
    await ensureEnoughCredits(passId, neededVideo, { lane: "video" });
  } else {
    const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
    const stillCost = stillCostForLane(requestedLane);
    await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });
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

  const parent = parentId ? await fetchParentGenerationRow(supabase, parentId).catch(() => null) : null;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

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

export async function refreshFromReplicate({ generationId, passId }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_pass_id, mg_mma_mode, mg_output_url, mg_prompt, mg_mma_vars")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, error: "NOT_FOUND" };

  // security: only same passId can refresh
  if (passId && data.mg_pass_id && String(passId) !== String(data.mg_pass_id)) {
    return { ok: false, error: "FORBIDDEN" };
  }

  if (data.mg_output_url) {
    return { ok: true, refreshed: false, alreadyDone: true, url: data.mg_output_url };
  }

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const mode = String(data.mg_mma_mode || "");
  const outputs = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};

  const predictionId =
    mode === "video"
      ? outputs.kling_motion_control_prediction_id ||
        outputs.klingMotionControlPredictionId ||
        outputs.fabric_prediction_id ||
        outputs.fabricPredictionId ||
        outputs.kling_prediction_id ||
        outputs.klingPredictionId ||
        ""
      : outputs.nanobanana_prediction_id ||
        outputs.nanobananaPredictionId ||
        outputs.seedream_prediction_id ||
        outputs.seedreamPredictionId ||
        "";

  if (!predictionId) {
    return { ok: false, error: "NO_PREDICTION_ID" };
  }

  const replicate = getReplicate();
  const pred = await replicate.predictions.get(String(predictionId));
  const providerStatus = pred?.status || null;

  const url = pickFirstUrl(pred?.output);
  if (!url) {
    return { ok: true, refreshed: false, provider_status: providerStatus };
  }

  // store permanent + finalize
  const remoteUrl = await storeRemoteToR2Public(
    url,
    mode === "video" ? `mma/video/${generationId}` : `mma/still/${generationId}`
  );

  // update vars + final row
  const nextVars = { ...vars, mg_output_url: remoteUrl };
  nextVars.outputs = { ...(nextVars.outputs || {}) };
  if (mode === "video") {
    nextVars.outputs.kling_video_url = remoteUrl;
  } else {
    // prefer storing under the engine that was used
    if (outputs.nanobanana_prediction_id || outputs.nanobananaPredictionId) {
      nextVars.outputs.nanobanana_image_url = remoteUrl;
    } else {
      nextVars.outputs.seedream_image_url = remoteUrl;
    }
  }

  await supabase
    .from("mega_generations")
    .update({
      mg_output_url: remoteUrl,
      mg_status: "done",
      mg_mma_status: "done",
      mg_mma_vars: nextVars,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");

  return { ok: true, refreshed: true, provider_status: providerStatus, url: remoteUrl };
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

  const internal = data.mg_mma_status || data.mg_status || "queued";

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const vOut = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};
  const meta = vars.meta && typeof vars.meta === "object" ? vars.meta : {};

  const stillEngine =
    safeStr(meta.still_engine, "") ||
    (vOut.nanobanana_image_url || vOut.nanobanana_prediction_id ? "nanobanana" : "seedream");

  return {
    generation_id: data.mg_generation_id,
    status: toUserStatus(internal),
    state: internal,

    mma_vars: vars,
    still_engine: data.mg_mma_mode === "still" ? stillEngine : null,

    outputs: {
      seedream_image_url:
        data.mg_mma_mode === "still" && stillEngine === "seedream" ? data.mg_output_url : null,
      nanobanana_image_url:
        data.mg_mma_mode === "still" && stillEngine === "nanobanana" ? data.mg_output_url : null,
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
// IMPORTANT: inject passId from request so it matches router behavior
// ============================================================================
export function createMmaController() {
  const router = express.Router();

  const injectPassId = (req, raw) => {
    const body = raw && typeof raw === "object" ? raw : {};
    const passId = megaResolvePassId(req, body);
    return { passId, body: { ...body, passId } };
  };

  router.post("/still/create", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "still", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] still/create error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] still tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "video", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] video/animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaEvent(body || {});
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
    const internal = String(data?.mg_mma_status || "queued");
    const statusText = internal;

    // ✅ Register client first so sendStatus/sendDone hit THIS connection too
    registerSseClient(req.params.generation_id, res, { scanLines, status: statusText });

    // ✅ If it's already finished (done/error/suggested), immediately emit DONE then close
    const TERMINAL = new Set(["done", "error", "suggested"]);
    if (TERMINAL.has(internal)) {
      try {
        // sendStatus uses your existing SSE format
        sendStatus(req.params.generation_id, statusText);
        // sendDone is what your frontend should listen to to stop "Creating..."
        sendDone(req.params.generation_id, statusText);
      } catch {}
      try {
        res.end();
      } catch {}
      return;
    }

    // Normal keepalive for running generations only
    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));
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
