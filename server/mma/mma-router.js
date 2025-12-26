// ./server/mma/mma-router.js
// Express router for Mina Mind API (MMA)
// - Routes fan out to controller helpers
// - SSE replay endpoint
// - IMPORTANT: we resolve passId ONCE from request + inject into body so controller uses SAME passId

import express from "express";
import {
  fetchGeneration,
  handleMmaCreate,
  handleMmaEvent,
  handleMmaStillTweak,
  handleMmaVideoTweak,
  listErrors,
  listSteps,
  registerSseClient,
  toUserStatus,
} from "./mma-controller.js";
import { getSupabaseAdmin } from "../../supabase.js";
import { resolvePassId as megaResolvePassId } from "../../mega-db.js";

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
// Routes
// ======================================================
router.post("/still/create", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);
    const result = await handleMmaCreate({ mode: "still", body });
    res.json(result);
  } catch (err) {
    console.error("[mma] still/create error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : "MMA_CREATE_FAILED",
      message: err?.message,
      details: err?.details || undefined,
    });
  }
});

router.post("/still/:generation_id/tweak", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);
    const result = await handleMmaStillTweak({
      parentGenerationId: req.params.generation_id,
      body,
    });
    res.json(result);
  } catch (err) {
    console.error("[mma] still tweak error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : "MMA_TWEAK_FAILED",
      message: err?.message,
      details: err?.details || undefined,
    });
  }
});

router.post("/video/animate", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);
    const result = await handleMmaCreate({ mode: "video", body });
    res.json(result);
  } catch (err) {
    console.error("[mma] video/animate error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : "MMA_ANIMATE_FAILED",
      message: err?.message,
      details: err?.details || undefined,
    });
  }
});

router.post("/video/:generation_id/tweak", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);
    const result = await handleMmaVideoTweak({
      parentGenerationId: req.params.generation_id,
      body,
    });
    res.json(result);
  } catch (err) {
    console.error("[mma] video tweak error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : "MMA_VIDEO_TWEAK_FAILED",
      message: err?.message,
      details: err?.details || undefined,
    });
  }
});

router.post("/events", async (req, res) => {
  const { passId, body } = withPassId(req, req.body);

  try {
    res.set("X-Mina-Pass-Id", passId);
    // ✅ never charge credits for events
    const result = await handleMmaEvent(body || {});
    res.json(result);
  } catch (err) {
    console.error("[mma] events error", err);
    res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
  }
});

router.get("/generations/:generation_id", async (req, res) => {
  try {
    const payload = await fetchGeneration(req.params.generation_id);
    if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(payload);
  } catch (err) {
    console.error("[mma] fetch generation error", err);
    res.status(500).json({ error: "MMA_FETCH_FAILED", message: err?.message });
  }
});

router.get("/stream/:generation_id", async (req, res) => {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(500).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const { data, error } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    if (error) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "SSE_BOOTSTRAP_FAILED" })}\n\n`);
      } catch {}
      return res.end();
    }

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const status = toUserStatus(data?.mg_mma_status || "queued"); // ✅ friendly status text

    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));

    registerSseClient(req.params.generation_id, res, { scanLines, status });
  } catch (err) {
    console.error("[mma] stream error", err);
    try {
      res.status(500).end();
    } catch {}
  }
});

router.get("/admin/errors", async (_req, res) => {
  try {
    const errors = await listErrors();
    res.json({ errors });
  } catch (err) {
    res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
  }
});

router.get("/admin/steps/:generation_id", async (req, res) => {
  try {
    const steps = await listSteps(req.params.generation_id);
    res.json({ steps });
  } catch (err) {
    res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
  }
});

export default router;
