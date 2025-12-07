// =======================
// PART 1 – Imports & setup
// =======================
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Models
const SEADREAM_MODEL =
  process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL =
  process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// In-memory "likes" per customer
// key = customerId (string)
// value = array of { resultType, platform, prompt, comment, imageUrl?, videoUrl?, createdAt }
const likeMemory = new Map();
const MAX_LIKES_PER_CUSTOMER = 50;

// Style profile cache & history per customer
// We compute a style profile after MIN_LIKES_FOR_FIRST_PROFILE likes,
// then refresh every LIKES_PER_PROFILE_REFRESH new likes.
const styleProfileCache = new Map();   // key: customerId -> { profile, likesCountAtCompute, updatedAt }
const styleProfileHistory = new Map(); // key: customerId -> [ { profile, likesCountAtCompute, createdAt } ]

const MIN_LIKES_FOR_FIRST_PROFILE = 20;
const LIKES_PER_PROFILE_REFRESH = 5;

// ---------------- Helpers ----------------
function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function rememberLike(customerIdRaw, entry) {
  if (!customerIdRaw) return;
  const customerId = String(customerIdRaw);
  const existing = likeMemory.get(customerId) || [];
  existing.push({
    resultType: entry.resultType || "image",
    platform: entry.platform || "tiktok",
    prompt: entry.prompt || "",
    comment: entry.comment || "",
    imageUrl: entry.imageUrl || null,
    videoUrl: entry.videoUrl || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });

  if (existing.length > MAX_LIKES_PER_CUSTOMER) {
    const excess = existing.length - MAX_LIKES_PER_CUSTOMER;
    existing.splice(0, excess);
  }

  likeMemory.set(customerId, existing);
}

function getLikes(customerIdRaw) {
  if (!customerIdRaw) return [];
  const customerId = String(customerIdRaw);
  return likeMemory.get(customerId) || [];
}

// Style history used for GPT context (list of liked prompts/comments)
function getStyleHistory(customerIdRaw) {
  const likes = getLikes(customerIdRaw);
  return likes.map((like) => ({
    prompt: like.prompt,
    platform: like.platform,
    comment: like.comment || null,
  }));
}

// Build style profile (keywords + description) from likes, with vision on images
async function buildStyleProfileFromLikes(customerId, likes) {
  const recentLikes = likes.slice(-10); // only last 10 liked generations
  if (!recentLikes.length) {
    return {
      profile: { keywords: [], description: "" },
      usedFallback: false,
      gptError: null,
    };
  }

  const examplesText = recentLikes
    .map((like, idx) => {
      return `#${idx + 1} [${like.resultType} / ${like.platform}]
Prompt: ${like.prompt || ""}
UserComment: ${like.comment || "none"}
HasImage: ${like.imageUrl ? "yes" : "no"}
HasVideo: ${like.videoUrl ? "yes" : "no"}`;
    })
    .join("\n\n");

  const systemMessage = {
    role: "system",
    content:
      "You are an assistant that summarizes a user's aesthetic preferences " +
      "for AI-generated editorial product images and motion. " +
      "You will see some liked generations. For each one you may see:\n" +
      "- result type (image or motion)\n" +
      "- platform\n" +
      "- the generation prompt\n" +
      "- an optional user comment describing what they liked or disliked\n" +
      "- sometimes the final liked image itself\n\n" +
      "IMPORTANT:\n" +
      "- Treat comments as preference signals. If user says they DON'T like something (e.g. 'I like the image but I don't like the light'), do NOT treat that attribute as part of their style. Prefer avoiding repeatedly disliked attributes.\n" +
      "- For images, use the actual image content (colors, lighting, composition, background complexity, mood) to infer style.\n" +
      "- For motion entries, you will not see video, only prompts/comments. Use those.\n\n" +
      "Your task is to infer the consistent positive style across these examples.\n" +
      "Return strict JSON only with short keywords and a style description.",
  };

  const userText = `
Customer id: ${customerId}
Below are image/video generations this customer explicitly liked.

Infer what they CONSISTENTLY LIKE, not what they dislike.
If comments mention dislikes, subtract those from your style interpretation.

Return STRICT JSON only, no prose, with this shape:
{
  "keywords": ["short-tag-1", "short-tag-2", ...],
  "description": "2-3 sentence natural-language description of their style"
}

Text data for last liked generations:
${examplesText}
`.trim();

  // Build vision content from liked images (images only, not videos)
  const imageParts = [];
  recentLikes.forEach((like) => {
    if (like.resultType === "image" && like.imageUrl) {
      imageParts.push({
        type: "image_url",
        image_url: { url: like.imageUrl },
      });
    }
  });

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  const fallbackPrompt = '{"keywords":[],"description":""}';

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  let profile = { keywords: [], description: "" };
  try {
    profile = JSON.parse(result.prompt);
    if (!Array.isArray(profile.keywords)) profile.keywords = [];
    if (typeof profile.description !== "string") profile.description = "";
  } catch (e) {
    profile = {
      keywords: [],
      description: result.prompt || "",
    };
  }

  return {
    profile,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}

// Get or build cached style profile with thresholds & caching
async function getOrBuildStyleProfile(customerIdRaw, likes) {
  const customerId = String(customerIdRaw || "anonymous");
  const likesCount = likes.length;

  if (likesCount < MIN_LIKES_FOR_FIRST_PROFILE) {
    return {
      profile: null,
      meta: {
        source: "none",
        reason: "not_enough_likes",
        likesCount,
        minLikesForFirstProfile: MIN_LIKES_FOR_FIRST_PROFILE,
      },
    };
  }

  const cached = styleProfileCache.get(customerId);
  if (
    cached &&
    likesCount < cached.likesCountAtCompute + LIKES_PER_PROFILE_REFRESH
  ) {
    return {
      profile: cached.profile,
      meta: {
        source: "cache",
        likesCount,
        likesCountAtProfile: cached.likesCountAtCompute,
        updatedAt: cached.updatedAt,
        refreshStep: LIKES_PER_PROFILE_REFRESH,
      },
    };
  }

  // Recompute profile from likes
  const profileRes = await buildStyleProfileFromLikes(customerId, likes);
  const profile = profileRes.profile;
  const updatedAt = new Date().toISOString();

  styleProfileCache.set(customerId, {
    profile,
    likesCountAtCompute: likesCount,
    updatedAt,
  });

  // Append to styleProfileHistory log
  const historyArr = styleProfileHistory.get(customerId) || [];
  historyArr.push({
    profile,
    likesCountAtCompute: likesCount,
    createdAt: updatedAt,
  });
  styleProfileHistory.set(customerId, historyArr);

  return {
    profile,
    meta: {
      source: "recomputed",
      likesCount,
      likesCountAtProfile: likesCount,
      updatedAt,
      refreshStep: LIKES_PER_PROFILE_REFRESH,
      usedFallback: profileRes.usedFallback,
      gptError: profileRes.gptError,
    },
  };
}

// Simple health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API",
    time: new Date().toISOString(),
  });
});

// =======================
// PART 2 – GPT helpers (vision + style memory)
// =======================

async function runChatWithFallback({ systemMessage, userContent, fallbackPrompt }) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        systemMessage,
        {
          role: "user",
          content: userContent, // string OR [{type:'text'},{type:'image_url'},...]
        },
      ],
      temperature: 0.8,
      max_tokens: 280,
    });

    const prompt = completion.choices?.[0]?.message?.content?.trim();
    if (!prompt) throw new Error("Empty GPT response");

    return { prompt, usedFallback: false, gptError: null };
  } catch (err) {
    console.error("OpenAI error, falling back:", err?.status, err?.message);
    return {
      prompt: fallbackPrompt,
      usedFallback: true,
      gptError: {
        status: err?.status || null,
        message: err?.message || String(err),
      },
    };
  }
}

// ---- Build Mina's SeaDream prompt (image) with vision + likes ----
async function buildEditorialPrompt(payload) {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
    styleHistory = [],
    styleProfile = null,
  } = payload;

  const fallbackPrompt = [
    safeString(
      brief,
      "Editorial still-life product photo of the hero product on a simple surface."
    ),
    tone ? `Tone: ${tone}.` : "",
    `Shot for ${platform}, clean composition, professional lighting.`,
    "Hero product in focus, refined minimal background, fashion/editorial style.",
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none yet – this might be their first liked result.";

  const profileDescription =
    styleProfile && styleProfile.description
      ? styleProfile.description
      : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords)
      ? styleProfile.keywords.join(", ")
      : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial art director for fashion & beauty. " +
      "You will see one product image and up to 3 style reference images. " +
      "You write ONE clear prompt for a generative image model. " +
      "The model only understands English descriptions, not URLs. " +
      "Describe subject, environment, lighting, camera, mood, and style. " +
      "Do NOT include line breaks, lists, or bullet points. One paragraph max.",
  };

  const userText = `
You are creating a new ${mode} for Mina.

Current request brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer (history):
${historyText}

Customer style profile inferred from liked generations:
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached images are:
- Main product image as the hero subject
- Up to 3 style/mood references for lighting, color, and composition

Write the final prompt I should send to the image model.
`.trim();

  // Vision content: product + style refs
  const imageParts = [];
  if (productImageUrl) {
    imageParts.push({
      type: "image_url",
      image_url: { url: productImageUrl },
    });
  }
  (styleImageUrls || [])
    .slice(0, 3)
    .filter((url) => !!url)
    .forEach((url) => {
      imageParts.push({
        type: "image_url",
        image_url: { url },
      });
    });

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });
}

// ---- Build Mina's Kling prompt (motion) with vision + likes ----
async function buildMotionPrompt(options) {
  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
    styleHistory = [],
    styleProfile = null,
  } = options;

  const fallbackPrompt = [
    motionBrief ||
      "Short looping editorial motion of the product with a subtle camera move and gentle light changes.",
    tone ? `Tone: ${tone}.` : "",
    `Optimised for ${platform} vertical content.`,
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description
      ? styleProfile.description
      : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords)
      ? styleProfile.keywords.join(", ")
      : "";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for fashion & beauty. " +
      "You will see a reference still frame. " +
      "You describe a SHORT looping product motion for a generative video model like Kling. " +
      "Keep it 1–2 sentences, no line breaks.",
  };

  const userText = `
You are creating a short motion loop based on the attached still frame.

Desired motion description from the user:
${safeString(
  motionBrief,
  "subtle elegant camera move with a small motion in the scene."
)}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked image prompts for this customer (aesthetic history):
${historyText}

Customer style profile inferred from liked generations:
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached image is the reference frame to animate. Do NOT mention URLs. 
Write the final video generation prompt.
`.trim();

  const imageParts = [];
  if (lastImageUrl) {
    imageParts.push({
      type: "image_url",
      image_url: { url: lastImageUrl },
    });
  }

  const userContent =
    imageParts.length > 0
      ? [
          {
            type: "text",
            text: userText,
          },
          ...imageParts,
        ]
      : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });
}

// =======================
// PART 3 – API routes
// =======================

// ---- Mina Editorial (image) ----
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const productImageUrl = safeString(body.productImageUrl);
    const styleImageUrls = Array.isArray(body.styleImageUrls)
      ? body.styleImageUrls
      : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!productImageUrl && !brief) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message:
          "Provide at least productImageUrl or brief so Mina knows what to create.",
        requestId,
      });
    }

    let styleHistory = [];
    let styleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = getLikes(customerId);
      styleHistory = getStyleHistory(customerId);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      styleProfile = profileRes.profile;
      styleProfileMeta = profileRes.meta;
    }

    const promptResult = await buildEditorialPrompt({
      productImageUrl,
      styleImageUrls,
      brief,
      tone,
      platform,
      mode: "image",
      styleHistory,
      styleProfile,
    });

    const prompt = promptResult.prompt;

    // Map platform to aspect ratio
    let aspectRatio = "4:5";
    if (platform.includes("tiktok") || platform.includes("reel")) {
      aspectRatio = "9:16";
    } else if (platform.includes("youtube")) {
      aspectRatio = "16:9";
    }

    const input = {
      prompt,
      image_input: productImageUrl
        ? [productImageUrl, ...styleImageUrls]
        : styleImageUrls,
      max_images: body.maxImages || 1,
      size: "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run(SEADREAM_MODEL, { input });

    // Normalise SeaDream output to list of URLs
    let imageUrls = [];
    if (Array.isArray(output)) {
      imageUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            return item.url || item.image || null;
          }
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      imageUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") imageUrls = [output.url];
      else if (Array.isArray(output.output)) {
        imageUrls = output.output.filter((v) => typeof v === "string");
      }
    }

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt,
      imageUrl: imageUrls[0] || null,
      imageUrls,
      rawOutput: output,
      payload: body,
      gpt: {
        usedFallback: promptResult.usedFallback,
        error: promptResult.gptError,
        styleProfile,
        styleProfileMeta,
      },
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

// ---- Mina Motion (video) ----
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    let styleHistory = [];
    let styleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = getLikes(customerId);
      styleHistory = getStyleHistory(customerId);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      styleProfile = profileRes.profile;
      styleProfileMeta = profileRes.meta;
    }

    const motionResult = await buildMotionPrompt({
      motionBrief: motionDescription,
      tone,
      platform,
      lastImageUrl,
      styleHistory,
      styleProfile,
    });

    const prompt = motionResult.prompt;
    const durationSeconds = Number(body.durationSeconds || 5);

    const input = {
      mode: "standard",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: "",
    };

    const output = await replicate.run(KLING_MODEL, { input });

    // Normalise Kling output to a single video URL
    let videoUrl = null;
    if (typeof output === "string") {
      videoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") {
        videoUrl = first;
      } else if (first && typeof first === "object") {
        if (typeof first.url === "string") videoUrl = first.url;
        else if (typeof first.video === "string") videoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") videoUrl = output.url;
      else if (typeof output.video === "string") videoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") {
          videoUrl = output.output[0];
        }
      }
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
        motionDescription,
        tone,
        platform,
        durationSeconds,
        customerId,
      },
      gpt: {
        usedFallback: motionResult.usedFallback,
        error: motionResult.gptError,
        styleProfile,
        styleProfileMeta,
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

// ---- Mina Vision feedback (likes) ----
app.post("/feedback/like", (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";
    const resultType = safeString(body.resultType || "image");
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const prompt = safeString(body.prompt);
    const comment = safeString(body.comment);
    const imageUrl = safeString(body.imageUrl || "");
    const videoUrl = safeString(body.videoUrl || "");

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_PROMPT",
        message: "Prompt is required to store like feedback.",
        requestId,
      });
    }

    rememberLike(customerId, {
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
    });

    const totalLikes = getLikes(customerId).length;

    res.json({
      ok: true,
      message: "Like stored for Mina Vision Intelligence.",
      requestId,
      payload: {
        customerId,
        resultType,
        platform,
      },
      totals: {
        likesForCustomer: totalLikes,
      },
    });
  } catch (err) {
    console.error("Error in /feedback/like:", err);
    res.status(500).json({
      ok: false,
      error: "FEEDBACK_ERROR",
      message: err?.message || "Unexpected error while saving feedback.",
      requestId,
    });
  }
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
