// ./server/mma/mma-router.js
// Express router for Mina Mind API
// Routes fan out to controller helpers and expose SSE replay.

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

// ✅ MEGA credits helpers
import {
  resolvePassId as megaResolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
} from "../../mega-db.js";

const router = express.Router();

// ======================================================
// CREDIT CONFIG (edit here)
// ======================================================
const MMA_CREDIT_COSTS = {
  still: 1, // image
  video: 5, // video
  type: 0, // text-only (suggest/prompt-only)
};

// If any of these appear in the request intent, we treat it as text-only (0 credits)
const MMA_ZERO_CREDIT_INTENTS = new Set([
  "type",
  "type_for_me",
  "typeforme",
  "typing",
  "text",
  "text_only",
  "textonly",
  "prompt_only",
  "promptonly",
  "suggest",
  "suggest_only",
  "suggestonly",
]);

// Ledger idempotency
const MMA_CHARGE_REF_TYPE = "mma_charge";

// What to return when user has insufficient credits
const MMA_INSUFFICIENT_STATUS = 402;

// ======================================================
// Helpers
// ======================================================
function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

// ✅ Idempotency key (lets us dedupe charges if the client double-fires)
function extractIdempotencyKey(body = {}) {
  return safeString(
    body?.idempotency_key ??
      body?.idempotencyKey ??
      body?.inputs?.idempotency_key ??
      body?.inputs?.idempotencyKey ??
      "",
    ""
  );
}

// ======================================================
// ✅ NEW: Server-side request dedupe (prevents two generations)
// - Works for fast double-clicks / retries
// - Keeps a short-lived cache of the first response
// ======================================================
const MMA_IDEM_WINDOW_MS = 60_000; // 60 seconds
const MMA_IDEM_DONE = new Map(); // key -> { ts, result }
const MMA_IDEM_INFLIGHT = new Map(); // key -> Promise<result>

function getIdemRouteKey(mode, body = {}) {
  const idem = extractIdempotencyKey(body);
  if (!idem) return null;
  return `${mode}:idem:${idem}`;
}

function getIdemCached(key) {
  if (!key) return null;
  const hit = MMA_IDEM_DONE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > MMA_IDEM_WINDOW_MS) {
    MMA_IDEM_DONE.delete(key);
    return null;
  }
  return hit.result;
}

async function runOncePerIdem(key, fn) {
  if (!key) return await fn();

  const cached = getIdemCached(key);
  if (cached) return cached;

  const inflight = MMA_IDEM_INFLIGHT.get(key);
  if (inflight) return await inflight;

  const p = (async () => {
    const result = await fn();
    MMA_IDEM_DONE.set(key, { ts: Date.now(), result });
    return result;
  })();

  MMA_IDEM_INFLIGHT.set(key, p);

  try {
    return await p;
  } finally {
    if (MMA_IDEM_INFLIGHT.get(key) === p) MMA_IDEM_INFLIGHT.delete(key);
  }
}

function extractGenerationId(result, fallback = null) {
  // Try common shapes
  const a =
    result?.generation_id ??
    result?.generationId ??
    result?.generation?.id ??
    result?.generation?.generation_id ??
    result?.mg_generation_id ??
    null;

  const gid = safeString(a || fallback || "", "");
  return gid || null;
}

function hasTextOnlyFlags(body = {}) {
  // top-level
  if (body?.suggestOnly === true || body?.suggest_only === true) return true;
  if (body?.textOnly === true || body?.text_only === true) return true;
  if (body?.promptOnly === true || body?.prompt_only === true) return true;
  if (body?.onlyText === true || body?.only_text === true) return true;

  // nested inputs (common)
  if (body?.inputs?.suggestOnly === true || body?.inputs?.suggest_only === true) return true;
  if (body?.inputs?.textOnly === true || body?.inputs?.text_only === true) return true;
  if (body?.inputs?.promptOnly === true || body?.inputs?.prompt_only === true) return true;
  if (body?.inputs?.onlyText === true || body?.inputs?.only_text === true) return true;

  return false;
}

function isTextOnlyRequest({ body = {}, result = {} } = {}) {
  // Explicit flags always win
  if (hasTextOnlyFlags(body)) return true;

  // Intent/action string
  const intent =
    body?.intent ||
    body?.action ||
    body?.op ||
    body?.operation ||
    body?.mode ||
    body?.type ||
    body?.inputs?.intent ||
    body?.inputs?.action ||
    body?.inputs?.op;

  const s = safeString(intent, "").toLowerCase();
  if (s && MMA_ZERO_CREDIT_INTENTS.has(s)) return true;

  // Or result comes back text-like
  const rt = safeString(result?.resultType || result?.type || result?.kind || "", "").toLowerCase();
  if (rt && (rt === "text" || rt === "typing" || rt === "suggestion")) return true;

  const ct = safeString(result?.contentType || result?.content_type || "", "").toLowerCase();
  if (ct && ct.startsWith("text/")) return true;

  return false;
}

function inferCost({ mode, body, result }) {
  // Only zero-credit when request is truly text-only (suggest/prompt-only)
  if (isTextOnlyRequest({ body, result })) return MMA_CREDIT_COSTS.type;
  if (mode === "video") return MMA_CREDIT_COSTS.video;
  return MMA_CREDIT_COSTS.still;
}

async function ensureEnoughCreditsOrThrow(passId, cost) {
  if (!cost || cost <= 0) return;

  const { credits } = await megaGetCredits(passId);
  if (Number(credits || 0) < cost) {
    const err = new Error("INSUFFICIENT_CREDITS");
    err.statusCode = MMA_INSUFFICIENT_STATUS;
    err.details = { required: cost, balance: Number(credits || 0) };
    throw err;
  }
}

async function chargeOnSuccess({ passId, cost, generationId, mode, idempotencyKey }) {
  if (!cost || cost <= 0) return { charged: 0, already: false };

  const idem = safeString(idempotencyKey, "");
  const gid = safeString(generationId, "");

  // ✅ If client sent idempotency key, use it for dedupe (best)
  // Otherwise fall back to generation id
  const refId = idem
    ? `${mode}:idem:${idem}`
    : gid
      ? `${mode}:${gid}`
      : `${mode}:no_generation_id:${Date.now()}`;

  const already = await megaHasCreditRef({ refType: MMA_CHARGE_REF_TYPE, refId });
  if (already) return { charged: 0, already: true };

  await megaAdjustCredits({
    passId,
    delta: -Math.abs(cost),
    reason: mode === "video" ? "mma-video" : "mma-still",
    source: "mma",
    refType: MMA_CHARGE_REF_TYPE,
    refId,
    grantedAt: null,
  });

  return { charged: cost, already: false };
}

// ======================================================
// Routes
// ======================================================
router.post("/still/create", async (req, res) => {
  try {
    const passId = megaResolvePassId(req, req.body || {});
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const idemKey = getIdemRouteKey("still", req.body || {});

    const result = await runOncePerIdem(idemKey, async () => {
      // Pre-check credits (based on intent/body)
      const preCost = inferCost({ mode: "still", body: req.body || {}, result: {} });
      await ensureEnoughCreditsOrThrow(passId, preCost);

      const r = await handleMmaCreate({ mode: "still", body: req.body });

      // Charge on success (based on body + actual result)
      const cost = inferCost({ mode: "still", body: req.body || {}, result: r });
      const gid = extractGenerationId(r, null);

      await chargeOnSuccess({
        passId,
        cost,
        generationId: gid,
        mode: "still",
        idempotencyKey: extractIdempotencyKey(req.body || {}),
      });

      if (r && typeof r === "object") {
        r.billing = { cost, mode: "still" };
      }

      return r;
    });

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
  try {
    const passId = megaResolvePassId(req, req.body || {});
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const idemKey = getIdemRouteKey("still", req.body || {});

    const result = await runOncePerIdem(idemKey, async () => {
      const preCost = inferCost({ mode: "still", body: req.body || {}, result: {} });
      await ensureEnoughCreditsOrThrow(passId, preCost);

      // ✅ Correct handler (tweak pipeline)
      const r = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });

      const cost = inferCost({ mode: "still", body: req.body || {}, result: r });
      const gid = extractGenerationId(r, null);

      await chargeOnSuccess({
        passId,
        cost,
        generationId: gid,
        mode: "still",
        idempotencyKey: extractIdempotencyKey(req.body || {}),
      });

      if (r && typeof r === "object") {
        r.billing = { cost, mode: "still" };
      }

      return r;
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
  try {
    const passId = megaResolvePassId(req, req.body || {});
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const idemKey = getIdemRouteKey("video", req.body || {});

    const result = await runOncePerIdem(idemKey, async () => {
      const preCost = inferCost({ mode: "video", body: req.body || {}, result: {} });
      await ensureEnoughCreditsOrThrow(passId, preCost);

      const r = await handleMmaCreate({ mode: "video", body: req.body });

      const cost = inferCost({ mode: "video", body: req.body || {}, result: r });
      const gid = extractGenerationId(r, null);

      await chargeOnSuccess({
        passId,
        cost,
        generationId: gid,
        mode: "video",
        idempotencyKey: extractIdempotencyKey(req.body || {}),
      });

      if (r && typeof r === "object") {
        r.billing = { cost, mode: "video" };
      }

      return r;
    });

    res.json(result);
  } catch (err) {
    console.error("[mma] video animate error", err);
    res.status(err?.statusCode || 500).json({
      error: err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : "MMA_ANIMATE_FAILED",
      message: err?.message,
      details: err?.details || undefined,
    });
  }
});

router.post("/video/:generation_id/tweak", async (req, res) => {
  try {
    const passId = megaResolvePassId(req, req.body || {});
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const idemKey = getIdemRouteKey("video", req.body || {});

    const result = await runOncePerIdem(idemKey, async () => {
      const preCost = inferCost({ mode: "video", body: req.body || {}, result: {} });
      await ensureEnoughCreditsOrThrow(passId, preCost);

      // ✅ Correct handler (tweak pipeline)
      const r = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });

      const cost = inferCost({ mode: "video", body: req.body || {}, result: r });
      const gid = extractGenerationId(r, null);

      await chargeOnSuccess({
        passId,
        cost,
        generationId: gid,
        mode: "video",
        idempotencyKey: extractIdempotencyKey(req.body || {}),
      });

      if (r && typeof r === "object") {
        r.billing = { cost, mode: "video" };
      }

      return r;
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
  try {
    // ✅ Never charge credits for events
    const result = await handleMmaEvent(req.body || {});
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
    const status = toUserStatus(data?.mg_mma_status || "queued"); // ✅ don't leak internals

    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));

    registerSseClient(req.params.generation_id, res, { scanLines, status });
  } catch {
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
