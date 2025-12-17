import { getSupabaseAdmin, logAdminAction, upsertProfileRow, upsertSessionRow } from "./supabase.js";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY || "";

function normalizeEmail(email) {
  if (!email) return null;
  const normalized = String(email).trim().toLowerCase();
  return normalized || null;
}

function normalizeBearer(token) {
  if (!token) return null;
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

async function isAdminAllowlisted(supabase, { userId, email }) {
  try {
    const normalizedEmail = normalizeEmail(email);

    if (userId) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_admin_allowlist")
        .eq("mg_user_id", userId)
        .eq("mg_admin_allowlist", true)
        .maybeSingle();

      if (data?.mg_admin_allowlist === true) return true;
    }

    if (normalizedEmail) {
      const { data } = await supabase
        .from("mega_customers")
        .select("mg_admin_allowlist")
        .eq("mg_email", normalizedEmail)
        .eq("mg_admin_allowlist", true)
        .maybeSingle();

      if (data?.mg_admin_allowlist === true) return true;
    }
  } catch (err) {
    console.error("[auth] admin allowlist check failed", err);
  }

  return false;
}

function getRequestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    route: req.path,
    method: req.method,
  };
}

export async function tryAdmin(req, { audit = false } = {}) {
  const meta = getRequestMeta(req);
  const tokenFromHeader = normalizeBearer(
    req.get("authorization") || req.get("x-admin-secret")
  );
  const tokenFromQuery = normalizeBearer(req.query?.key);
  const token = tokenFromHeader || tokenFromQuery;

  if (!token) {
    if (audit) {
      void logAdminAction({
        action: "admin_denied",
        status: 401,
        route: meta.route,
        method: meta.method,
        detail: { reason: "missing_token", ip: meta.ip, userAgent: meta.userAgent },
      });
    }
    return { ok: false, status: 401 };
  }

  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      if (audit) {
        void logAdminAction({
          action: "admin_denied",
          status: 503,
          route: meta.route,
          method: meta.method,
          detail: {
            reason: "missing_supabase_env",
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
        });
      }
      return { ok: false, status: 401 };
    }

    let userId = null;
    let email = null;

    if (ADMIN_SECRET && token === ADMIN_SECRET) {
      email = normalizeEmail(process.env.ADMIN_EMAIL || null);
      userId = process.env.ADMIN_USER_ID || null;
    } else if (ADMIN_DASHBOARD_KEY && token === ADMIN_DASHBOARD_KEY) {
      email = normalizeEmail(process.env.ADMIN_EMAIL || null);
      userId = process.env.ADMIN_USER_ID || null;
    } else {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        if (audit) {
          void logAdminAction({
            action: "admin_denied",
            status: 401,
            route: meta.route,
            method: meta.method,
            detail: {
              reason: "invalid_token",
              ip: meta.ip,
              userAgent: meta.userAgent,
              error: error?.message,
            },
          });
        }
        return { ok: false, status: 401 };
      }

      userId = data.user.id;
      email = normalizeEmail(data.user.email || null);
    }

    const allowlisted = await isAdminAllowlisted(supabase, { userId, email });
    const status = allowlisted ? 200 : 403;

    void upsertProfileRow({ userId, email });
    void upsertSessionRow({
      userId,
      email,
      token,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    if (audit) {
      void logAdminAction({
        userId,
        email,
        action: allowlisted ? "admin_access" : "admin_denied",
        route: meta.route,
        method: meta.method,
        status,
        detail: {
          ip: meta.ip,
          userAgent: meta.userAgent,
          reason: allowlisted ? undefined : "not_allowlisted",
        },
      });
    }

    return { ok: allowlisted, status, email, userId };
  } catch (err) {
    console.error("[auth] tryAdmin failed", err);
    if (audit) {
      void logAdminAction({
        action: "admin_denied",
        status: 500,
        route: meta.route,
        method: meta.method,
        detail: {
          reason: "invalid_token",
          ip: meta.ip,
          userAgent: meta.userAgent,
          error: err?.message,
        },
      });
    }
    return { ok: false, status: 401 };
  }
}

export async function requireAdmin(req, res, next) {
  const result = await tryAdmin(req, { audit: true });
  if (!result.ok) {
    return res.status(result.status || 401).json({ error: "Unauthorized" });
  }
  req.user = { email: result.email || null, userId: result.userId || null };
  next();
}
