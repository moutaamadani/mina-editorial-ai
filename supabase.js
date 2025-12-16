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

export async function upsertProfileRow({ userId, email, shopifyCustomerId }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    if (!userId && !normalizedEmail) return;

    const now = new Date().toISOString();
    const mgId = userId ? `profile:${userId}` : `profile:${normalizedEmail}`;

    const payload = {
      mg_id: mgId,
      mg_record_type: "profile",
      mg_user_id: userId && UUID_REGEX.test(userId) ? userId : null,
      mg_email: normalizedEmail,
      mg_shopify_customer_id: shopifyCustomerId || null,
      mg_created_at: now,
      mg_updated_at: now,
    };

    const { error } = await supabase
      .from("mega_admin")
      .upsert(payload, { onConflict: "mg_id" });
    if (error) {
      console.error("[supabase] upsertProfileRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertProfileRow failed", err);
  }
}

export async function upsertSessionRow({ userId, email, token, ip, userAgent }) {
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

    const payload = {
      mg_id: `admin_session:${hash}`,
      mg_record_type: "admin_session",
      mg_session_hash: hash,
      mg_user_id: validUserId,
      mg_email: normalizedEmail,
      mg_ip: safeIp(ip),
      mg_user_agent: safeUserAgent(userAgent),
      mg_first_seen_at: now,
      mg_last_seen_at: now,
      mg_created_at: now,
      mg_updated_at: now,
    };

    const { error } = await supabase
      .from("mega_admin")
      .upsert(payload, { onConflict: "mg_id" });
    if (error) {
      console.error("[supabase] upsertSessionRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertSessionRow failed", err);
  }
}

export async function logAdminAction({
  userId,
  email,
  action,
  route,
  method,
  status,
  detail,
  id,
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
      mg_user_id: validUserId,
      mg_email: normalizedEmail,
      mg_action: action || null,
      mg_route: route || null,
      mg_method: method || null,
      mg_status: typeof status === "number" ? status : null,
      mg_detail: detail ?? null,
      mg_created_at: now,
      mg_updated_at: now,
    };

    const { error } = await supabase.from("mega_admin").upsert(payload, { onConflict: "mg_id" });
    if (error) {
      console.error("[supabase] logAdminAction error", error);
    }
  } catch (err) {
    console.error("[supabase] logAdminAction failed", err);
  }
}

// Additional legacy helpers removed; MEGA tables are the source of truth.
