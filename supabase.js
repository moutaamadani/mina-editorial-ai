// supabase.js Part 1: Admin-only Supabase helpers
// Part 1.1: Initializes a cached admin client and writes basic audit/profile rows.
// Part 1.1.1: Use these helpers from auth + server code instead of duplicating queries.
// Part 1.2: Normalization + safety helpers keep audit rows consistent and short.
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

let cachedClient = null;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function safeUserAgent(userAgent) {
  if (!userAgent) return null;
  const str = String(userAgent);
  return str.slice(0, 512);
}

function safeIp(ip) {
  if (!ip) return null;
  return String(ip).slice(0, 128);
}

export function getSupabaseAdmin() {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error(
        "[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; skipping Supabase admin client."
      );
      return null;
    }

    if (cachedClient) return cachedClient;

    cachedClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    return cachedClient;
  } catch (err) {
    console.error("[supabase] Failed to init admin client", err);
    return null;
  }
}

export async function upsertProfileRow({ userId, email, shopifyCustomerId /* unused for MMA */ }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    if (!userId && !normalizedEmail) return;

    const now = new Date().toISOString();
    const mgId = userId ? `profile:${userId}` : `profile:${normalizedEmail}`;

    // Preserve original created_at if row already exists
    const { data: existing, error: readErr } = await supabase
      .from("mega_admin")
      .select("mg_created_at")
      .eq("mg_id", mgId)
      .maybeSingle();

    if (readErr) console.error("[supabase] upsertProfileRow read error", readErr);

    const payload = {
      mg_id: mgId,
      mg_record_type: "profile",
      mg_user_id: userId && UUID_REGEX.test(userId) ? userId : null,
      mg_email: normalizedEmail,

      // MMA: do NOT write mg_shopify_customer_id (unused)
      mg_created_at: existing?.mg_created_at || now,
      mg_updated_at: now,
      mg_event_at: now,
      mg_source_system: "app",
    };

    const { error } = await supabase.from("mega_admin").upsert(payload, { onConflict: "mg_id" });
    if (error) console.error("[supabase] upsertProfileRow error", error);
  } catch (err) {
    console.error("[supabase] upsertProfileRow failed", err);
  }
}

export async function upsertSessionRow({ userId, email, token, ip /* unused */, userAgent /* unused */ }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    if (!token) {
      console.error("[supabase] upsertSessionRow missing token");
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;

    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const now = new Date().toISOString();

    const mgId = `admin_session:${hash}`;

    // Preserve first_seen_at (+ created_at) so we don't reset it on every upsert
    const { data: existing, error: readErr } = await supabase
      .from("mega_admin")
      .select("mg_first_seen_at, mg_created_at")
      .eq("mg_id", mgId)
      .maybeSingle();

    if (readErr) console.error("[supabase] upsertSessionRow read error", readErr);

    const firstSeenAt = existing?.mg_first_seen_at || now;
    const createdAt = existing?.mg_created_at || now;

    const payload = {
      mg_id: mgId,
      mg_record_type: "admin_session",
      mg_session_hash: hash,
      mg_user_id: validUserId,
      mg_email: normalizedEmail,

      // MMA: do NOT write mg_ip / mg_user_agent (unused)
      mg_first_seen_at: firstSeenAt,
      mg_last_seen_at: now,

      mg_created_at: createdAt,
      mg_updated_at: now,
      mg_event_at: now,
      mg_source_system: "app",
    };

    const { error } = await supabase.from("mega_admin").upsert(payload, { onConflict: "mg_id" });
    if (error) console.error("[supabase] upsertSessionRow error", error);
  } catch (err) {
    console.error("[supabase] upsertSessionRow failed", err);
  }
}

export async function logAdminAction({
  userId,
  email,
  action,
  route /* unused for MMA */,
  method /* unused for MMA */,
  status,
  detail,
  id,
  actorPassId = null,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const now = new Date().toISOString();

    const payload = {
      mg_id: id ? `admin_audit:${id}` : `admin_audit:${crypto.randomUUID()}`,
      mg_record_type: "admin_audit",

      // Optional but supported by your schema
      mg_actor_pass_id: actorPassId ? String(actorPassId) : null,

      mg_user_id: validUserId,
      mg_email: normalizedEmail,
      mg_action: action || null,
      mg_status: typeof status === "number" ? status : null,
      mg_detail: detail ?? null,

      // MMA: do NOT write mg_route / mg_method (unused)
      mg_created_at: now,
      mg_updated_at: now,
      mg_event_at: now,
      mg_source_system: "app",
    };

    const { error } = await supabase.from("mega_admin").upsert(payload, { onConflict: "mg_id" });
    if (error) console.error("[supabase] logAdminAction error", error);
  } catch (err) {
    console.error("[supabase] logAdminAction failed", err);
  }
}

// Additional legacy helpers removed; MEGA tables are the source of truth.
