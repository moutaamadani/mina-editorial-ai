// ./server/mma/mma-utils.js
// Part 1: Utility helpers for Mina Mind API (MMA)
// Part 1.1: Deterministic pass id + canonical var maps live here so server.js stays slim.

import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";

// -----------------------------------------------------------------------------
// Editable behavior flags (keep at top so you can tweak easily)
// -----------------------------------------------------------------------------
const MMA_VERSION = "2025-12-23";

// Keep current behavior by default to avoid breaking existing customers.
// If you ever want to stop storing plaintext emails inside passId, set:
// MMA_PASSID_HASH_EMAIL=true  (⚠️ will create new passIds for same users)
const MMA_PASSID_HASH_EMAIL = String(process.env.MMA_PASSID_HASH_EMAIL || "").toLowerCase() === "true";

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------
function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asStrOrNull(v) {
  const s = safeString(v, "");
  return s ? s : null;
}

function hashEmail(email) {
  const e = safeString(email, "").toLowerCase();
  if (!e) return "";
  return crypto.createHash("sha256").update(e).digest("hex").slice(0, 40);
}

// -----------------------------------------------------------------------------
// PassId
// -----------------------------------------------------------------------------
export function computePassId({ shopifyCustomerId, userId, email }) {
  const normalizedShopify = safeString(shopifyCustomerId, "");
  if (normalizedShopify && normalizedShopify !== "anonymous") {
    return `pass:shopify:${normalizedShopify}`;
  }

  const normalizedUser = safeString(userId, "");
  if (normalizedUser) return `pass:user:${normalizedUser}`;

  const normalizedEmail = safeString(email, "").toLowerCase();
  if (normalizedEmail) {
    if (MMA_PASSID_HASH_EMAIL) return `pass:emailhash:${hashEmail(normalizedEmail)}`;
    return `pass:email:${normalizedEmail}`;
  }

  // If frontend doesn't send passId, we generate a random anon one (non-sticky).
  // In production, prefer passing passId from client for a consistent identity.
  return `pass:anon:${crypto.randomUUID()}`;
}

// -----------------------------------------------------------------------------
// Vars canonicalizer (single source of truth for pipelines)
// -----------------------------------------------------------------------------
export function makeInitialVars({
  mode = "still",
  assets = {},
  history = {},
  inputs = {},
  prompts = {},
  feedback = {},
  settings = {},
} = {}) {
  // --------
  // Assets: URLs
  // --------
  const productUrl = asStrOrNull(assets.productImageUrl || assets.product_image_url || assets.product_url);
  const logoUrl = asStrOrNull(assets.logoImageUrl || assets.logo_image_url || assets.logo_url);

  // Inspirations may arrive under many keys (frontend + older names)
  const inspirationUrls = []
    .concat(asArray(assets.inspiration_image_urls))
    .concat(asArray(assets.inspirationImageUrls))
    .concat(asArray(assets.style_image_urls))
    .concat(asArray(assets.styleImageUrls))
    .concat(asArray(assets.inspiration_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const styleHeroUrl = asStrOrNull(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  // ✅ Frame2 reference media (audio/video) — KEEP IT (controller needs it)
  const frame2AudioUrl = asStrOrNull(
    assets.frame2_audio_url ||
      assets.frame2AudioUrl ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.audio
  );

  const frame2VideoUrl = asStrOrNull(
    assets.frame2_video_url ||
      assets.frame2VideoUrl ||
      assets.video_url ||
      assets.videoUrl ||
      assets.video
  );

  // ✅ Frame2 canonical inputs (audio/video reference for motion)
  const frame2Kind = safeString(
    inputs.frame2_kind ||
      inputs.frame2Kind ||
      (frame2AudioUrl ? "audio" : frame2VideoUrl ? "video" : ""),
    ""
  );

  const frame2Url =
    asStrOrNull(inputs.frame2_url || inputs.frame2Url) ||
    (frame2Kind.toLowerCase().includes("audio") ? frame2AudioUrl : frame2VideoUrl) ||
    frame2AudioUrl ||
    frame2VideoUrl ||
    null;

  const frame2DurationSecRaw =
    inputs.frame2_duration_sec ||
    inputs.frame2DurationSec ||
    assets.frame2_duration_sec ||
    assets.frame2DurationSec ||
    null;

  const frame2DurationSec =
    frame2DurationSecRaw != null && frame2DurationSecRaw !== ""
      ? Number(frame2DurationSecRaw)
      : null;

  // Kling reference images (optional, besides start/end)
  const klingUrls = []
    .concat(asArray(assets.kling_images))
    .concat(asArray(assets.klingImages))
    .concat(asArray(assets.kling_image_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const startUrl = asStrOrNull(assets.start_image_url || assets.startImageUrl);
  const endUrl = asStrOrNull(assets.end_image_url || assets.endImageUrl);

  // --------
  // Inputs canonical fields
  // --------
  const brief = safeString(inputs.brief || inputs.userBrief || inputs.prompt, "");

  // Motion brief can come in many forms
  const motionUserBrief = safeString(
    inputs.motion_user_brief ||
      inputs.motionBrief ||
      inputs.motion_description ||
      inputs.motionDescription ||
      "",
    ""
  );

  // Movement style: prefer selected_movement_style (your spec)
  const selectedMovementStyle = safeString(
    inputs.selected_movement_style ||
      inputs.movement_style ||
      inputs.movementStyle ||
      "",
    ""
  );

  // Suggest flags used in your video pipeline
  const typeForMe = inputs.type_for_me ?? inputs.typeForMe ?? inputs.use_suggestion ?? false;
  const suggestOnly = inputs.suggest_only ?? inputs.suggestOnly ?? false;

  // --------
  // Prompts canonical fields
  // --------
  const cleanPrompt = prompts.clean_prompt || prompts.cleanPrompt || null;
  const motionPrompt = prompts.motion_prompt || prompts.motionPrompt || null;

  // IMPORTANT: your controller uses `sugg_prompt`
  const suggPrompt =
    prompts.sugg_prompt ||
    prompts.suggPrompt ||
    prompts.motion_sugg_prompt ||
    prompts.motionSuggPrompt ||
    null;

  // --------
  // History
  // --------
  const visionIntelligence = history.vision_intelligence ?? true;
  const likeWindow = visionIntelligence === false ? 20 : 5;

  return {
    version: MMA_VERSION,
    mode,

    assets: {
      // legacy ids (kept)
      product_image_id: assets.product_image_id || null,
      logo_image_id: assets.logo_image_id || null,
      inspiration_image_ids: assets.inspiration_image_ids || [],
      style_hero_image_id: assets.style_hero_image_id || null,
      input_still_image_id: assets.input_still_image_id || null,

      // ✅ urls (canonical)
      product_image_url: productUrl,
      logo_image_url: logoUrl,

      // Store inspirations in BOTH names so older code keeps working
      inspiration_image_urls: inspirationUrls,
      style_image_urls: inspirationUrls,

      style_hero_image_url: styleHeroUrl,

      // ✅ keep ref media for video flows
      audio: frame2AudioUrl,
      audio_url: frame2AudioUrl,
      frame2_audio_url: frame2AudioUrl,

      video: frame2VideoUrl,
      video_url: frame2VideoUrl,
      frame2_video_url: frame2VideoUrl,

      // Kling helpers
      kling_image_urls: klingUrls,
      start_image_url: startUrl,
      end_image_url: endUrl,

      frame2_duration_sec: frame2DurationSec,
    },

    scans: {
      product_crt: null,
      logo_crt: null,
      inspiration_crt: [],
      still_crt: null,
      output_still_crt: null,
    },

    history: {
      vision_intelligence: visionIntelligence,
      like_window: likeWindow,
      style_history_csv: history.style_history_csv || null,
    },

    inputs: {
      // ✅ canonical fields your controller reads
      brief,

      // ✅ keep lane selection (this is what resolveStillLane() reads)
      still_lane: safeString(
        inputs.still_lane ||
          inputs.stillLane ||
          inputs.model_lane ||
          inputs.modelLane ||
          inputs.lane ||
          inputs.create_lane ||
          inputs.createLane,
        ""
      ),
      still_resolution: safeString(
        inputs.still_resolution ||
          inputs.stillResolution ||
          inputs.resolution ||
          inputs.image_resolution ||
          inputs.imageResolution,
        ""
      ),
      resolution: safeString(
        inputs.resolution ||
          inputs.still_resolution ||
          inputs.stillResolution ||
          inputs.image_resolution ||
          inputs.imageResolution,
        ""
      ),

      motion_user_brief: motionUserBrief,
      selected_movement_style: selectedMovementStyle,

      // mirror start/end here too (makes motion ctx wiring easier)
      start_image_url: asStrOrNull(inputs.start_image_url || inputs.startImageUrl) || startUrl,
      end_image_url: asStrOrNull(inputs.end_image_url || inputs.endImageUrl) || endUrl,

      // suggestion controls (video “Type for me”)
      type_for_me: !!typeForMe,
      suggest_only: !!suggestOnly,

      // ✅ keep prompt override controls (your controller reads these)
      use_prompt_override: !!(inputs.use_prompt_override ?? inputs.usePromptOverride ?? false),
      prompt_override: safeString(
        inputs.prompt_override ||
          inputs.motion_prompt_override ||
          inputs.motionPromptOverride ||
          "",
        ""
      ),

      // ✅ frame2 reference media for Fabric / KMC
      frame2_kind: frame2Kind,
      frame2_url: frame2Url,
      frame2_duration_sec: frame2DurationSec,

      // keep old fields too
      userBrief: safeString(inputs.userBrief, ""),
      style: safeString(inputs.style, ""),
      movement_style: safeString(inputs.movement_style, ""), // legacy

      platform: safeString(inputs.platform || inputs.platformKey, ""),
      aspect_ratio: safeString(inputs.aspect_ratio || inputs.aspectRatio, ""),
      duration: inputs.duration ?? null,
      mode: safeString(inputs.mode || inputs.kling_mode, ""),
      negative_prompt: safeString(inputs.negative_prompt || inputs.negativePrompt, ""),
    },

    prompts: {
      clean_prompt: cleanPrompt,
      motion_prompt: motionPrompt,

      // ✅ canonical for video suggestion flow
      sugg_prompt: suggPrompt,

      // legacy alias preserved
      motion_sugg_prompt: suggPrompt,
    },

    feedback: {
      still_feedback: feedback.still_feedback || feedback.feedback_still || null,
      motion_feedback: feedback.motion_feedback || feedback.feedback_motion || null,
    },

    userMessages: { scan_lines: [], final_line: null },

    settings: {
      seedream: settings.seedream || {},
      kling: settings.kling || {},
    },

    outputs: {
      // urls your pipelines write
      seedream_image_url: null,
      kling_video_url: null,

      // legacy ids (optional)
      seedream_image_id: null,
      kling_video_id: null,
    },

    meta: { ctx_versions: {}, settings_versions: {} },
  };
}

// -----------------------------------------------------------------------------
// Scan line helper (if you ever want to use it instead of controller helper)
// -----------------------------------------------------------------------------
export function appendScanLine(vars, text) {
  const base = vars && typeof vars === "object" ? vars : makeInitialVars({});
  const next = {
    ...base,
    userMessages: {
      ...(base.userMessages || { scan_lines: [], final_line: null }),
    },
  };

  const scanLines = Array.isArray(next.userMessages.scan_lines)
    ? [...next.userMessages.scan_lines]
    : [];

  const t = typeof text === "string" ? text : safeString(text?.text, "");
  if (!t) return next;

  scanLines.push({ index: scanLines.length, text: t });
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
