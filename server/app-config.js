function safeJson(value, fallback = {}) {
  if (!value || typeof value !== "object") return fallback;
  if (Array.isArray(value)) return fallback;
  return value;
}

export function parseVersionFromId(mgId) {
  const match = String(mgId || "").match(/\.v(\d+)$/);
  return match ? Number(match[1]) : null;
}

const appConfigCache = new Map();
const APP_CONFIG_TTL_MS = Number(process.env.APP_CONFIG_TTL_MS || 5000);

export async function getActiveAppConfig(supabaseAdmin, key) {
  if (!supabaseAdmin) return null;

  const now = Date.now();
  const cached = appConfigCache.get(key);
  if (cached && now - cached.fetchedAt < APP_CONFIG_TTL_MS) {
    return cached.value;
  }

  const { data, error } = await supabaseAdmin
    .from("mega_admin")
    .select("mg_id, mg_value, mg_key, mg_created_at")
    .eq("mg_record_type", "app_config")
    .eq("mg_key", key)
    .contains("mg_value", { enabled: true })
    .order("mg_created_at", { ascending: false })
    .limit(50); // ✅ avoid scanning huge history

  if (error) throw error;

  const enabledRows = Array.isArray(data) ? data : [];
  let latest = null;

  for (const row of enabledRows) {
    const value = safeJson(row.mg_value);

    // ✅ IMPORTANT: use ?? not || so version=0 isn't discarded
    const idVer = parseVersionFromId(row.mg_id);
    const valVer = typeof value.version === "number" ? value.version : Number(value.version);

    const version =
      (idVer ?? (Number.isFinite(valVer) ? valVer : null) ?? 0);

    if (!latest || version > latest.version) {
      latest = {
        key,
        id: row.mg_id,
        version,
        value,
      };
    }
  }

  const result = latest || null;
  appConfigCache.set(key, { value: result, fetchedAt: now });

  return result;
}
