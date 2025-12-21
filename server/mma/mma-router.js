// Hero Part 3: Express router for Mina Mind API
// Part 3.1: Routes fan out to controller helpers and expose SSE replay.
import express from "express";
import {
  fetchGeneration,
  handleMmaCreate,
  handleMmaEvent,
  listErrors,
  listSteps,
  registerSseClient,
} from "./mma-controller.js";
import { getSupabaseAdmin } from "../../supabase.js";

const router = express.Router();

router.post("/still/create", async (req, res) => {
  try {
    const result = await handleMmaCreate({ mode: "still", body: req.body, req });
    res.json(result);
  } catch (err) {
    console.error("[mma] still/create error", err);
    res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
  }
});

router.post("/still/:generation_id/tweak", async (req, res) => {
  try {
    const result = await handleMmaCreate({
      mode: "still",
      body: { ...req.body, parent_generation_id: req.params.generation_id },
      req,
    });
    res.json(result);
  } catch (err) {
    console.error("[mma] still tweak error", err);
    res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
  }
});

router.post("/video/animate", async (req, res) => {
  try {
    const result = await handleMmaCreate({ mode: "video", body: req.body, req });
    res.json(result);
  } catch (err) {
    console.error("[mma] video animate error", err);
    res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
  }
});

router.post("/video/:generation_id/tweak", async (req, res) => {
  try {
    const result = await handleMmaCreate({
      mode: "video",
      body: { ...req.body, parent_generation_id: req.params.generation_id },
      req,
    });
    res.json(result);
  } catch (err) {
    console.error("[mma] video tweak error", err);
    res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
  }
});

router.post("/events", async (req, res) => {
  try {
    const result = await handleMmaEvent(req.body || {}, req);
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
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
  });
  res.flushHeaders?.();

  const { data } = await supabase
    .from("mega_generations")
    .select("mg_mma_vars, mg_mma_status")
    .eq("mg_generation_id", req.params.generation_id)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
  const status = data?.mg_mma_status || "queued";

  // Keepalive (Render/proxies like this)
  const keepAlive = setInterval(() => {
    try {
      res.write(`:keepalive\n\n`);
    } catch {}
  }, 25000);

  res.on("close", () => clearInterval(keepAlive));

  registerSseClient(req.params.generation_id, res, { scanLines, status });
});

router.get("/admin/mma/errors", async (_req, res) => {
  try {
    const errors = await listErrors();
    res.json({ errors });
  } catch (err) {
    res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
  }
});

router.get("/admin/mma/steps/:generation_id", async (req, res) => {
  try {
    const steps = await listSteps(req.params.generation_id);
    res.json({ steps });
  } catch (err) {
    res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
  }
});

export default router;
