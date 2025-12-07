// =======================
// PART 1 – Imports & config
// =======================
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Replicate client
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI client (ChatGPT)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Model names (can be overridden by env vars)
const SEADREAM_MODEL =
  process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL =
  process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API",
    time: new Date().toISOString(),
  });
});

// Small helper to safely read strings
function safeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

// =======================
// PART 2 – GPT helpers
// =======================

// Build the prompt for SeaDream (image) using GPT
async function buildEditorialPrompt(payload) {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
  } = payload;

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial art director for fashion & beauty. " +
      "You write ONE clear prompt for a generative image or video model. " +
      "The model only understands English descriptions, not URLs. " +
      "Describe subject, environment, lighting, camera, mood, and style. " +
      "Do NOT include line breaks, lists, or bullet points. One paragraph max.",
  };

  const userMessage = {
    role: "user",
    content: `
Brand / project context and brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}
Mode: ${mode}

Main product image (reference only, don't literally write the URL):
${safeString(productImageUrl, "none")}

Style / mood reference image URLs (reference only):
${(styleImageUrls || []).join(", ") || "none"}

Write the final prompt I should send to the image model.
`.trim(),
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [systemMessage, userMessage],
    temperature: 0.8,
    max_tokens: 280,
  });

  const prompt =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Editorial still-life product photo, studio lighting.";

  return prompt;
}

// Build the prompt for Kling (video) using GPT
async function buildMotionPrompt(options) {
  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
  } = options;

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for fashion & beauty. " +
      "You describe a SHORT looping product motion for a generative video model like Kling. " +
      "Keep it 1–2 sentences, no line breaks.",
  };

  const userMessage = {
    role: "user",
    content: `
Static reference frame URL (for you only, don't spell it out in the prompt):
${safeString(lastImageUrl, "none")}

Desired motion description from the user:
${safeString(
  motionBrief,
  "subtle elegant camera move with a small motion in the scene."
)}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Write the final video generation prompt.
`.trim(),
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [systemMessage, userMessage],
    temperature: 0.9,
    max_tokens: 220,
  });

  const prompt =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Short looping editorial product motion with soft camera move.";

  return prompt;
}

// =======================
// PART 3 – API routes
// =======================

// --- Image generation with SeaDream (Mina Editorial) ---
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const payload = req.body || {};

    const productImageUrl = safeString(payload.productImageUrl);
    const styleImageUrls = Array.isArray(payload.styleImageUrls)
      ? payload.styleImageUrls
      : [];

    if (!productImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_PRODUCT_IMAGE",
        message: "productImageUrl is required.",
        requestId,
      });
    }

    // Ask GPT to build the SeaDream prompt
    const prompt = await buildEditorialPrompt({
      ...payload,
      productImageUrl,
      styleImageUrls,
      mode: "image",
    });

    // Map platform to aspect ratio
    const platform = safeString(payload.platform || "tiktok").toLowerCase();
    const aspectRatio = platform.includes("tiktok") || platform.includes("reel")
      ? "9:16"
      : "4:5";

    const input = {
      prompt,
      // SeaDream uses image_input as an array – we pass product + style refs
      image_input: [productImageUrl, ...styleImageUrls],
      max_images: payload.maxImages || 1,
      size: "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run(SEADREAM_MODEL, { input });

    // Replicate usually returns an array of URLs for image models
    let imageUrls = [];
    if (Array.isArray(output)) {
      imageUrls = output.map((item) =>
        typeof item === "string" ? item : item?.url || item
      );
    } else if (typeof output === "string") {
      imageUrls = [output];
    }

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt,
      imageUrl: imageUrls[0] || null,
      imageUrls,
      rawOutput: output,
      payload,
    });
  } catch (err) {
    console.error("Error in /editorial/generate:", err);
    res.status(500).json({
      ok: false,
      error: "EDITORIAL_GENERATION_ERROR",
      message: err?.message || "Unexpected error during image generation.",
      requestId,
    });
  }
});

// --- Motion / video generation with Kling (Mina Motion) ---
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);

    // Support both motionPrompt and motionBrief from the front-end
    const motionBrief =
      safeString(body.motionBrief) || safeString(body.motionPrompt);

    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok");
    const durationSeconds = Number(body.durationSeconds || 5);

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    // Ask GPT to build the Kling prompt
    const prompt = await buildMotionPrompt({
      motionBrief,
      tone,
      platform,
      lastImageUrl,
    });

    const input = {
      mode: "standard",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: "",
    };

    const output = await replicate.run(KLING_MODEL, { input });

    // Normalise possible output shapes to one videoUrl
    let videoUrl = null;

    if (typeof output === "string") {
      videoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") videoUrl = first;
      else if (first && typeof first === "object") {
        videoUrl = first.video || first.url || null;
      }
    } else if (output && typeof output === "object") {
      videoUrl = output.video || output.url || null;
    }

    res.json({
      ok: true,
      message: "Mina Motion video generated via Kling.",
      requestId,
      prompt,
      videoUrl,
      rawOutput: output,
      payload: {
        lastImageUrl,
        motionBrief,
        tone,
        platform,
        durationSeconds,
      },
    });
  } catch (err) {
    console.error("Error in /motion/generate:", err);
    res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
