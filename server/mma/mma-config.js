// src/routes/mma/mma-config.js
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

export function getMmaConfig() {
  const enabled = parseBool(pickEnv(["MMA_ENABLED"], "1"), true);

  const gptModel = pickEnv(["MMA_GPT_MODEL"], "gpt-5-mini");

  const seadreamModel = pickEnv(
    ["MMA_SEADREAM_VERSION", "MMA_SEADREAM_MODEL_VERSION", "SEADREAM_MODEL_VERSION"],
    "bytedance/seedream-4"
  );
  const seadreamSize = pickEnv(["MMA_SEADREAM_SIZE"], "4K"); // 1K | 2K | 4K | custom
  const seadreamAspect = pickEnv(["MMA_SEADREAM_ASPECT_RATIO"], "match_input_image");
  const seadreamEnhance = parseBool(pickEnv(["MMA_SEADREAM_ENHANCE_PROMPT"], "false"), false);

  const klingModel = pickEnv(
    ["MMA_KLING_VERSION", "MMA_KLING_MODEL_VERSION", "KLING_MODEL_VERSION"],
    "kwaivgi/kling-v2.1"
  );
  const klingMode = pickEnv(["MMA_KLING_MODE"], "standard"); // standard | pro

  // You asked for these env keys specifically:
  const negativeSeedream =
    pickEnv(["NEGATIVE_PROMPT_SEADREAM", "negative_prompt_seedream", "MMA_NEGATIVE_PROMPT_SEADREAM"], "").trim();
  const negativeKling =
    pickEnv(["NEGATIVE_PROMPT_KLING", "negative_prompt_kling", "MMA_NEGATIVE_PROMPT_KLING"], "").trim();

  return {
    enabled,
    gptModel,
    seadream: {
      model: seadreamModel,
      size: seadreamSize,
      aspect: seadreamAspect,
      enhancePrompt: seadreamEnhance,
      negativePrompt: negativeSeedream,
    },
    kling: {
      model: klingModel,
      mode: klingMode,
      negativePrompt: negativeKling,
    },
  };
}
