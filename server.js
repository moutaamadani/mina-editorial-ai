// ===============================
// PART 1 — Imports & basic setup
// ===============================
import express from "express";
import cors from "cors";
import Replicate from "replicate";

const PORT = process.env.PORT || 3000;

const app = express();

// Allow requests from your Shopify storefront
app.use(
  cors({
    origin: "*", // you can restrict later to your domain
  })
);

// Parse JSON bodies (up to 10 MB)
app.use(express.json({ limit: "10mb" }));

// Replicate client (SeaDream + Kling use the same token)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// SeaDream (image) + Kling (motion) model slugs
const SEADREAM_MODEL = "bytedance/seedream-4";
const KLING_MODEL = "kwaivgi/kling-v2.1";

// ===============================
// PART 2 — Health check endpoint
// ===============================
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Mina Editorial AI" });
});

// =====================================================
// PART 3 — Editorial image endpoint (/editorial/generate)
//          Uses SeaDream 4 on Replicate
// =====================================================
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}`;

  try {
    const {
      productImageUrl,
      styleImageUrls = [],
      brief,
      tone,
      platform = "tiktok", // "tiktok", "instagram", "youtube", etc.
      mode = "image", // later we might support "video"
      creditsToSpend = 1,
      customerId,
    } = req.body || {};

    // Minimal validation
    if (!productImageUrl || !brief) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_FIELDS",
        message: "productImageUrl and brief are required.",
        requestId,
      });
    }

    // Build the prompt we send to SeaDream
    const stylePart =
      styleImageUrls && styleImageUrls.length
        ? ` Match the mood / lighting / style of these reference images: ${styleImageUrls.join(
            ", "
          )}.`
        : "";

    const tonePart = tone
      ? ` Tone: ${tone}.`
      : " Tone: bold, poetic, editorial.";

    const platformPart = platform
      ? ` Frame and composition should be optimised for ${platform} content.`
      : "";

    const fullPrompt =
      `${brief}\n\nBrand / project context:\nFalta Studio is a creative agency.` +
      tonePart +
      ` Use this product image as the main subject reference: ${productImageUrl}.` +
      stylePart +
      platformPart;

    // SeaDream input (based on the official schema)
    const input = {
      size: "2K",
      width: 2048,
      height: 2048,
      prompt: fullPrompt,
      max_images: 1,
      image_input: [], // we are using URL references in the prompt text
      aspect_ratio: "4:3",
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const files = await replicate.run(SEADREAM_MODEL, { input });

    // files is an array of file-like objects
    const imageUrls = (files || [])
      .map((file) => {
        if (!file) return null;
        if (typeof file === "string") return file;
        if (typeof file.url === "function") return file.url();
        if (typeof file.url === "string") return file.url;
        return null;
      })
      .filter(Boolean);

    const imageUrl = imageUrls[0] || null;

    if (!imageUrl) {
      throw new Error("No image URL returned from SeaDream.");
    }

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt: fullPrompt,
      imageUrl,
      imageUrls,
      rawOutput: imageUrls, // keep it light
      payload: {
        productImageUrl,
        styleImageUrls,
        brief,
        tone,
        platform,
        mode,
        creditsToSpend,
        customerId,
      },
    });
  } catch (err) {
    console.error("[/editorial/generate] error", err);
    res.status(500).json({
      ok: false,
      error: "SEADREAM_ERROR",
      message: "SeaDream generation failed.",
      details: err?.message,
      requestId,
    });
  }
});

// =================================================
// PART 4 — Motion endpoint (/motion/generate)
//          Uses Kling v2.1 on Replicate
// =================================================
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}`;

  try {
    const {
      imageUrl,          // still image from Mina (SeaDream)
      motionPrompt,      // how you want it to move
      platform = "tiktok",
      durationSeconds = 5, // Kling expects seconds, default 5
      customerId,
      sourceRequestId,   // link back to editorial request if you want
    } = req.body || {};

    if (!imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_FIELDS",
        message: "imageUrl is required to generate motion.",
        requestId,
      });
    }

    const basePrompt =
      (motionPrompt ||
        "Animate this product shot in a smooth, premium way for social media.") +
      (platform ? ` The video should be ideal for ${platform} content.` : "");

    // Kling v2.1 input shape
    const input = {
      mode: "standard",
      prompt: basePrompt,
      duration: durationSeconds,
      start_image: imageUrl,
      negative_prompt: "",
    };

    const file = await replicate.run(KLING_MODEL, { input });

    let videoUrl = null;

    if (typeof file === "string") {
      videoUrl = file;
    } else if (file && typeof file.url === "function") {
      videoUrl = file.url();
    } else if (file && typeof file.url === "string") {
      videoUrl = file.url;
    }

    if (!videoUrl) {
      throw new Error("No video URL returned from Kling v2.1");
    }

    res.json({
      ok: true,
      message: "Mina Motion video generated via Kling v2.1.",
      requestId,
      prompt: basePrompt,
      imageUrl,
      videoUrl,
      rawOutput: {
        hasUrlMethod: typeof file?.url === "function",
      },
      payload: {
        imageUrl,
        motionPrompt,
        platform,
        durationSeconds,
        customerId,
        sourceRequestId,
      },
    });
  } catch (err) {
    console.error("[/motion/generate] error", err);
    res.status(500).json({
      ok: false,
      error: "KLING_ERROR",
      message: "Kling motion generation failed.",
      details: err?.message,
      requestId,
    });
  }
});

// ===============================
// PART 5 — Start server
// ===============================
app.listen(PORT, () => {
  console.log(`Mina Editorial API listening on port ${PORT}`);
});
