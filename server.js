import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
// TODO: later restrict CORS to faltastudio.com only
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Mina Editorial AI" });
});

// --- Mina Editorial request (stub: no AI calls yet) ---
app.post("/editorial/generate", (req, res) => {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform,
    mode,
    creditsToSpend = 1,
    customerId,
  } = req.body || {};

  const missing = [];
  if (!productImageUrl) missing.push("productImageUrl");
  if (!brief) missing.push("brief");
  if (!mode) missing.push("mode");

  if (missing.length > 0) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields",
      missing,
    });
  }

  const requestId = `req_${Date.now()}`;

  return res.json({
    ok: true,
    message:
      "Mina Editorial request accepted (stub – AI models not wired yet).",
    requestId,
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
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Mina Editorial API listening on port ${PORT}`);
});
