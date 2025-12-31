// ./server/mma/mma-config.js

const pickEnv = (keys, fallback = "") => {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
};

const parseBool = (v, fallback = false) => {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
};

const parseNum = (v, fallback) => {
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const asStr = (v) => (typeof v === "string" ? v : "");

const isHttpUrl = (u) => {
  const s = asStr(u).trim();
  return s.startsWith("http://") || s.startsWith("https://");
};

const dedupe = (arr) => {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = asStr(x).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

// Accept:
// - JSON array: ["https://...","https://..."]
// - CSV: "https://..., https://..."
// - Newlines: "https://...\nhttps://..."
const parseUrlList = (raw) => {
  const s = asStr(raw).trim();
  if (!s) return [];

  // JSON array
  if (s.startsWith("[")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return dedupe(j.map(String).filter(isHttpUrl));
    } catch {
      // fall through
    }
  }

  // CSV / newline
  const parts = s
    .split(/[\n,]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter(isHttpUrl);

  return dedupe(parts);
};

// Optional map:
// MMA_SEADREAM_STYLE_HERO_MAP='{"styleA":["https://.."],"styleB":["https://..","https://.."]}'
const parseHeroMap = (raw) => {
  const s = asStr(raw).trim();
  if (!s) return null;

  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = asStr(k).trim();
      if (!key) continue;

      if (Array.isArray(v)) {
        out[key] = dedupe(v.map(String).filter(isHttpUrl));
      } else if (typeof v === "string") {
        out[key] = parseUrlList(v);
      }
    }

    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
};

// Merge multiple env keys into one URL list
const parseUrlListFromEnvKeys = (keys) => {
  const all = [];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v !== "string" || !v.trim()) continue;
    all.push(...parseUrlList(v));
  }
  return dedupe(all);
};

export function getMmaConfig() {
  const enabled = parseBool(pickEnv(["MMA_ENABLED"], "1"), true);

  const gptModel = pickEnv(["MMA_GPT_MODEL"], "gpt-5-mini");

  // -----------------------------
  // SeaDream (still image)
  // -----------------------------
  const seadreamModel = pickEnv(
    ["MMA_SEADREAM_VERSION", "MMA_SEADREAM_MODEL_VERSION", "SEADREAM_MODEL_VERSION"],
    "bytedance/seedream-4"
  );

  const seadreamSize = pickEnv(["MMA_SEADREAM_SIZE"], "4K"); // 1K | 2K | 4K | custom
  const seadreamAspectRatio = pickEnv(["MMA_SEADREAM_ASPECT_RATIO"], "match_input_image");

  const seadreamEnhance = parseBool(pickEnv(["MMA_SEADREAM_ENHANCE_PROMPT"], "false"), false);

  // You asked for these env keys specifically:
  const negativeSeedream = pickEnv(
    ["NEGATIVE_PROMPT_SEADREAM", "negative_prompt_seedream", "MMA_NEGATIVE_PROMPT_SEADREAM"],
    ""
  ).trim();

  // -----------------------------
  // NanoBanana (still image - niche)
  // -----------------------------
  const nanobananaModel = pickEnv(
    ["MMA_NANOBANANA_VERSION", "MMA_NANOBANANA_MODEL_VERSION", "NANOBANANA_MODEL_VERSION"],
    ""
  );

  const nanobananaResolution = pickEnv(["MMA_NANOBANANA_RESOLUTION"], "4K"); // 1K | 2K | 4K
  const nanobananaAspectRatio = pickEnv(["MMA_NANOBANANA_ASPECT_RATIO"], "match_input_image");

  const nanobananaOutputFormat = pickEnv(["MMA_NANOBANANA_OUTPUT_FORMAT"], "jpg"); // jpg | png

  const nanobananaSafetyFilterLevel = pickEnv(
    ["MMA_NANOBANANA_SAFETY_FILTER_LEVEL"],
    "block_only_high"
  ); // block_low_and_above | block_medium_and_above | block_only_high

  // -----------------------------
  // ✅ Style hero URLs (for filtering GPT inputs + feeding Seedream)
  // -----------------------------
  // Put ALL hero URLs for your 3 styles into any of these env vars (CSV/newlines or JSON array):
  // - MMA_SEADREAM_STYLE_HERO_URLS
  // - MMA_STYLE_HERO_URLS
  // - MMA_SEADREAM_STYLE_HERO_URLS_JSON
  //
  // Optional map (styleKey -> urls):
  // - MMA_SEADREAM_STYLE_HERO_MAP (JSON object)
  const styleHeroUrls = parseUrlListFromEnvKeys([
    "MMA_SEADREAM_STYLE_HERO_URLS",
    "MMA_STYLE_HERO_URLS",
    "MMA_SEADREAM_STYLE_HERO_URLS_JSON",
  ]);

  const styleHeroMap = parseHeroMap(process.env.MMA_SEADREAM_STYLE_HERO_MAP || "");

  // also include map URLs into the global list (helps detection)
  const mapUrls = styleHeroMap
    ? dedupe(Object.values(styleHeroMap).flat().filter(isHttpUrl))
    : [];

  const finalHeroUrls = dedupe([...styleHeroUrls, ...mapUrls]);

  // -----------------------------
  // Kling (video)
  // -----------------------------
  const klingModel = pickEnv(
    ["MMA_KLING_VERSION", "MMA_KLING_MODEL_VERSION", "KLING_MODEL_VERSION"],
    "kwaivgi/kling-v2.1"
  );

  const klingMode = pickEnv(["MMA_KLING_MODE"], "pro"); // standard | pro
  const klingDuration = parseNum(pickEnv(["MMA_KLING_DURATION"], "5"), 5);

  const negativeKling = pickEnv(
    ["NEGATIVE_PROMPT_KLING", "negative_prompt_kling", "MMA_NEGATIVE_PROMPT_KLING"],
    ""
  ).trim();

  return {
    enabled,
    gptModel,

    // (optional) keep at top-level too, in case you want it elsewhere later
    styleHeroUrls: finalHeroUrls,

    seadream: {
      model: seadreamModel,
      size: seadreamSize,

      // ✅ match what your controller expects
      aspectRatio: seadreamAspectRatio,

      // optional aliases (safe if older code referenced these)
      aspect: seadreamAspectRatio,

      enhancePrompt: seadreamEnhance,
      negativePrompt: negativeSeedream,

      // ✅ this is what the controller patch reads
      styleHeroUrls: finalHeroUrls,

      // optional (not required by the controller patch)
      styleHeroMap,
    },

    nanobanana: {
      model: nanobananaModel,
      resolution: nanobananaResolution,
      aspectRatio: nanobananaAspectRatio,
      outputFormat: nanobananaOutputFormat,
      safetyFilterLevel: nanobananaSafetyFilterLevel,
    },

    kling: {
      model: klingModel,
      mode: klingMode,
      duration: klingDuration,
      negativePrompt: negativeKling,
    },
  };
}
