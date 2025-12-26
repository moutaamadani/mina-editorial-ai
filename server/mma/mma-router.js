// ./server/mma/mma-router.js
"use strict";

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

const router = express.Router();

// ✅ IMPORTANT: server.js already injects req.body.passId / pass_id.
// We just reuse it, and set response header for frontend convenience.
function getPassIdFromReq(req) {
  const b = req.body || {};
  return (
    b.passId ||
    b.pass_id ||
    req.get("x-mina-pass-id") ||
    req.get("X-Mina-Pass-Id") ||
    ""
  );
}

function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
}

// ======================================================
// MMA endpoints
// ======================================================
router.post("/still/create", async (req, res) => {
  const passId = getPassIdFromReq(req);
  setPassIdHeader(res, passId);

  try {
    const result = await handleMmaCreate({ mode: "still", body: req.body || {} });
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
  const passId = getPassIdFromReq(req);
  setPassIdHeader(res, passId);

  try {
    const result = await handleMmaStillTweak({
      parentGenerationId: req.params.generation_id,
      body: req.body || {},
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
  const passId = getPassIdFromReq(req);
  setPassIdHeader(res, passId);

  try {
    const result = await handleMmaCreate({ mode: "video", body: req.body || {} });
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
  const passId = getPassIdFromReq(req);
  setPassIdHeader(res, passId);

  try {
    const result = await handleMmaVideoTweak({
      parentGenerationId: req.params.generation_id,
      body: req.body || {},
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
  const passId = getPassIdFromReq(req);
  setPassIdHeader(res, passId);

  try {
    // ✅ never charge credits here (controller handles all credit logic in pipelines)
    const result = await handleMmaEvent(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("[mma] events error", err);
    res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
  }
});

// ======================================================
// Fetch single generation
// ======================================================
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

// ======================================================
// SSE stream
// ======================================================
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

    const { data } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const status = toUserStatus(data?.mg_mma_status || "queued");

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

// ======================================================
// Optional admin helpers (if you use them)
// ======================================================
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
