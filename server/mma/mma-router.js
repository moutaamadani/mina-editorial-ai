import express from "express";
import crypto from "node:crypto";

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

export default function createMmaRouter({
  supabaseAdmin,
  sbEnabled,
  mmaController,
  mmaHub,
  resolveCustomerId,
  normalizePassId,
  resolvePassId,
  sbEnsureCustomer,
  updateMmaPreferencesForEvent,
  requireAdmin,
  safeString,
  nowIso,
}) {
  const router = express.Router();

  router.post("/still/create", async (req, res) => {
    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });

      const body = req.body || {};
      const assets = body.assets || {};
      const resolvedAssets = {
        product_url: assets.product_image_id || null,
        logo_url: assets.logo_image_id || null,
        inspiration_urls: Array.isArray(assets.inspiration_image_ids) ? assets.inspiration_image_ids : [],
        style_hero_url: assets.style_hero_image_id || null,
        input_still_image_id: assets.input_still_image_id || null,
        still_url: assets.input_still_image_id || null,
      };

      const result = await mmaController.runStillCreate({
        customerId: body.customer_id || resolveCustomerId(req, body),
        email: body.email || null,
        userId: body.user_id || body.userId || null,
        assets: resolvedAssets,
        inputs: body.inputs || {},
        history: body.history || {},
        settings: body.settings || {},
      });

      if (result.passId) {
        res.set("X-Mina-Pass-Id", result.passId);
      }

      return res.json({
        generation_id: result.generationId,
        status: "queued",
        sse_url: `/mma/stream/${result.generationId}`,
      });
    } catch (err) {
      console.error("Error in /mma/still/create:", err);
      return res.status(500).json({ ok: false, error: "MMA_STILL_CREATE_ERROR", message: err?.message || "" });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
      const body = req.body || {};
      const baseGenerationId = req.params.generation_id;

      const result = await mmaController.runStillTweak({
        baseGenerationId,
        customerId: body.customer_id || resolveCustomerId(req, body),
        email: body.email || null,
        userId: body.user_id || body.userId || null,
        feedback: body.feedback || {},
        settings: body.settings || {},
      });

      if (result.passId) {
        res.set("X-Mina-Pass-Id", result.passId);
      }

      return res.json({
        generation_id: result.generationId,
        status: "queued",
        sse_url: `/mma/stream/${result.generationId}`,
      });
    } catch (err) {
      console.error("Error in /mma/still/:id/tweak:", err);
      return res.status(500).json({ ok: false, error: "MMA_STILL_TWEAK_ERROR", message: err?.message || "" });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
      const body = req.body || {};
      const assets = body.assets || {};
      const resolvedAssets = {
        input_still_image_id: assets.input_still_image_id || null,
        still_url: assets.input_still_image_id || null,
      };

      const result = await mmaController.runVideoAnimate({
        customerId: body.customer_id || resolveCustomerId(req, body),
        email: body.email || null,
        userId: body.user_id || body.userId || null,
        assets: resolvedAssets,
        inputs: body.inputs || {},
        mode: body.mode || {},
        history: body.history || {},
        settings: body.settings || {},
      });

      if (result.passId) {
        res.set("X-Mina-Pass-Id", result.passId);
      }

      return res.json({
        generation_id: result.generationId,
        status: "queued",
        sse_url: `/mma/stream/${result.generationId}`,
      });
    } catch (err) {
      console.error("Error in /mma/video/animate:", err);
      return res.status(500).json({ ok: false, error: "MMA_VIDEO_ANIMATE_ERROR", message: err?.message || "" });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
      const body = req.body || {};
      const baseGenerationId = req.params.generation_id;

      const result = await mmaController.runVideoTweak({
        baseGenerationId,
        customerId: body.customer_id || resolveCustomerId(req, body),
        email: body.email || null,
        userId: body.user_id || body.userId || null,
        feedback: body.feedback || {},
        settings: body.settings || {},
      });

      if (result.passId) {
        res.set("X-Mina-Pass-Id", result.passId);
      }

      return res.json({
        generation_id: result.generationId,
        status: "queued",
        sse_url: `/mma/stream/${result.generationId}`,
      });
    } catch (err) {
      console.error("Error in /mma/video/:id/tweak:", err);
      return res.status(500).json({ ok: false, error: "MMA_VIDEO_TWEAK_ERROR", message: err?.message || "" });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
      const generationId = req.params.generation_id;

      const { data, error } = await supabaseAdmin
        .from("mega_generations")
        .select(
          "mg_generation_id, mg_mma_status, mg_mma_vars, mg_output_url, mg_mma_mode, mg_error, mg_status, mg_pass_id",
        )
        .eq("mg_generation_id", generationId)
        .eq("mg_record_type", "generation")
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

      const mmaVars = data.mg_mma_vars || {};
      if (data.mg_pass_id) {
        res.set("X-Mina-Pass-Id", data.mg_pass_id);
      }
      const outputs = { ...(mmaVars.outputs || {}) };

      if (!outputs.seedream_image_url && data.mg_output_url && data.mg_mma_mode === "still") {
        outputs.seedream_image_url = data.mg_output_url;
      }
      if (!outputs.kling_video_url && data.mg_output_url && data.mg_mma_mode === "video") {
        outputs.kling_video_url = data.mg_output_url;
      }

      return res.json({
        generation_id: generationId,
        status: data.mg_mma_status || data.mg_status || "unknown",
        mma_vars: mmaVars,
        outputs,
        error: data.mg_error ? { message: data.mg_error } : undefined,
      });
    } catch (err) {
      console.error("Error in /mma/generations/:id:", err);
      return res.status(500).json({ ok: false, error: "MMA_GENERATION_FETCH_ERROR", message: err?.message || "" });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
    const generationId = req.params.generation_id;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const { data, error } = await supabaseAdmin
        .from("mega_generations")
        .select("mg_mma_vars, mg_mma_status, mg_status, mg_pass_id")
        .eq("mg_generation_id", generationId)
        .eq("mg_record_type", "generation")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        sendSse(res, "error", { message: "NOT_FOUND" });
        return res.end();
      }

      if (data.mg_pass_id) {
        res.set("X-Mina-Pass-Id", data.mg_pass_id);
      }

      const scanLines = data.mg_mma_vars?.userMessages?.scan_lines || [];
      scanLines.forEach((line, idx) => {
        const text = typeof line === "string" ? line : line?.text || line?.line || "";
        sendSse(res, "scan_line", { index: idx + 1, text });
      });

      const currentStatus = data.mg_mma_status || data.mg_status || "queued";
      sendSse(res, "status", { status: currentStatus });

      if (["done", "error"].includes(currentStatus)) {
        sendSse(res, currentStatus === "done" ? "done" : "error", { status: currentStatus });
        return res.end();
      }

      const unsubscribe = mmaHub.subscribe(generationId, ({ event, data: payload }) => {
        sendSse(res, event, payload);
        if (event === "status" && payload?.status && ["done", "error"].includes(payload.status)) {
          sendSse(res, payload.status === "done" ? "done" : "error", payload);
          unsubscribe();
          res.end();
        }
      });

      req.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      console.error("Error in /mma/stream/:id:", err);
      sendSse(res, "error", { message: err?.message || "UNKNOWN_ERROR" });
      res.end();
    }
  });

  router.post("/events", async (req, res) => {
    const requestId = `mma_evt_${Date.now()}_${crypto.randomUUID()}`;

    try {
      if (!sbEnabled()) {
        return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });
      }

      const body = req.body || {};
      const eventType = safeString(body.event_type || body.eventType || "");

      if (!eventType) {
        return res.status(400).json({ ok: false, error: "MISSING_EVENT_TYPE", requestId });
      }

      const incomingPassId = normalizePassId(body.pass_id || body.passId || req.get("X-Mina-Pass-Id"));
      const customerId = resolveCustomerId(req, body);
      const ensuredPassId =
        incomingPassId ||
        resolvePassId({
          incomingPassId,
          shopifyId: customerId,
          userId: body.user_id || body.userId || null,
          email: body.email || null,
        });

      const cust = await sbEnsureCustomer({
        customerId,
        userId: body.user_id || body.userId || null,
        email: body.email || null,
        passId: ensuredPassId,
      });

      const passId = cust?.passId || ensuredPassId;
      res.set("X-Mina-Pass-Id", passId);

      const eventId = safeString(body.event_id || body.eventId, crypto.randomUUID());
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
      const generationId =
        safeString(body.generation_id || body.generationId || payload.generation_id || payload.generationId || "") || null;
      const ts = nowIso();

      const row = {
        mg_id: `mma_event:${eventId}`,
        mg_record_type: "mma_event",
        mg_pass_id: passId,
        mg_generation_id: generationId,
        mg_meta: { event_type: eventType },
        mg_payload: payload,
        mg_source_system: "app",
        mg_created_at: ts,
        mg_updated_at: ts,
        mg_event_at: ts,
      };

      await supabaseAdmin.from("mega_generations").insert(row);

      let preferences = null;
      if (["like", "dislike", "preference_set"].includes(eventType)) {
        preferences = await updateMmaPreferencesForEvent(passId, eventType, payload);
      }

      return res.json({ ok: true, requestId, eventId, passId, preferences });
    } catch (err) {
      console.error("Error in /mma/events:", err);
      return res.status(500).json({
        ok: false,
        error: "MMA_EVENT_ERROR",
        message: err?.message || "Unexpected error while storing MMA event.",
        requestId,
      });
    }
  });

  router.get("/admin/errors", requireAdmin, async (req, res) => {
    const limit = Number(req.query.limit || 20);
    const { data, error } = await supabaseAdmin
      .from("mega_admin")
      .select("mg_id, mg_detail, mg_created_at")
      .eq("mg_route", "mma")
      .order("mg_created_at", { ascending: false })
      .limit(Number.isFinite(limit) && limit > 0 ? limit : 20);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, errors: data || [] });
  });

  router.get("/admin/steps", requireAdmin, async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const { data, error } = await supabaseAdmin
      .from("mega_generations")
      .select("mg_id, mg_generation_id, mg_step_no, mg_step_type, mg_payload, mg_created_at")
      .eq("mg_record_type", "mma_step")
      .order("mg_created_at", { ascending: false })
      .limit(Number.isFinite(limit) && limit > 0 ? limit : 50);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, steps: data || [] });
  });

  return router;
}
