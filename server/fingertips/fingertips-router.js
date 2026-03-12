// ./server/fingertips/fingertips-router.js
// Express router for Fingertips feature — image editing tools with fractional matcha billing.

import express from "express";
import { resolvePassId as megaResolvePassId } from "../../mega-db.js";
import {
  handleFingertipsGenerate,
  fetchFingertipsGeneration,
  getPoolStatus,
  listFingertipsModels,
} from "./fingertips-controller.js";

const router = express.Router();

// ----------------------------
// helper: inject passId
// ----------------------------
function withPassId(req, rawBody) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const passId = megaResolvePassId(req, body);
  return { passId, body: { ...body, passId } };
}

// ======================================================
// POST /fingertips/generate
// Body: { modelKey, inputs: { ... } }
// ======================================================
router.post("/generate", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);

    const result = await handleFingertipsGenerate({
      passId,
      modelKey: body.modelKey || body.model_key || body.model,
      inputs: body.inputs || {},
    });

    res.json(result);
  } catch (err) {
    console.error("[fingertips] generate error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.code || "FINGERTIPS_FAILED",
      message: err?.message,
      details: err?.details || undefined,
      modelKey: err?.modelKey || undefined,
      missing: err?.missing || undefined,
      availableModels: err?.availableModels || undefined,
    });
  }
});

// ======================================================
// GET /fingertips/generations/:generation_id
// Poll for result of a fingertips generation
// ======================================================
router.get("/generations/:generation_id", async (req, res) => {
  try {
    const payload = await fetchFingertipsGeneration(req.params.generation_id);
    if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(payload);
  } catch (err) {
    console.error("[fingertips] fetch generation error", err);
    res.status(500).json({ error: "FINGERTIPS_FETCH_FAILED", message: err?.message });
  }
});

// ======================================================
// GET /fingertips/pool
// Returns current fingertips pool balance for the user
// ======================================================
router.get("/pool", async (req, res) => {
  try {
    const passId = megaResolvePassId(req, req.query || {});
    res.set("X-Mina-Pass-Id", passId);

    const status = await getPoolStatus(passId);
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("[fingertips] pool error", err);
    res.status(500).json({ error: "FINGERTIPS_POOL_FAILED", message: err?.message });
  }
});

// ======================================================
// GET /fingertips/models
// Returns all available fingertips models with costs and input schemas
// ======================================================
router.get("/models", (_req, res) => {
  try {
    const models = listFingertipsModels();
    res.json({ ok: true, models });
  } catch (err) {
    console.error("[fingertips] models error", err);
    res.status(500).json({ error: "FINGERTIPS_MODELS_FAILED", message: err?.message });
  }
});

export default router;
