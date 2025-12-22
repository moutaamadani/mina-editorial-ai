// supabase.js — MEGA-only Supabase admin + admin logging helpers (ESM)
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

let cachedAdmin = null;

export function getSupabaseAdmin() {
  if (cachedAdmin) return cachedAdmin;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) return null;

  cachedAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedAdmin;
}

export function sbEnabled() {
  return !!getSupabaseAdmin();
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function stableSessionHash(token) {
  const secret = process.env.MMA_LOGADMIN_COOKIE_SECRET || "mina_admin_session_secret";
  return sha256Hex(`${secret}:${token}`);
}

async function getFirstSeenFields(supabase, mgId) {
  try {
    const { data } = await supabase
      .from("mega_admin")
      .select("mg_first_seen_at")
      .eq("mg_id", mgId)
      .maybeSingle();
    return { firstSeenAt: data?.mg_first_seen_at || null };
  } catch {
    return { firstSeenAt: null };
  }
}

export async function logAdminAction({
  userId = null,
  email = null,
  action = "admin_action",
  status = 200,
  route = null,
  method = null,
  detail = null,
  ip = null,
  userAgent = null,
} = {}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const mgId = `admin_audit:${crypto.randomUUID()}`;
    const ts = nowIso();

    await supabase.from("mega_admin").insert({
      mg_id: mgId,
      mg_record_type: "admin_audit",
      mg_user_id: userId,
      mg_email: email,
      mg_action: action,
      mg_status: status,
      mg_route: route,
      mg_method: method,
      mg_detail: detail ?? {},
      mg_ip: ip,
      mg_user_agent: userAgent,
      mg_event_at: ts,
      mg_created_at: ts,
      mg_updated_at: ts,
      mg_source_system: "api",
    });
  } catch (err) {
    console.error("[supabase] logAdminAction failed", err);
  }
}

export async function upsertProfileRow({ userId = null, email = null } = {}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const key = userId || (email ? String(email).toLowerCase() : null);
    if (!key) return;

    const mgId = `profile:${key}`;
    const ts = nowIso();

    const { firstSeenAt } = await getFirstSeenFields(supabase, mgId);

    await supabase.from("mega_admin").upsert(
      {
        mg_id: mgId,
        mg_record_type: "profile",
        mg_user_id: userId,
        mg_email: email ? String(email).toLowerCase() : null,
        mg_first_seen_at: firstSeenAt || ts,
        mg_last_seen_at: ts,
        mg_created_at: firstSeenAt ? undefined : ts,
        mg_updated_at: ts,
        mg_source_system: "api",
      },
      { onConflict: "mg_id" }
    );
  } catch (err) {
    console.error("[supabase] upsertProfileRow failed", err);
  }
}

export async function upsertSessionRow({
  userId = null,
  email = null,
  token = null,
  ip = null,
  userAgent = null,
} = {}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;
    if (!token) return;

    const sessionHash = stableSessionHash(token);
    const mgId = `admin_session:${sessionHash}`;
    const ts = nowIso();

    const { firstSeenAt } = await getFirstSeenFields(supabase, mgId);

    await supabase.from("mega_admin").upsert(
      {
        mg_id: mgId,
        mg_record_type: "admin_session",
        mg_session_hash: sessionHash,
        mg_user_id: userId,
        mg_email: email ? String(email).toLowerCase() : null,
        mg_ip: ip,
        mg_user_agent: userAgent,
        mg_first_seen_at: firstSeenAt || ts,
        mg_last_seen_at: ts,
        mg_created_at: firstSeenAt ? undefined : ts,
        mg_updated_at: ts,
        mg_source_system: "api",
      },
      { onConflict: "mg_id" }
    );
  } catch (err) {
    console.error("[supabase] upsertSessionRow failed", err);
  }
}
