// server.js
import express from "express";
import cors from "cors";
import Replicate from "replicate";

const app = express();
const PORT = process.env.PORT || 3000;

// Replicate client using your token from Render env vars
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

app.use(cors());
app.use(express.json());

// Simple health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Mina Editorial AI" });
});

// Main endpoint: generate editorial still-life images
app.post("/editorial/generate", async (req, res) => {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform,
    mode,
    creditsToSpend,
    customerId,
  } = req.body || {};

  if (!brief || !brief.trim()) {
    return res.status(400).json({
      ok: false,
      error: "BRIEF_REQUIRED",
      message:
        "Please provide a brand / project context + what you want Mina to create.",
    });
  }

  // Build the prompt we send to SeaDream
  const promptParts = [];
  promptParts.push(brief.trim());

  if (tone && tone.trim()) {
    promptParts.push(`Tone: ${tone.trim()}.`);
  }

  if (productImageUrl && productImageUrl.trim()) {
    promptParts.push(
      `Use this product image as the main subject reference: ${productImageUrl.trim()}.`
    );
  }

  if (Array.isArray(styleImageUrls) && styleImageUrls.length > 0) {
    promptParts.push(
      `Match the mood / lighting / style of these reference images: ${styleImageUrls.join(
        ", "
      )}.`
    );
  }

  if (platform && platform.trim()) {
    promptParts.push(
      `Frame and composition should be optimised for ${platform.trim()} content.`
    );
  }

  const finalPrompt = promptParts.join(" ").trim();

  try {
    // Ask SeaDream for up to 3 images
    const input = {
      size: "2K",
      width: 2048,
      height: 2048,
      prompt: finalPrompt,
      max_images: 3,
      image_input: productImageUrl ? [productImageUrl] : [],
      aspect_ratio: "4:3",
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run("bytedance/seedream-4", { input });

    // Normalise output into an array of URLs (strings)
    const rawOutput = Array.isArray(output) ? output : [output];

    const imageUrls = rawOutput
      .map((item) => {
        if (typeof item === "string") return item;

        // Some Replicate outputs expose a .url() method
        if (item && typeof item === "object" && typeof item.url === "function") {
          try {
            return item.url();
          } catch (e) {
            return String(item);
          }
        }

        return String(item);
      })
      .filter(Boolean);

    const primaryImageUrl = imageUrls[0] || null;
    const requestId = `req_${Date.now()}`;

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt: finalPrompt,
      imageUrl: primaryImageUrl,
      imageUrls,
      rawOutput,
      payload: req.body || null,
    });
  } catch (err) {
    console.error("Error calling SeaDream on Replicate", err);
    res.status(500).json({
      ok: false,
      error: "SEADREAM_ERROR",
      message: "SeaDream generation failed.",
      details: err?.message || String(err),
    });
  }
});

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND" });
});

app.listen(PORT, () => {
  console.log(`Mina Editorial API listening on port ${PORT}`);
});
