// ./server/mma/mma-cost-calculator.js
// Real USD cost estimation for every Mina generation type.
// Prices are best-effort based on official API pricing (March 2026).
// Update the constants below when provider pricing changes.

// ============================================================================
// MODEL COST TABLES (USD)
// ============================================================================

// --- Kling Video (KlingAI HTTP API) ---
// Source: Real billing data + $97.99 / 1000 units trial package
// 1 Kling unit = $0.09799 USD
const KLING_UNIT_PRICE_USD = 97.99 / 1000; // $0.09799/unit

const KLING_COSTS = {
  // model -> mode -> { perSecond, withAudio?, withVideo? }
  // Rates derived from billing: units/sec × KLING_UNIT_PRICE_USD
  "kling-v3-omni": {
    // omni uses official listed rates (no billing data yet)
    standard: { perSecond: 0.084, withAudio: 0.112, withVideo: 0.126 },
    pro:      { perSecond: 0.112, withAudio: 0.14,  withVideo: 0.168 },
  },
  "kling-v3": {
    // Verified from real Kling billing (March 2026):
    // Pro sound-off: 0.8 units/s → $0.0784/s
    // Pro sound-on:  1.2 units/s → $0.1176/s (1.5x base)
    // Standard estimated at 75% of pro rates
    standard: { perSecond: 0.0588, withAudio: 0.0882, withVideo: 0.1176 },
    pro:      { perSecond: 0.0784, withAudio: 0.1176, withVideo: 0.1568 },
  },
  "kling-v2.6": {
    // per-block pricing: standard 5s=$0.21, 10s=$0.42 ; pro 5s=$0.35, 10s=$0.70
    standard: { perSecond: 0.042 },
    pro:      { perSecond: 0.07, withAudio: 0.168 },
  },
  "kling-v2.1": {
    // standard 5s=$0.28, 10s=$0.56 ; pro 5s=$0.49, 10s=$0.98
    standard: { perSecond: 0.056 },
    pro:      { perSecond: 0.098 },
  },
};

// --- Fabric (audio-to-video via Replicate) ---
// Source: fal.ai pricing and WaveSpeed comparisons
const FABRIC_COSTS = {
  "480p": 0.08,  // USD per second of output
  "720p": 0.15,
};

// --- Seedream (still image via Replicate) ---
// Source: Replicate/BytePlus pricing ~$0.03/image
const SEEDREAM_COST_PER_IMAGE = 0.03;

// --- Nanobanana / Gemini Flash Image (still image via Google Gemini API) ---
// Source: Real usage costs - main lane ~$0.15/image, niche lane ~$0.22/image
const GEMINI_IMAGE_COSTS = {
  "gemini-3.1-flash-image-preview": {
    "1K": 0.067,  // ~1120 output tokens
    "2K": 0.101,  // ~1680 output tokens
    "4K": 0.15,   // main lane real cost
  },
  "gemini-3-pro-image-preview": {
    "1K": 0.134,
    "2K": 0.22,   // niche lane real cost
    "4K": 0.22,   // niche lane real cost
  },
};

// --- GPT prompt-generation calls (OpenAI) ---
// Source: OpenAI API pricing
// Average per-call cost based on typical token usage (~200 input, ~100 output tokens)
const GPT_CALL_COSTS = {
  "gpt-5-mini":  { inputPer1M: 0.25, outputPer1M: 2.00, avgCallCost: 0.00025 },
  "gpt-4o":      { inputPer1M: 2.50, outputPer1M: 10.0, avgCallCost: 0.0015 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60, avgCallCost: 0.00012 },
};

// --- Fingertips (Replicate) ---
const FINGERTIPS_API_COSTS = {
  eraser:     0.04,    // bria/eraser ~$0.04/run
  flux_fill:  0.03,    // bria/genfill ~$0.02-0.04/run
  expand:     0.04,    // bria/expand-image ~$0.04/run
  remove_bg:  0.0015,  // men1scus/birefnet ~$0.0015/run
  upscale:    0.03,    // crystal or magic upscaler ~$0.02-0.04/run
  vectorize:  0.01,    // recraft-vectorize ~$0.01/run
};

// ============================================================================
// FIXED MONTHLY COSTS (infrastructure + subscriptions, USD)
// ============================================================================
const FIXED_MONTHLY_COSTS = {
  // --- Infrastructure (from Render receipt March 2026) ---
  render_static_sites: 0,      // 2 instances (free)
  render_servers:      7,      // 2 instances
  render_postgres:     6.30,   // 2 instances
  render_pro_plan:     38,     // Pro plan (2 users)
  cloudflare_r2:       0,      // free tier for small storage
  supabase:            25,     // Pro plan

  // --- AI Subscriptions (development & prompt engineering) ---
  chatgpt_pro:         200,    // ChatGPT Pro ($200/mo)
  claude_max:          200,    // Claude Max 20x ($200/mo)
  github_copilot:      10,     // Copilot Pro ($10/mo)

  // --- API packages ---
  kling_package:       97.99,  // Trial-Video-1000Units ($97.99/mo)

  // --- Pay-as-you-go (estimated monthly spend) ---
  replicate:           40,     // ~$40/mo estimated (Seedream, Bria, birefnet, etc.)
};

const TOTAL_FIXED_MONTHLY = Object.values(FIXED_MONTHLY_COSTS).reduce((a, b) => a + b, 0);

// Estimated generations per month (used to amortize fixed costs)
const EST_GENERATIONS_PER_MONTH = Number(process.env.MINA_EST_GENERATIONS_PER_MONTH || 1000);

// Fixed overhead amortized per generation
const FIXED_COST_PER_GENERATION = TOTAL_FIXED_MONTHLY / EST_GENERATIONS_PER_MONTH;

// ============================================================================
// SELL PRICE (what we charge users in USD per matcha)
// ============================================================================
const MATCHA_SELL_PRICE_USD = Number(process.env.MINA_MATCHA_SELL_PRICE_USD || 0.035);

// ============================================================================
// COST CALCULATOR FUNCTIONS
// ============================================================================

/**
 * Estimate USD cost for a Kling video generation.
 */
export function estimateKlingCost({
  modelName = "kling-v3",
  mode = "pro",
  durationSec = 5,
  hasAudio = false,
  hasRefVideo = false,
}) {
  const modelKey = Object.keys(KLING_COSTS).find((k) => modelName.includes(k)) || "kling-v3";
  const modeKey = mode === "standard" ? "standard" : "pro";
  const pricing = KLING_COSTS[modelKey]?.[modeKey] || KLING_COSTS["kling-v3"].pro;

  let rate = pricing.perSecond;
  if (hasRefVideo && pricing.withVideo) rate = pricing.withVideo;
  else if (hasAudio && pricing.withAudio) rate = pricing.withAudio;

  return round(rate * durationSec);
}

/**
 * Estimate USD cost for a Fabric audio-to-video generation.
 */
export function estimateFabricCost({ durationSec = 5, resolution = "480p" }) {
  const rate = FABRIC_COSTS[resolution] || FABRIC_COSTS["480p"];
  return round(rate * durationSec);
}

/**
 * Estimate USD cost for a Seedream still image generation.
 */
export function estimateSeedreamCost() {
  return SEEDREAM_COST_PER_IMAGE;
}

/**
 * Estimate USD cost for a Gemini/Nanobanana still image generation.
 */
export function estimateGeminiImageCost({ model = "gemini-3.1-flash-image-preview", resolution = "4K" }) {
  const modelCosts = GEMINI_IMAGE_COSTS[model] || GEMINI_IMAGE_COSTS["gemini-3.1-flash-image-preview"];
  return modelCosts[resolution] || modelCosts["4K"];
}

/**
 * Estimate USD cost for a GPT prompt-generation call.
 */
export function estimateGptCallCost({ model = "gpt-5-mini" } = {}) {
  const info = GPT_CALL_COSTS[model] || GPT_CALL_COSTS["gpt-5-mini"];
  return info.avgCallCost;
}

/**
 * Estimate USD cost for a fingertips operation.
 */
export function estimateFingertipsCost({ modelKey = "eraser" }) {
  return FINGERTIPS_API_COSTS[modelKey] || 0.015;
}

// ============================================================================
// FULL GENERATION COST ESTIMATOR
// ============================================================================

/**
 * Estimate the total real USD cost of a generation (model + GPT calls).
 *
 * @param {object} opts
 * @param {"still"|"video"|"fingertips"} opts.mode
 * @param {string} opts.modelUsed - e.g. "kling-v3", "seedream", "gemini-3.1-flash-image-preview"
 * @param {string} opts.lane - "main" | "niche" (still only)
 * @param {number} opts.durationSec - video duration
 * @param {string} opts.videoMode - "standard" | "pro"
 * @param {boolean} opts.hasAudio
 * @param {boolean} opts.hasRefVideo
 * @param {string} opts.resolution - "1K" | "2K" | "4K"
 * @param {string} opts.fabricResolution - "480p" | "720p"
 * @param {string} opts.fingertipsKey - fingertips model key
 * @param {number} opts.gptCalls - number of GPT prompt calls (default 1-2)
 * @param {string} opts.gptModel - GPT model used
 * @param {number} opts.matchasCharged - how many matchas the user was charged
 */
export function estimateGenerationCost(opts = {}) {
  const {
    mode = "still",
    modelUsed = "",
    lane = "main",
    durationSec = 5,
    videoMode = "pro",
    hasAudio = false,
    hasRefVideo = false,
    resolution = "4K",
    fabricResolution = "480p",
    fingertipsKey = "",
    gptCalls = 2,
    gptModel = "gpt-5-mini",
    matchasCharged = 0,
  } = opts;

  let modelCost = 0;
  let gptCost = 0;
  let totalCost = 0;
  let sellPrice = 0;
  let profit = 0;
  let costBreakdown = {};

  // GPT prompt generation cost
  gptCost = round(estimateGptCallCost({ model: gptModel }) * gptCalls);

  if (mode === "video") {
    if (hasRefVideo) {
      // Kling motion control (omni)
      modelCost = estimateKlingCost({
        modelName: "kling-v3-omni",
        mode: videoMode,
        durationSec,
        hasRefVideo: true,
      });
      costBreakdown.provider = "kling_motion_control";
    } else if (modelUsed.includes("fabric")) {
      // Fabric audio-to-video
      modelCost = estimateFabricCost({ durationSec, resolution: fabricResolution });
      costBreakdown.provider = "fabric";
    } else {
      // Standard Kling video
      modelCost = estimateKlingCost({
        modelName: modelUsed || "kling-v3",
        mode: videoMode,
        durationSec,
        hasAudio,
      });
      costBreakdown.provider = "kling";
    }
  } else if (mode === "still") {
    if (lane === "niche" || modelUsed.includes("seedream") || modelUsed.includes("bytedance")) {
      modelCost = estimateSeedreamCost();
      costBreakdown.provider = "seedream";
    } else {
      modelCost = estimateGeminiImageCost({
        model: modelUsed || "gemini-3.1-flash-image-preview",
        resolution,
      });
      costBreakdown.provider = "gemini";
    }
  } else if (mode === "fingertips") {
    modelCost = estimateFingertipsCost({ modelKey: fingertipsKey });
    gptCost = fingertipsKey === "upscale" ? estimateGptCallCost({ model: "gpt-4o" }) : 0;
    costBreakdown.provider = `fingertips_${fingertipsKey}`;
  }

  totalCost = round(modelCost + gptCost);
  const fixedOverhead = round(FIXED_COST_PER_GENERATION);
  const totalCostWithFixed = round(totalCost + fixedOverhead);
  sellPrice = round(matchasCharged * MATCHA_SELL_PRICE_USD);
  profit = round(sellPrice - totalCost);
  const profitAfterFixed = round(sellPrice - totalCostWithFixed);

  return {
    api_cost_usd: totalCost,
    model_cost_usd: modelCost,
    gpt_cost_usd: gptCost,
    fixed_overhead_usd: fixedOverhead,
    total_cost_usd: totalCostWithFixed,
    sell_price_usd: sellPrice,
    profit_usd: profit,
    profit_after_fixed_usd: profitAfterFixed,
    matchas_charged: matchasCharged,
    matcha_unit_price_usd: MATCHA_SELL_PRICE_USD,
    fixed_monthly_total_usd: TOTAL_FIXED_MONTHLY,
    est_generations_per_month: EST_GENERATIONS_PER_MONTH,
    ...costBreakdown,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function round(n) {
  return Math.round(n * 100000) / 100000; // 5 decimal places for small costs
}

/**
 * Return the full fixed monthly cost breakdown.
 */
export function getFixedCostBreakdown() {
  return {
    monthly_costs: { ...FIXED_MONTHLY_COSTS },
    total_monthly_usd: round(TOTAL_FIXED_MONTHLY),
    est_generations_per_month: EST_GENERATIONS_PER_MONTH,
    fixed_per_generation_usd: round(FIXED_COST_PER_GENERATION),
  };
}

/**
 * Build cost params from a generation's vars/inputs (convenience for writeGeneration flow).
 */
export function costParamsFromVars(vars, mode) {
  const inputs = vars?.inputs || {};
  const assets = vars?.assets || {};

  const hasRefVideo = !!(
    assets.frame2_video_url ||
    inputs.frame2_video_url ||
    inputs.frame2VideoUrl
  );
  const hasAudio = !!(
    inputs.generate_audio ||
    inputs.generateAudio ||
    assets.frame2_audio_url
  );

  const durationSec =
    Number(
      inputs.motion_duration_sec ||
      inputs.motionDurationSec ||
      inputs.duration ||
      inputs.duration_sec ||
      5
    ) || 5;

  const videoMode =
    inputs.mode || inputs.kling_mode || inputs.klingMode || "pro";

  const resolution =
    inputs.still_resolution || inputs.resolution || "4K";

  const modelUsed =
    inputs.model_used || inputs.modelUsed || inputs.model || "";

  const lane =
    inputs.still_lane || inputs.stillLane || inputs.lane || "main";

  const fabricResolution =
    inputs.fabric_resolution || inputs.fabricResolution || "480p";

  const gptModel =
    inputs.gpt_model || inputs.gptModel || "gpt-5-mini";

  return {
    mode: mode || (vars?.mode === "video" ? "video" : "still"),
    modelUsed,
    lane,
    durationSec,
    videoMode,
    hasAudio,
    hasRefVideo,
    resolution,
    fabricResolution,
    gptModel,
    gptCalls: mode === "video" ? 2 : 2, // typically 2 GPT calls per generation
  };
}
