// ./server/mma/mma-router.js
// Express router for Mina Mind API
// Routes fan out to controller helpers and expose SSE replay.
//
// IMPORTANT:
// - This router does NOT charge credits.
// - Credits are handled inside mma-controller pipelines (charge + refund logic).
// - Router keeps request dedupe (idempotency_key) to prevent double generations on retries/double-clicks.

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

import { resolvePassId as megaResolvePassId, megaEnsureCustomer } from "../../mega-db.js";

const router = express.Router();

// ======================================================
// ✅ SERVER-SIDE REQUEST DEDUPE (prevents 2 generations)
// - Same idempotency_key => same in-flight promise
// - Also caches briefly (covers retry / refresh)
// ======================================================
const MMA_REQ_TTL_MS = 2 * 60 * 1000; // 2 minutes
const _mmaInFlight = new Map(); // key -> Promise<result>
const _mmaCache = new Map(); // key -> { at, result }

function _now() {
  return Date.now();
}

function _pruneCache() {
  const t = _now();
  for (const [k, v] of _mmaCache.entries()) {
    if (!v || !v.at || t - v.at > MMA_REQ_TTL_MS) _mmaCache.delete(k);
  }
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

// ✅ Idempotency key (lets us dedupe requests)
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

// Make a stable dedupe key
function makeReqKey({ op, mode, passId, parentId, idem }) {
  const p = String(passId || "");
  const i = String(idem || "");
  const par = parentId ? String(parentId) : "";
  return `${op}:${mode}:${p}:${par}:idem:${i}`.toLowerCase();
}

async function runWithDedupe(key, fn) {
  if (!key) {
    const result = await fn();
    return { result, deduped: false };
  }

  _pruneCache();

  const cached = _mmaCache.get(key);
  if (cached && cached.result) return { result: cached.result, deduped: true };

  const inflight = _mmaInFlight.get(key);
  if (inflight) {
    const result = await inflight;
    return { result, deduped: true };
  }

  const p = (async () => {
    const result = await fn();
    _mmaCache.set(key, { at: _now(), result });
    return result;
  })();

  _mmaInFlight.set(key, p);

  try {
    const result = await p;
    return { result, deduped: false };
  } finally {
    const cur = _mmaInFlight.get(key);
    if (cur === p) _mmaInFlight.delete(key);
  }
}

// ======================================================
// Routes
// ======================================================
router.post("/still/create", async (req, res) => {
  const body = req.body || {};
  const idem = extractIdempotencyKey(body);

  try {
    const passId = megaResolvePassId(req, body);
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const key = idem ? makeReqKey({ op: "still_create", mode: "still", passId, parentId: null, idem }) : null;

    const { result, deduped } = await runWithDedupe(key, async () => {
      return await handleMmaCreate({ mode: "still", body });
    });

    if (deduped) res.set("X-Mina-Deduped", "1");
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
  const body = req.body || {};
  const idem = extractIdempotencyKey(body);

  try {
    const passId = megaResolvePassId(req, body);
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const parentId = req.params.generation_id;
    const key = idem ? makeReqKey({ op: "still_tweak", mode: "still", passId, parentId, idem }) : null;

    const { result, deduped } = await runWithDedupe(key, async () => {
      return await handleMmaStillTweak({
        parentGenerationId: parentId,
        body,
      });
    });

    if (deduped) res.set("X-Mina-Deduped", "1");
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
  const body = req.body || {};
  const idem = extractIdempotencyKey(body);

  try {
    const passId = megaResolvePassId(req, body);
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const key = idem ? makeReqKey({ op: "video_animate", mode: "video", passId, parentId: null, idem }) : null;

    const { result, deduped } = await runWithDedupe(key, async () => {
      return await handleMmaCreate({ mode: "video", body });
    });

    if (deduped) res.set("X-Mina-Deduped", "1");
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
  const body = req.body || {};
  const idem = extractIdempotencyKey(body);

  try {
    const passId = megaResolvePassId(req, body);
    res.set("X-Mina-Pass-Id", passId);
    await megaEnsureCustomer({ passId });

    const parentId = req.params.generation_id;
    const key = idem ? makeReqKey({ op: "video_tweak", mode: "video", passId, parentId, idem }) : null;

    const { result, deduped } = await runWithDedupe(key, async () => {
      return await handleMmaVideoTweak({
        parentGenerationId: parentId,
        body,
      });
    });

    if (deduped) res.set("X-Mina-Deduped", "1");
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
