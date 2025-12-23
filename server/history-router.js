// ./server/history-controller.js
"use strict";

import crypto from "node:crypto";
import { getSupabaseAdmin, sbEnabled } from "../supabase.js";
import { megaEnsureCustomer, megaGetCredits, megaWriteSession } from "../mega-db.js";

function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

// Matches your server behavior: keep pass:user:* intact, shorten pass:anon:* if present.
function normalizeIncomingPassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:anon:")) return s.slice("pass:anon:".length).trim();
  return s;
}

function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
}

// Optional: attach auth user to customer row (safe; won’t break if no auth)
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

  return { userId, email, token };
}

// Build candidate passIds so history doesn’t “look empty” if old/short anon ids exist
function buildPassCandidates(primaryPassId) {
  const candidates = new Set();
  if (primaryPassId) candidates.add(primaryPassId);

  // If caller passed "pass:anon:xxx", also try "xxx"
  if (primaryPassId.startsWith("pass:anon:")) {
    candidates.add(primaryPassId.slice("pass:anon:".length));
  }

  // If caller passed "xxx" (short anon), also try "pass:anon:xxx"
  if (primaryPassId && !primaryPassId.startsWith("pass:")) {
    candidates.add(`pass:anon:${primaryPassId}`);
  }

  return Array.from(candidates).filter(Boolean);
}

// ======================================================
// GET /history/pass/:passId
// ======================================================
export async function getHistoryByPassId(req, res) {
  const requestId = `hist_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const rawParam = safeString(req.params.passId, "");
    const primaryPassId = normalizeIncomingPassId(rawParam);
    setPassIdHeader(res, primaryPassId);

    const authUser = await getAuthUser(req);

    // Ensure customer exists (and attach auth identity if provided)
    await megaEnsureCustomer({
      passId: primaryPassId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const { credits, expiresAt } = await megaGetCredits(primaryPassId);

    const supabase = getSupabaseAdmin();

    const passList = buildPassCandidates(primaryPassId);

    const { data: rows, error } = await supabase
      .from("mega_generations")
      .select(
        "mg_id, mg_record_type, mg_pass_id, mg_generation_id, mg_session_id, mg_platform, mg_title, mg_type, mg_prompt, mg_output_url, mg_created_at, mg_meta, mg_content_type, mg_mma_mode"
      )
      .in("mg_pass_id", passList)
      .in("mg_record_type", ["generation", "feedback", "session"])
      .order("mg_created_at", { ascending: false })
      .limit(500);

    if (error) throw error;

    const all = Array.isArray(rows) ? rows : [];

    const sessions = all
      .filter((r) => r.mg_record_type === "session")
      .map((r) => ({
        id: String(r.mg_id || `session:${r.mg_session_id || ""}`),
        sessionId: String(r.mg_session_id || ""),
        passId: String(r.mg_pass_id || primaryPassId),
        platform: String(r.mg_platform || "web"),
        title: String(r.mg_title || "Mina session"),
        createdAt: String(r.mg_created_at || nowIso()),
      }));

    const generations = all
      .filter((r) => r.mg_record_type === "generation")
      .map((r) => ({
        id: String(r.mg_id || r.mg_generation_id || ""),
        generationId: String(r.mg_generation_id || ""),
        type: String(r.mg_type || r.mg_content_type || "image"),
        sessionId: String(r.mg_session_id || ""),
        passId: String(r.mg_pass_id || primaryPassId),
        platform: String(r.mg_platform || "web"),
        prompt: String(r.mg_prompt || ""),
        outputUrl: String(r.mg_output_url || ""),
        createdAt: String(r.mg_created_at || nowIso()),
        meta: r.mg_meta ?? null,
        mode: String(r.mg_mma_mode || ""),
      }));

    const feedbacks = all
      .filter((r) => r.mg_record_type === "feedback")
      .map((r) => {
        const meta = r.mg_meta && typeof r.mg_meta === "object" ? r.mg_meta : {};
        return {
          id: String(r.mg_id || ""),
          passId: String(r.mg_pass_id || primaryPassId),
          resultType: String(meta.resultType || meta.result_type || "image"),
          platform: String(meta.platform || "web"),
          prompt: String(meta.prompt || ""),
          comment: String(meta.comment || ""),
          imageUrl: meta.imageUrl ? String(meta.imageUrl) : undefined,
          videoUrl: meta.videoUrl ? String(meta.videoUrl) : undefined,
          createdAt: String(r.mg_created_at || nowIso()),
        };
      });

    // ✅ Never empty: create a tiny welcome session if everything is empty
    if (sessions.length === 0 && generations.length === 0 && feedbacks.length === 0) {
      const sid = crypto.randomUUID();

      try {
        await megaWriteSession({
          passId: primaryPassId,
          sessionId: sid,
          platform: "web",
          title: "Welcome ✨",
          meta: { placeholder: true },
        });
      } catch {
        // even if DB write fails, we still return a placeholder for UI
      }

      sessions.unshift({
        id: `session:${sid}`,
        sessionId: sid,
        passId: primaryPassId,
        platform: "web",
        title: "Welcome ✨",
        createdAt: nowIso(),
        placeholder: true,
      });
    }

    return res.json({
      ok: true,
      requestId,
      passId: primaryPassId,
      credits: { balance: Number(credits || 0), expiresAt: expiresAt ?? null },
      sessions,
      generations,
      feedbacks,
    });
  } catch (e) {
    console.error("GET /history/pass/:passId failed", e);
    return res
      .status(500)
      .json({ ok: false, requestId, error: "HISTORY_FAILED", message: e?.message || String(e) });
  }
}

// ======================================================
// DELETE /history/:id
// ======================================================
export async function deleteHistoryItem(req, res) {
  const requestId = `del_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const id = safeString(req.params.id, "");
    if (!id) return res.status(400).json({ ok: false, requestId, error: "MISSING_ID" });

    const supabase = getSupabaseAdmin();

    // Try delete by mg_id first
    const del1 = await supabase.from("mega_generations").delete().eq("mg_id", id).select("mg_id");
    const count1 = Array.isArray(del1.data) ? del1.data.length : 0;

    // Fallback: if frontend sent a generation_id
    let count = count1;
    if (count === 0 && !id.startsWith("credit_transaction:")) {
      const del2 = await supabase.from("mega_generations").delete().eq("mg_generation_id", id).select("mg_id");
      count = Array.isArray(del2.data) ? del2.data.length : 0;
    }

    return res.json({ ok: true, requestId, deleted: count > 0 });
  } catch (e) {
    console.error("DELETE /history/:id failed", e);
    return res
      .status(500)
      .json({ ok: false, requestId, error: "DELETE_FAILED", message: e?.message || String(e) });
  }
}
