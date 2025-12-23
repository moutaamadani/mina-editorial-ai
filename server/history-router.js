// ./server/history-router.js
// History API for MEGA (reads from mega_generations using mg_* columns)
// Ensures history doesn’t “look empty” due to passId mismatches (anon short vs pass:anon:*),
// and also supports linked identities via email/user token when available.

import express from "express";
import crypto from "node:crypto";

import { getSupabaseAdmin, sbEnabled } from "../supabase.js";
import { megaEnsureCustomer, megaGetCredits } from "../mega-db.js";

const router = express.Router();

// =========================
// Config (edit here)
// =========================
const HISTORY_MAX_ROWS = Number(process.env.HISTORY_MAX_ROWS || 500);

// =========================
// Helpers
// =========================
function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

// Keep pass:* untouched.
// If you receive a legacy anon-short id (uuid only), normalize it to pass:anon:<uuid>.
function normalizePassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:")) return s;
  // legacy anon-short
  return `pass:anon:${s}`;
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const lower = token.toLowerCase();
  if (!token || lower === "null" || lower === "undefined" || lower === "[object object]") return null;
  return token;
}

async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const userId = safeString(data.user.id, "");
  const email = safeString(data.user.email, "").toLowerCase() || null;
  if (!userId) return null;

  return { userId, email };
}

// Build a candidate list so history doesn’t “look empty” due to legacy anon-short IDs
async function buildPassCandidates({ primaryPassId, authUser, supabase }) {
  const set = new Set();

  const pid = normalizePassId(primaryPassId);
  if (pid) set.add(pid);

  // legacy mapping: pass:anon:<uuid> <-> <uuid>
  if (pid.startsWith("pass:anon:")) {
    set.add(pid.slice("pass:anon:".length));
  } else if (!pid.startsWith("pass:")) {
    set.add(`pass:anon:${pid}`);
  }

  // if authed, also consider pass:email:<email>
  if (authUser?.email) {
    set.add(`pass:email:${authUser.email}`);
  }

  // include any other passIds that share the same email/user_id in mega_customers
  try {
    if (supabase && (authUser?.email || authUser?.userId)) {
      let q = supabase.from("mega_customers").select("mg_pass_id").limit(50);

      if (authUser?.email && authUser?.userId) {
        // OR is not great in PostgREST without rpc, so do 2 queries
        const { data: byEmail } = await supabase
          .from("mega_customers")
          .select("mg_pass_id")
          .eq("mg_email", authUser.email)
          .limit(50);
        (byEmail || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));

        const { data: byUser } = await supabase
          .from("mega_customers")
          .select("mg_pass_id")
          .eq("mg_user_id", authUser.userId)
          .limit(50);
        (byUser || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      } else if (authUser?.email) {
        const { data } = await q.eq("mg_email", authUser.email);
        (data || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      } else if (authUser?.userId) {
        const { data } = await q.eq("mg_user_id", authUser.userId);
        (data || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      }
    }
  } catch {
    // optional
  }

  return Array.from(set).filter(Boolean).slice(0, 20);
}

// =========================
// Routes
// =========================

// GET /history/pass/:passId
router.get("/history/pass/:passId", async (req, res) => {
  const requestId = `hist_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE_CLIENT" });

    const authUser = await getAuthUser(req);

    const primaryPassId = normalizePassId(req.params.passId || "");
    res.set("X-Mina-Pass-Id", primaryPassId);

    // Ensure customer exists (for this passId)
    await megaEnsureCustomer({
      passId: primaryPassId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    // Credits for the primary passId
    const { credits, expiresAt } = await megaGetCredits(primaryPassId);

    // Pull history across candidate passIds so it never “looks empty” due to legacy/passId mismatches
    const passIds = await buildPassCandidates({ primaryPassId, authUser, supabase });

    const { data, error } = await supabase
      .from("mega_generations")
      .select(
        "mg_id, mg_record_type, mg_pass_id, mg_generation_id, mg_session_id, mg_platform, mg_title, mg_type, mg_prompt, mg_output_url, mg_created_at, mg_meta, mg_content_type, mg_mma_mode"
      )
      .in("mg_pass_id", passIds)
      .in("mg_record_type", ["generation", "feedback", "session"])
      .order("mg_created_at", { ascending: false })
      .limit(HISTORY_MAX_ROWS);

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];

    const sessions = rows
      .filter((r) => r.mg_record_type === "session")
      .map((r) => ({
        id: String(r.mg_id || ""),
        sessionId: String(r.mg_session_id || ""),
        passId: String(r.mg_pass_id || primaryPassId),
        platform: String(r.mg_platform || "web"),
        title: r.mg_title ? String(r.mg_title) : "",
        createdAt: String(r.mg_created_at || nowIso()),
      }));

    const generations = rows
      .filter((r) => r.mg_record_type === "generation")
      .map((r) => ({
        id: String(r.mg_id || r.mg_generation_id || ""),
        generationId: String(r.mg_generation_id || ""),
        type: String(r.mg_type || r.mg_content_type || "image"),
        mode: String(r.mg_mma_mode || ""),
        sessionId: String(r.mg_session_id || ""),
        passId: String(r.mg_pass_id || primaryPassId),
        platform: String(r.mg_platform || "web"),
        prompt: String(r.mg_prompt || ""),
        outputUrl: String(r.mg_output_url || ""),
        createdAt: String(r.mg_created_at || nowIso()),
        meta: r.mg_meta ?? null,
      }));

    const feedbacks = rows
      .filter((r) => r.mg_record_type === "feedback")
      .map((r) => {
        const meta = r.mg_meta && typeof r.mg_meta === "object" ? r.mg_meta : {};
        const payload = meta?.payload && typeof meta.payload === "object" ? meta.payload : meta;

        return {
          id: String(r.mg_id || ""),
          passId: String(r.mg_pass_id || primaryPassId),
          resultType: String(payload.resultType || payload.result_type || "image"),
          platform: String(payload.platform || "web"),
          prompt: String(payload.prompt || ""),
          comment: String(payload.comment || ""),
          imageUrl: payload.imageUrl ? String(payload.imageUrl) : undefined,
          videoUrl: payload.videoUrl ? String(payload.videoUrl) : undefined,
          createdAt: String(r.mg_created_at || nowIso()),
        };
      });

    return res.json({
      ok: true,
      requestId,
      passId: primaryPassId,
      passIdsChecked: passIds,
      credits: { balance: credits, expiresAt },
      sessions,
      generations,
      feedbacks,
    });
  } catch (e) {
    console.error("GET /history/pass/:passId failed", e);
    return res.status(500).json({ ok: false, requestId, error: "HISTORY_FAILED", message: e?.message || String(e) });
  }
});

// DELETE /history/:id
router.delete("/history/:id", async (req, res) => {
  const requestId = `del_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE_CLIENT" });

    const id = safeString(req.params.id, "");
    if (!id) return res.status(400).json({ ok: false, requestId, error: "MISSING_ID" });

    // Try delete by mg_id first
    const del1 = await supabase.from("mega_generations").delete().eq("mg_id", id).select("mg_id");
    let deleted = Array.isArray(del1.data) ? del1.data.length : 0;

    // Fallback: if frontend sends generationId instead of mg_id
    if (deleted === 0) {
      const del2 = await supabase.from("mega_generations").delete().eq("mg_generation_id", id).select("mg_id");
      deleted = Array.isArray(del2.data) ? del2.data.length : 0;
    }

    return res.json({ ok: true, requestId, deleted: deleted > 0, deletedCount: deleted });
  } catch (e) {
    console.error("DELETE /history/:id failed", e);
    return res.status(500).json({ ok: false, requestId, error: "DELETE_FAILED", message: e?.message || String(e) });
  }
});

export default router;
