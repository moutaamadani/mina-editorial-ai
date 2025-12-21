import crypto from "node:crypto";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { emojiForContext, formatErrorCode } from "./errorEmoji.js";

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function truncate(value, max) {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

export async function logError(input = {}) {
  const safeInput = input || {};
  const status = Number.isFinite(safeInput.status) ? Number(safeInput.status) : 500;
  const emoji =
    safeInput.emoji ||
    emojiForContext({
      status,
      action: safeInput.action,
      sourceSystem: safeInput.sourceSystem,
    });
  const code = safeInput.code || "ERROR";
  const mgErrorCode = formatErrorCode(emoji, code);

  const messageRaw = safeInput.message || "Unknown error";
  const mgErrorMessage = truncate(String(messageRaw), 2000);

  const shouldStoreStack = process.env.NODE_ENV !== "production";
  const stackValue =
    shouldStoreStack && typeof safeInput.stack === "string"
      ? truncate(safeInput.stack, 4000)
      : null;

  const record = {
    mg_id: crypto.randomUUID(),
    mg_record_type: "error",
    mg_action: safeInput.action || "internal.error",
    mg_status: status,
    mg_route: safeInput.route || null,
    mg_method: safeInput.method || null,
    mg_user_id: isUuid(safeInput.userId) ? safeInput.userId : null,
    mg_email: safeInput.email || null,
    mg_ip: safeInput.ip || null,
    mg_user_agent: safeInput.userAgent || null,
    mg_error_message: mgErrorMessage,
    mg_error_stack: stackValue,
    mg_error_code: mgErrorCode,
    mg_detail: safeInput.detail || {},
    mg_payload: safeInput.payload || safeInput.detail || {},
    mg_source_system: safeInput.sourceSystem || "mina-editorial-ai",
    mg_event_at: new Date().toISOString(),
  };

  try {
    if (!supabaseAdmin) {
      console.error("[logError] Supabase admin client not configured");
      return null;
    }

    const { error } = await supabaseAdmin.from("mega_admin").insert([record]);
    if (error) {
      console.error("[logError] failed to insert error log", error);
    }
  } catch (err) {
    console.error("[logError] unexpected failure", err);
  }

  return record.mg_id;
}
