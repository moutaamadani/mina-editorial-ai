// PART 1 – Imports and basic setup
import express from "express";
import cors from "cors";
import Replicate from "replicate";

const app = express();
const PORT = process.env.PORT || 3000;

// Replicate client (auth comes from Render env var)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Basic middleware
app.use(cors());
app.use(express.json());

// Health check – used by Render + for quick tests
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Mina Editorial AI" });
});

// PART 2 – Helper: map platform to aspect ratio for SeaDream
function pickAspectRatio(platform = "") {
  const p = String(platform).toLowerCase();

  if (p.includes("tiktok") || p.includes("reel") || p.includes("short")) {
    return "9:16"; // vertical
  }

  if (p.includes("youtube")) {
    return "16:9"; // landscape
  }

  if (p.includes("square") || p.includes("instagram")) {
    return "1:1"; // square
  }

  // default editorial-ish
  return "4:5";
}

// PART 3 – Main endpoint: /editorial/generate
app.post("/editorial/generate", async (req, res) => {
  const payload = req.body || {};

  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform,
    mode = "image",
    creditsToSpend,
    customerId
  } = payload;

  // Minimal validation
  if (!brief) {
    return res.status(400).json({
      ok: false,
      error: "Missing 'brief' in request body."
    });
  }

  const requestId = `req_${Date.now()}`;

  // Build the prompt that we send to SeaDream
  const promptParts = [];

  if (brief) {
    promptParts.push(brief);
  }

  if (tone) {
    promptParts.push(`Tone: ${tone}.`);
  }

  if (productImageUrl) {
    promptParts.push(
      `Use this product image as the main subject reference: ${productImageUrl}.`
    );
  }

  if (Array.isArray(styleImageUrls) && styleImageUrls.length > 0) {
    promptParts.push(
      `Match the mood / lighting / style of these reference images: ${styleImageUrls.join(
        ", "
      )}.`
    );
  }

  const finalPrompt = promptParts.join(" ");

  // For now we only support image mode; later we'll branch for video/Kling
  if (mode !== "image") {
    return res.status(400).json({
      ok: false,
      error: "Only 'image' mode is supported for now.",
      requestId
    });
  }

  const aspect_ratio = pickAspectRatio(platform);
  const size = "1K"; // cheaper than 2K while prototyping

  try {
    // PART 4 – Call SeaDream on Replicate
    const output = await replicate.run(
      process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4",
      {
        input: {
          size,
          aspect_ratio,
          prompt: finalPrompt,
          max_images: 1,
          enhance_prompt: true
          // We can wire image_input later when we want hard reference control
        }
      }
    );

    // Try to extract an image URL from the output
    let imageUrl = null;

    if (Array.isArray(output) && output.length > 0) {
      const first = output[0];

      if (typeof first === "string") {
        // Some models return direct URL strings
        imageUrl = first;
      } else if (first && typeof first === "object") {
        // New Replicate client often returns file-like objects
        if (typeof first.url === "function") {
          imageUrl = first.url();
        } else if (typeof first.url === "string") {
          imageUrl = first.url;
        }
      }
    }

    // Response back to your Shopify page
    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt: finalPrompt,
      imageUrl,
      rawOutput: output,
      payload
    });
  } catch (error) {
    console.error("Error calling SeaDream / Replicate:", error);

    res.status(500).json({
      ok: false,
      error: "Failed to generate image with SeaDream",
      details: error?.message ?? String(error),
      requestId
    });
  }
});

// PART 5 – Start the server
app.listen(PORT, () => {
  console.log(`Mina Editorial API listening on port ${PORT}`);
});
