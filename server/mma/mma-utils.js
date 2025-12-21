// Hero Part 1: Utility helpers for Mina Mind API (MMA)
// Part 1.1: Deterministic pass id + canonical var maps live here so server.js stays slim.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

export function computePassId({ shopifyCustomerId, userId, email }) {
  const normalizedShopify = safeString(shopifyCustomerId, "");
  if (normalizedShopify && normalizedShopify !== "anonymous") {
    return `pass:shopify:${normalizedShopify}`;
  }

  const normalizedUser = safeString(userId, "");
  if (normalizedUser) return `pass:user:${normalizedUser}`;

  const normalizedEmail = safeString(email, "").toLowerCase();
  if (normalizedEmail) return `pass:email:${normalizedEmail}`;

  return `pass:anon:${crypto.randomUUID()}`;
}

export function makeInitialVars({
  mode = "still",
  assets = {},
  history = {},
  inputs = {},
  prompts = {},
  feedback = {},
  settings = {},
} = {}) {
  return {
    version: "2025-12-19",
    mode,
    assets: {
      product_image_id: assets.product_image_id || null,
      logo_image_id: assets.logo_image_id || null,
      inspiration_image_ids: assets.inspiration_image_ids || [],
      style_hero_image_id: assets.style_hero_image_id || null,
      input_still_image_id: assets.input_still_image_id || null,
    },
    scans: {
      product_crt: null,
      logo_crt: null,
      inspiration_crt: [],
      still_crt: null,
      output_still_crt: null,
    },
    history: {
      vision_intelligence: history.vision_intelligence ?? true,
      like_window: history.vision_intelligence === false ? 20 : 5,
      style_history_csv: history.style_history_csv || null,
    },
    inputs: {
      userBrief: inputs.userBrief || "",
      style: inputs.style || "",
      motion_user_brief: inputs.motion_user_brief || "",
      movement_style: inputs.movement_style || "",
    },
    prompts: {
      clean_prompt: prompts.clean_prompt || null,
      motion_prompt: prompts.motion_prompt || null,
      motion_sugg_prompt: prompts.motion_sugg_prompt || null,
    },
    feedback: {
      still_feedback: feedback.still_feedback || null,
      motion_feedback: feedback.motion_feedback || null,
    },
    userMessages: { scan_lines: [], final_line: null },
    settings: { seedream: settings.seedream || {}, kling: settings.kling || {} },
    outputs: { seedream_image_id: null, kling_video_id: null },
    meta: { ctx_versions: {}, settings_versions: {} },
  };
}

export function appendScanLine(vars, text) {
  const next = { ...(vars || makeInitialVars({})), userMessages: { ...(vars?.userMessages || { scan_lines: [], final_line: null }) } };
  const scanLines = Array.isArray(next.userMessages.scan_lines)
    ? [...next.userMessages.scan_lines]
    : [];
  const payload = typeof text === "string" ? { index: scanLines.length, text } : text;
  scanLines.push(payload);
  next.userMessages.scan_lines = scanLines;
  return next;
}

export function makePlaceholderUrl(kind, id) {
  const base = safeString(process.env.R2_PUBLIC_BASE_URL, "https://example.r2.dev");
  return `${base.replace(/\/+$/, "")}/${kind}/${id}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function generationIdentifiers(generationId) {
  return {
    mg_id: `generation:${generationId}`,
    mg_generation_id: generationId,
    mg_record_type: "generation",
  };
}

export function stepIdentifiers(generationId, stepNo) {
  return {
    mg_id: `mma_step:${generationId}:${stepNo}`,
    mg_generation_id: generationId,
    mg_record_type: "mma_step",
    mg_step_no: stepNo,
  };
}

export function eventIdentifiers(eventId) {
  return {
    mg_id: `mma_event:${eventId}`,
    mg_record_type: "mma_event",
  };
}

export function newUuid() {
  return uuidv4();
}
