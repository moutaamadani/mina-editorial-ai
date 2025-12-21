// mma-controller.js (PRODUCTION)
// - Real pipeline: OpenAI prompt -> Replicate generate -> store to R2 -> finalize
// - Writes: mega_customers (via megaEnsureCustomer), mega_generations (generation + steps + events)
// - SSE: status + scan lines streamed live + replay on reconnect

import crypto from "node:crypto";
import { Readable } from "node:stream";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { getSupabaseAdmin } from "../../supabase.js";
import {
  appendScanLine,
  computePassId,
  eventIdentifiers,
  generationIdentifiers,
  makeInitialVars,
  newUuid,
  nowIso,
  stepIdentifiers,
} from "./mma-utils.js";
import { addSseClient, sendDone, sendScanLine, sendStatus } from "./mma-sse.js";

// IMPORTANT: adjust this import path to wherever you placed Part 1 helpers.
import { megaEnsureCustomer } from "../mega-db.js"; // <-- CHANGE PATH IF NEEDED

// -----------------------------
// Config helpers
// -----------------------------

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function envStr(name, fallback = "") {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function requireEnv(name) {
  const v = envStr(name, "");
  if (!v) throw new Error(`MISSING_ENV:${name}`);
  return v;
}

function isNonEmpty(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pickFirstUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return pickFirstUrl(output[0]);
  if (typeof output === "object") {
    // some providers return {url: "..."} or {output: "..."}
    if (typeof output.url === "string") return output.url;
    if (typeof output.output === "string") return output.output;
  }
  return "";
}

function getMmaCosts(mode) {
  // Tune these without redeploy by env vars
  const stillCost = envInt("MMA_STILL_CREDITS_COST", 1);
  const videoCost = envInt("MMA_VIDEO_CREDITS_COST", 5);
  return mode === "video" ? videoCost : stillCost;
}

function getOpenAiModel() {
  return envStr("MMA_OPENAI_MODEL", envStr("OPENAI_MODEL", "gpt-4o-mini"));
}

function getReplicateModels() {
  // You can set either model *version* (recommended) or model *slug* if you already use it
  // Examples:
  //   MMA_SEADREAM_VERSION="stability-ai/sdxl:abc123..."
  //   MMA_KLING_VERSION="kling-ai/kling-video:deadbeef..."
  return {
    seadream: envStr("MMA_SEADREAM_VERSION", envStr("SEADREAM_VERSION", "")),
    kling: envStr("MMA_KLING_VERSION", envStr("KLING_VERSION", "")),
  };
}

function getProviderTimeoutMs(mode) {
  const still = envInt("MMA_PROVIDER_TIMEOUT_MS_STILL", 8 * 60 * 1000);
  const video = envInt("MMA_PROVIDER_TIMEOUT_MS_VIDEO", 35 * 60 * 1000);
  return mode === "video" ? video : still;
}

// -----------------------------
// R2 helpers (safe, streaming upload)
// -----------------------------

let _r2 = null;

function getR2Client() {
  if (_r2) return _r2;

  const endpoint = envStr("R2_ENDPOINT", "");
  const accessKeyId = envStr("R2_ACCESS_KEY_ID", "");
  const secretAccessKey = envStr("R2_SECRET_ACCESS_KEY", "");
  const region = envStr("R2_REGION", "auto");

  if (!endpoint || !accessKeyId || !secretAccessKey) return null;

  _r2 = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  return _r2;
}

async function storeRemoteToR2Public(remoteUrl, key) {
  const bucket = envStr("R2_BUCKET", "");
  const publicBase = envStr("R2_PUBLIC_BASE_URL", "");

  const r2 = getR2Client();
  if (!r2 || !bucket || !publicBase) {
    // If R2 not configured, fall back to remote url (still works, but not permanent)
    return { url: remoteUrl, key: "" };
  }

  const resp = await fetch(remoteUrl);
  if (!resp.ok) throw new Error(`R2_FETCH_FAILED:${resp.status}`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const bodyStream = resp.body ? Readable.fromWeb(resp.body) : null;
  if (!bodyStream) throw new Error("R2_FETCH_NO_BODY");

  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bodyStream,
      ContentType: contentType,
    })
  );

  const url = `${publicBase.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
  return { url, key };
}

function makeR2Key({ mode, generationId, ext }) {
  const safeExt = (ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || (mode === "video" ? "mp4" : "png");
  return `mma/${mode}/${generationId}.${safeExt}`;
}

function guessExtFromUrl(url, mode) {
  try {
    const u = new URL(url);
    const pathname = u.pathname || "";
    const m = pathname.match(/\.([a-z0-9]+)$/i);
    if (m && m[1]) return m[1].toLowerCase();
  } catch (_) {}
  return mode === "video" ? "mp4" : "png";
}

// -----------------------------
// MEGA writes
// -----------------------------

async function writeGeneration({ supabase, generationId, passId, vars, mode, parentGenerationId = null }) {
  const identifiers = generationIdentifiers(generationId);
  const payload = {
    ...identifiers,

    mg_parent_id: parentGenerationId ? `generation:${parentGenerationId}` : null,
    mg_pass_id: passId,

    mg_record_type: "generation",
    mg_status: "queued",
    mg_mma_status: "queued",
    mg_mma_mode: mode,
    mg_mma_vars: vars,

    mg_prompt: null,
    mg_output_url: null,
    mg_output_key: null,
    mg_provider: null,
    mg_model: null,

    mg_error: null,

    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
    mg_event_at: nowIso(),

    mg_source_system: "app",
  };

  await supabase.from("mega_generations").insert(payload);
}

async function writeStep({ supabase, generationId, stepNo, stepType, payload }) {
  const identifiers = stepIdentifiers(generationId, stepNo);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: `generation:${generationId}`,
    mg_step_type: stepType,
    mg_payload: payload,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
    mg_event_at: nowIso(),
    mg_source_system: "app",
  });
}

async function finalizeGeneration({ supabase, generationId, url, key, prompt, provider, model, vars }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: "done",
      mg_mma_status: "done",
      mg_output_url: url || null,
      mg_output_key: key || null,
      mg_prompt: prompt || null,
      mg_provider: provider || null,
      mg_model: model || null,
      mg_mma_vars: vars || null,
      mg_updated_at: nowIso(),
      mg_event_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateVars({ supabase, generationId, vars }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_mma_vars: vars,
      mg_updated_at: nowIso(),
      mg_event_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateStatus({ supabase, generationId, status }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: status,
      mg_mma_status: status,
      mg_updated_at: nowIso(),
      mg_event_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function setGenerationError({ supabase, generationId, code, message, extra = {} }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: "error",
      mg_mma_status: "error",
      mg_error: { code, message, ...extra },
      mg_updated_at: nowIso(),
      mg_event_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function writeEvent({ supabase, eventType, generationId, passId, payload }) {
  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: generationId || null,
    mg_pass_id: passId,
    mg_parent_id: generationId ? `generation:${generationId}` : null,
    mg_meta: { event_type: eventType, payload },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
    mg_event_at: nowIso(),
    mg_source_system: "app",
  });
  return eventId;
}

// -----------------------------
// Credits (safe-ish CAS, no double-decrement)
// -----------------------------

async function chargeCreditsOrThrow({ supabase, passId, cost, generationId, mode }) {
  if (cost <= 0) return { charged: 0, balance: null };

  // CAS retry (prevents most races)
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: cust, error: selErr } = await supabase
      .from("mega_customers")
      .select("mg_pass_id, mg_credits")
      .eq("mg_pass_id", passId)
      .maybeSingle();
    if (selErr) throw selErr;

    const current = Number(cust?.mg_credits || 0);
    if (current < cost) {
      const e = new Error("INSUFFICIENT_CREDITS");
      e.statusCode = 402;
      e.details = { current, needed: cost };
      throw e;
    }

    const next = Math.max(0, Math.floor(current - cost));

    const { data: updated, error: upErr } = await supabase
      .from("mega_customers")
      .update({ mg_credits: next, mg_updated_at: nowIso(), mg_last_active: nowIso() })
      .eq("mg_pass_id", passId)
      .eq("mg_credits", current) // CAS condition
      .select("mg_credits")
      .maybeSingle();

    if (upErr) throw upErr;
    if (updated) {
      // also log a credit transaction event (event stream) WITHOUT updating balance again
      await supabase.from("mega_generations").insert({
        mg_id: `credit_transaction:${crypto.randomUUID()}`,
        mg_record_type: "credit_transaction",
        mg_pass_id: passId,
        mg_delta: -Math.abs(cost),
        mg_reason: `mma_${mode}`,
        mg_source: "mma",
        mg_ref_type: "generation",
        mg_ref_id: generationId,
        mg_created_at: nowIso(),
        mg_updated_at: nowIso(),
        mg_event_at: nowIso(),
        mg_meta: { mode, generation_id: generationId },
        mg_source_system: "app",
      });

      return { charged: cost, balance: next };
    }

    // CAS failed => retry
    await new Promise((r) => setTimeout(r, 30 + attempt * 50));
  }

  throw new Error("CREDITS_CHARGE_RETRY_FAILED");
}

// -----------------------------
// OpenAI prompt builder
// -----------------------------

async function openAiMakePrompts({ mode, vars, preferences }) {
  const apiKey = envStr("OPENAI_API_KEY", "");
  if (!apiKey) {
    // fallback: if user already provided prompts, keep them
    return {
      clean_prompt: vars?.prompts?.clean_prompt || "Mina prompt",
      motion_prompt: vars?.prompts?.motion_prompt || "Mina motion prompt",
      negative_prompt: vars?.prompts?.negative_prompt || "",
    };
  }

  const model = getOpenAiModel();

  const system = [
    "You are Mina Mind prompt engine.",
    "Return STRICT JSON only (no markdown).",
    "Goal: produce a high-quality generation prompt for the requested mode.",
    "Keep it concise, vivid, and production-ready.",
    "If user provided constraints/settings, respect them.",
  ].join(" ");

  const userPayload = {
    mode,
    inputs: vars?.inputs || {},
    assets: vars?.assets || {},
    settings: vars?.settings || {},
    history: vars?.history || {},
    feedback: vars?.feedback || {},
    preferences: preferences || {},
    existing_prompts: vars?.prompts || {},
  };

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        "Build prompts. JSON keys: clean_prompt, motion_prompt, negative_prompt. " +
        "clean_prompt required for still. motion_prompt required for video. " +
        "If a field not relevant, return empty string.\n\n" +
        JSON.stringify(userPayload),
    },
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OPENAI_FAILED:${resp.status}:${txt.slice(0, 200)}`);
  }

  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content || "{}";

  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("OPENAI_BAD_JSON");
  }

  return {
    clean_prompt: String(parsed.clean_prompt || ""),
    motion_prompt: String(parsed.motion_prompt || ""),
    negative_prompt: String(parsed.negative_prompt || ""),
  };
}

// -----------------------------
// Replicate helpers
// -----------------------------

async function replicateCreatePrediction({ version, input }) {
  const token = requireEnv("REPLICATE_API_TOKEN");
  const resp = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version, // can be "owner/model:versionhash" too, replicate accepts
      input,
    }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`REPLICATE_CREATE_FAILED:${resp.status}:${JSON.stringify(body).slice(0, 200)}`);
  }

  return body;
}

async function replicateGetPrediction(id) {
  const token = requireEnv("REPLICATE_API_TOKEN");
  const resp = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${token}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`REPLICATE_GET_FAILED:${resp.status}:${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function replicateWait({ predictionId, timeoutMs }) {
  const started = Date.now();
  let sleepMs = 1500;

  while (true) {
    const p = await replicateGetPrediction(predictionId);
    const status = String(p?.status || "");
    if (status === "succeeded") return p;
    if (status === "failed" || status === "canceled") {
      const errMsg = p?.error ? String(p.error) : "replicate_failed";
      const e = new Error(errMsg);
      e.code = "REPLICATE_FAILED";
      throw e;
    }

    if (Date.now() - started > timeoutMs) {
      const e = new Error("REPLICATE_TIMEOUT");
      e.code = "REPLICATE_TIMEOUT";
      throw e;
    }

    await new Promise((r) => setTimeout(r, sleepMs));
    sleepMs = Math.min(5000, Math.floor(sleepMs * 1.2));
  }
}

// -----------------------------
// Identity / customer preferences
// -----------------------------

function resolveIds({ req, body }) {
  const b = body || {};

  // prefer your trusted pass id header if present (same idea as your /me header flow)
  const headerPass = req?.headers?.["x-mina-pass-id"] || req?.headers?.["X-Mina-Pass-Id"];
  const passFromHeader = isNonEmpty(headerPass) ? String(headerPass).trim() : "";

  const shopifyCustomerId = b.customer_id || b.customerId || null;
  const userId = b.user_id || b.userId || null;
  const email = b.email || null;

  const passId = passFromHeader
    ? String(passFromHeader)
    : computePassId({ shopifyCustomerId, userId, email });

  return { passId, shopifyCustomerId, userId, email };
}

async function loadPreferences({ supabase, passId }) {
  const { data, error } = await supabase
    .from("mega_customers")
    .select("mg_mma_preferences")
    .eq("mg_pass_id", passId)
    .maybeSingle();
  if (error) throw error;
  return data?.mg_mma_preferences || {};
}

// -----------------------------
// Production pipeline
// -----------------------------

async function runProductionPipeline({ supabase, generationId, passId, vars, mode }) {
  let working = vars;

  try {
    // scanning
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");
    working = appendScanLine(working, "Scanning inputs...");
    await updateVars({ supabase, generationId, vars: working });
    const lastLine = working?.userMessages?.scan_lines?.[working.userMessages.scan_lines.length - 1];
    if (lastLine) sendScanLine(generationId, lastLine);

    // preferences
    const prefs = await loadPreferences({ supabase, passId });

    // prompting
    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");
    working = appendScanLine(working, "Writing prompt...");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines[working.userMessages.scan_lines.length - 1]);

    const t0 = Date.now();
    const prompts = await openAiMakePrompts({ mode, vars: working, preferences: prefs });
    working.prompts = { ...(working.prompts || {}), ...prompts };

    await writeStep({
      supabase,
      generationId,
      stepNo: 1,
      stepType: mode === "video" ? "gpt_reader_motion" : "gpt_reader",
      payload: {
        input: { mode },
        output: { prompts },
        timing: {
          started_at: new Date(t0).toISOString(),
          ended_at: nowIso(),
          duration_ms: Math.max(0, Date.now() - t0),
        },
        error: null,
      },
    });

    await updateVars({ supabase, generationId, vars: working });

    // generating
    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");
    working = appendScanLine(working, "Generating with provider...");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines[working.userMessages.scan_lines.length - 1]);

    const models = getReplicateModels();
    const timeoutMs = getProviderTimeoutMs(mode);

    const prompt = mode === "video" ? (working.prompts.motion_prompt || working.prompts.clean_prompt) : working.prompts.clean_prompt;
    if (!prompt) throw new Error("EMPTY_PROMPT");

    const aspectRatio = working?.settings?.aspect_ratio || working?.settings?.aspectRatio || "1:1";
    const duration = Number(working?.settings?.duration_sec || working?.settings?.durationSec || 5);

    // Optional init image for video, if provided
    const initImageUrl =
      working?.assets?.image_url ||
      working?.assets?.imageUrl ||
      working?.assets?.init_image_url ||
      working?.assets?.initImageUrl ||
      "";

    let version = "";
    let stepType = "";
    let providerInput = {};

    if (mode === "video") {
      version = models.kling;
      stepType = "kling_generate";
      if (!version) throw new Error("MISSING_KLING_VERSION");

      providerInput = {
        prompt,
        // common params (adjust to your kling model spec if needed)
        aspect_ratio: aspectRatio,
        duration: Math.max(1, Math.min(10, duration)),
        ...(initImageUrl ? { image: initImageUrl } : {}),
      };
    } else {
      version = models.seadream;
      stepType = "seedream_generate";
      if (!version) throw new Error("MISSING_SEADREAM_VERSION");

      providerInput = {
        prompt,
        aspect_ratio: aspectRatio,
      };
    }

    const providerStarted = Date.now();
    const pred = await replicateCreatePrediction({ version, input: providerInput });
    const predId = String(pred?.id || "");
    if (!predId) throw new Error("REPLICATE_NO_ID");

    // Save the prediction ID early (useful for debugging/retry)
    working.outputs = { ...(working.outputs || {}), replicate_prediction_id: predId };

    const done = await replicateWait({ predictionId: predId, timeoutMs });

    const rawUrl = pickFirstUrl(done?.output);
    if (!rawUrl) throw new Error("PROVIDER_EMPTY_OUTPUT");

    // Store to R2 (or fallback to rawUrl if R2 not configured)
    const ext = guessExtFromUrl(rawUrl, mode);
    const key = makeR2Key({ mode, generationId, ext });
    const stored = await storeRemoteToR2Public(rawUrl, key);

    const finalUrl = stored.url;
    const finalKey = stored.key;

    // Step write
    await writeStep({
      supabase,
      generationId,
      stepNo: 2,
      stepType,
      payload: {
        input: providerInput,
        output: {
          prediction_id: predId,
          remote_url: rawUrl,
          stored_url: finalUrl,
          stored_key: finalKey,
          status: done?.status,
        },
        timing: {
          started_at: new Date(providerStarted).toISOString(),
          ended_at: nowIso(),
          duration_ms: Math.max(0, Date.now() - providerStarted),
        },
        error: null,
      },
    });

    // postscan / finalize
    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");
    working.outputs = { ...(working.outputs || {}) };

    if (mode === "video") {
      working.outputs.kling_video_url = finalUrl;
      working.outputs.kling_video_id = predId;
    } else {
      working.outputs.seedream_image_url = finalUrl;
      working.outputs.seedream_image_id = predId;
    }

    working.mg_output_url = finalUrl;
    working.userMessages = { ...(working.userMessages || {}), final_line: "Finished generation" };

    await updateVars({ supabase, generationId, vars: working });

    await finalizeGeneration({
      supabase,
      generationId,
      url: finalUrl,
      key: finalKey,
      prompt,
      provider: "replicate",
      model: version,
      vars: working,
    });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] pipeline error", err);
    await setGenerationError({
      supabase,
      generationId,
      code: err?.code || "PIPELINE_ERROR",
      message: err?.message || "",
    });
    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// -----------------------------
// Public handlers
// -----------------------------

export async function handleMmaCreate({ mode, body, req = null }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const generationId = newUuid();
  const parentGenerationId = body?.parent_generation_id || body?.generation_id || null;

  const ids = resolveIds({ req, body });

  // production guard: require at least one stable identifier
  if (!isNonEmpty(ids.passId) || (!isNonEmpty(ids.shopifyCustomerId) && !isNonEmpty(ids.userId) && !isNonEmpty(ids.email) && !isNonEmpty(req?.headers?.["x-mina-pass-id"]))) {
    const e = new Error("MISSING_IDENTITY");
    e.statusCode = 400;
    throw e;
  }

  // Ensure customer row via your real helper (Part 1)
  const ensured = await megaEnsureCustomer(supabase, {
    customerId: ids.shopifyCustomerId || ids.passId,
    userId: ids.userId || null,
    email: ids.email || null,
    profile: {},
    passId: ids.passId || null,
  });

  const passId = ensured.passId;

  // credits
  const cost = getMmaCosts(mode);
  await chargeCreditsOrThrow({ supabase, passId, cost, generationId, mode });

  // vars
  const vars = makeInitialVars({
    mode,
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  await writeGeneration({ supabase, generationId, passId, vars, mode, parentGenerationId });

  // fire & forget production pipeline
  runProductionPipeline({ supabase, generationId, passId, vars, mode }).catch((err) => {
    console.error("[mma] pipeline top-level error", err);
  });

  return {
    generation_id: generationId,
    parent_generation_id: parentGenerationId || null,
    status: "queued",
    sse_url: `/mma/stream/${generationId}`,
    credits_cost: cost,
  };
}

export async function handleMmaEvent(body, req = null) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const ids = resolveIds({ req, body });

  // Ensure customer row (so prefs exist)
  const ensured = await megaEnsureCustomer(supabase, {
    customerId: ids.shopifyCustomerId || ids.passId,
    userId: ids.userId || null,
    email: ids.email || null,
    profile: {},
    passId: ids.passId || null,
  });

  const passId = ensured.passId;

  const eventId = await writeEvent({
    supabase,
    eventType: body?.event_type || "unknown",
    generationId: body?.generation_id || null,
    passId,
    payload: body?.payload || {},
  });

  // preference updates
  if (body?.event_type === "like" || body?.event_type === "dislike" || body?.event_type === "preference_set") {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences || {};
    const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
    const tagWeights = { ...(prefs.tag_weights || {}) };

    if (body?.payload?.hard_block) {
      hardBlocks.add(body.payload.hard_block);
      tagWeights[body.payload.hard_block] = -999;
    }

    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: { ...prefs, hard_blocks: Array.from(hardBlocks), tag_weights: tagWeights },
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  }

  return { event_id: eventId, status: "ok" };
}

// -----------------------------
// Read APIs
// -----------------------------

export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error, mg_mma_mode")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: data.mg_mma_status || data.mg_status,
    mode: data.mg_mma_mode || (data.mg_mma_vars?.mode ?? null),
    mma_vars: data.mg_mma_vars || {},
    outputs: {
      seedream_image_url: data.mg_output_url,
      kling_video_url: data.mg_output_url,
    },
    prompt: data.mg_prompt || null,
    error: data.mg_error || null,
  };
}

export async function listSteps(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "mma_step")
    .order("mg_step_no", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function listErrors() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_admin")
    .select("*")
    .eq("mg_record_type", "error")
    .order("mg_created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

// -----------------------------
// SSE registration
// -----------------------------

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}
