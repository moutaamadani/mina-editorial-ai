// src/routes/mma/mma-controller.js
import OpenAI from "openai";
import Replicate from "replicate";
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
import { getMmaConfig } from "./mma-config.js";

// ---------------------------
// Clients (cached singletons)
// ---------------------------
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

// ---------------------------
// R2 Public store (self-contained)
// ---------------------------
function getR2() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const publicBase = process.env.R2_PUBLIC_BASE_URL || "";

  const enabled = !!(endpoint && accessKeyId && secretAccessKey && bucket && publicBase);
  const client = enabled
    ? new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      })
    : null;

  return { enabled, client, bucket, publicBase };
}

function guessExt(url, fallback = ".bin") {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return ".jpg";
    if (p.endsWith(".webp")) return ".webp";
    if (p.endsWith(".gif")) return ".gif";
    if (p.endsWith(".mp4")) return ".mp4";
    if (p.endsWith(".webm")) return ".webm";
    if (p.endsWith(".mov")) return ".mov";
    return fallback;
  } catch {
    return fallback;
  }
}

async function storeRemoteToR2Public(url, keyPrefix) {
  const { enabled, client, bucket, publicBase } = getR2();
  if (!enabled || !client) return url;
  if (!url || typeof url !== "string") return url;

  // already public/stable
  if (publicBase && url.startsWith(publicBase)) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`R2_FETCH_FAILED_${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(url, contentType.includes("video") ? ".mp4" : ".png");
  const objKey = `${keyPrefix}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objKey,
      Body: buf,
      ContentType: contentType,
    })
  );

  return `${publicBase.replace(/\/$/, "")}/${objKey}`;
}

// ---------------------------
// DB helpers
// ---------------------------
async function ensureCustomerRow(supabase, passId, { shopifyCustomerId, userId, email }) {
  const { data } = await supabase
    .from("mega_customers")
    .select("mg_pass_id, mg_mma_preferences")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  const prefs = data?.mg_mma_preferences || {};

  if (!data) {
    await supabase.from("mega_customers").insert({
      mg_pass_id: passId,
      mg_shopify_customer_id: shopifyCustomerId || null,
      mg_user_id: userId || null,
      mg_email: email || null,
      mg_credits: 0,
      mg_mma_preferences: prefs,
      mg_created_at: nowIso(),
      mg_updated_at: nowIso(),
    });
  }

  return { preferences: prefs };
}

async function writeGeneration({ supabase, generationId, parentId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: parentId ? `generation:${parentId}` : null,
    mg_pass_id: passId,
    mg_status: "queued",
    mg_mma_status: "queued",
    mg_mma_mode: mode,
    mg_mma_vars: vars,
    mg_prompt: null,
    mg_output_url: null,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
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
  });
}

async function finalizeGeneration({ supabase, generationId, url, prompt }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: "done",
      mg_mma_status: "done",
      mg_output_url: url,
      mg_prompt: prompt,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateVars({ supabase, generationId, vars }) {
  await supabase
    .from("mega_generations")
    .update({ mg_mma_vars: vars, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateStatus({ supabase, generationId, status }) {
  await supabase
    .from("mega_generations")
    .update({ mg_status: status, mg_mma_status: status, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

// ---------------------------
// Production pipeline
// ---------------------------
function pickFirstUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return pickFirstUrl(output[0]);
  if (typeof output === "object") {
    if (typeof output.url === "string") return output.url;
    if (typeof output.output === "string") return output.output;
  }
  return "";
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = assets.product_image_url || assets.productImageUrl || "";
  const logo = assets.logo_image_url || assets.logoImageUrl || "";
  const inspiration = safeArray(
    assets.inspiration_image_urls || assets.inspirationImageUrls || assets.style_image_urls || assets.styleImageUrls
  );

  return []
    .concat(typeof product === "string" ? [product] : [])
    .concat(inspiration)
    .concat(typeof logo === "string" ? [logo] : [])
    .filter((u) => typeof u === "string" && u.startsWith("http"))
    .slice(0, 10);
}

function pickKlingImages(vars) {
  const assets = vars?.assets || {};
  const arr = safeArray(assets.kling_image_urls || assets.klingImages || assets.kling_images);

  const clean = (url) => (typeof url === "string" && url.startsWith("http") ? url : "");

  const start =
    clean(assets.start_image_url || assets.startImageUrl) ||
    clean(arr[0]) ||
    clean(assets.product_image_url || assets.productImageUrl);

  const end = clean(assets.end_image_url || assets.endImageUrl) || clean(arr[1]);

  return { start: start || "", end: end || "" };
}

async function runSeedream({
  prompt,
  aspectRatio,
  imageInputs = [],
  size,
  enhancePrompt,
  input: forcedInput,
}) {
  const replicate = getReplicate();

  const sizeValue = size || process.env.MMA_SEADREAM_SIZE || "2K";
  const enhancePromptRaw = process.env.MMA_SEADREAM_ENHANCE_PROMPT;
  const enhance_prompt =
    enhancePrompt !== undefined
      ? enhancePrompt
      : enhancePromptRaw === undefined
        ? true
        : String(enhancePromptRaw).toLowerCase() === "true";

  const defaultAspect = process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";
  const version =
    process.env.MMA_SEADREAM_VERSION || process.env.MMA_SEADREAM_MODEL_VERSION || "bytedance/seedream-4";

  const neg =
    process.env.NEGATIVE_PROMPT_SEADREAM ||
    process.env.MMA_NEGATIVE_PROMPT_SEADREAM ||
    "";

  const finalPrompt = neg ? `${prompt}\n\nAvoid: ${neg}` : prompt;

  const cleanedInputs = Array.isArray(imageInputs)
    ? imageInputs.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 10)
    : [];

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || finalPrompt }
    : {
        prompt: finalPrompt,
        size: sizeValue,
        aspect_ratio: aspectRatio || defaultAspect,
        enhance_prompt,
        sequential_image_generation: "disabled",
        max_images: 1,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.size) input.size = sizeValue;
  if (input.enhance_prompt === undefined) input.enhance_prompt = enhance_prompt;
  if (!input.sequential_image_generation) input.sequential_image_generation = "disabled";
  if (!input.max_images) input.max_images = 1;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
  };
}

async function runKling({ prompt, startImage, endImage, mode, duration, negativePrompt, input: forcedInput }) {
  const replicate = getReplicate();

  const defaultDuration = Number(duration ?? process.env.MMA_KLING_DURATION ?? 5);
  const version = process.env.MMA_KLING_VERSION || process.env.MMA_KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    "";

  const finalPrompt = forcedInput?.prompt || prompt;
  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;
  const providedEnd = forcedInput?.end_image || endImage;

  const input = forcedInput
    ? { ...forcedInput }
    : {
        mode: providedEnd ? "pro" : mode || process.env.MMA_KLING_MODE || "standard",
        prompt: finalPrompt,
        duration: defaultDuration,
        start_image: startImage,
        ...(providedEnd ? { end_image: providedEnd } : {}),
      };

  if (finalNeg && !input.negative_prompt) input.negative_prompt = finalNeg;
  if (!input.prompt) input.prompt = finalPrompt;
  input.duration = Number(input.duration ?? defaultDuration) || defaultDuration;
  if (!input.mode) input.mode = providedEnd ? "pro" : mode || process.env.MMA_KLING_MODE || "standard";
  if (!input.start_image && startImage) input.start_image = startImage;
  if (!input.end_image && providedEnd) input.end_image = providedEnd;

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    usedEnd: !!input.end_image,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
  };
}

async function gptMakePrompts({ mode, vars, preferences }) {
  const cfg = getMmaConfig();
  const openai = getOpenAI();

  const brief =
    vars?.inputs?.brief ||
    vars?.inputs?.prompt ||
    vars?.inputs?.motionDescription ||
    vars?.inputs?.motion_description ||
    "";

  const platform = vars?.inputs?.platform || vars?.settings?.platform || "default";
  const aspectRatio = vars?.inputs?.aspect_ratio || vars?.settings?.aspectRatio || vars?.settings?.aspect_ratio || "";

  const negSeedream = cfg.seadream.negativePrompt ? `Avoid (global): ${cfg.seadream.negativePrompt}` : "";
  const negKling = cfg.kling.negativePrompt ? `Negative prompt (global): ${cfg.kling.negativePrompt}` : "";

  const sys = [
    "You are Mina Mind — a production prompt engine.",
    "Output STRICT JSON only, no markdown.",
    "Schema: { clean_prompt: string, motion_prompt: string }",
    "clean_prompt is for Seedream (still image).",
    "motion_prompt is for Kling (image-to-video).",
    "Be concise, specific, photoreal, high-end editorial.",
    negSeedream,
    negKling,
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `MODE: ${mode}`,
    `PLATFORM: ${platform}`,
    aspectRatio ? `ASPECT_RATIO: ${aspectRatio}` : "",
    preferences ? `USER_PREFERENCES_JSON: ${JSON.stringify(preferences).slice(0, 4000)}` : "",
    `BRIEF: ${String(brief).slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const model = cfg.gptModel;
  const temperature = 0.4;

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature,
  });

  const text = resp?.choices?.[0]?.message?.content || "";

  let clean_prompt = "";
  let motion_prompt = "";

  try {
    const parsed = JSON.parse(text);
    clean_prompt = typeof parsed.clean_prompt === "string" ? parsed.clean_prompt : "";
    motion_prompt = typeof parsed.motion_prompt === "string" ? parsed.motion_prompt : "";
  } catch {
    clean_prompt = mode === "still" ? text : "";
    motion_prompt = mode === "video" ? text : "";
  }

  return {
    clean_prompt,
    motion_prompt,
    raw: text,
    debug: {
      model,
      temperature,
      system: sys,
      user,
    },
  };
}

async function runProductionPipeline({ supabase, generationId, vars, mode, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  try {
    // 1) scanning
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    working = appendScanLine(working, "Scanning inputs…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Scanning inputs…");

    // 2) prompting (GPT)
    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const t0 = Date.now();
    const prompts = await gptMakePrompts({ mode, vars: working, preferences });

    await writeStep({
      supabase,
      generationId,
      stepNo: 1,
      stepType: mode === "video" ? "gpt_reader_motion" : "gpt_reader",
      payload: {
        request: prompts.request, // ✅ system + user (context) + model
        input: {
          brief: working?.inputs?.brief || working?.inputs?.motionDescription || "",
          preferences,
          gpt: prompts?.debug || null, // ✅ system + user + model + temp
        },
        output: {
          clean_prompt: prompts.clean_prompt,
          motion_prompt: prompts.motion_prompt,
          raw: prompts.raw, // ✅ raw model response
        },
        mma_config: getMmaConfig(), // ✅ config snapshot
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    working.prompts = {
      ...(working.prompts || {}),
      clean_prompt: prompts.clean_prompt || working?.prompts?.clean_prompt || "",
      motion_prompt: prompts.motion_prompt || working?.prompts?.motion_prompt || "",
    };

    working = appendScanLine(working, "Prompts ready.");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Prompts ready.");

    // 3) generating (Replicate)
    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    let remoteUrl = "";
    let usedPrompt = "";

    if (mode === "still") {
      usedPrompt = working.prompts.clean_prompt || "";
      if (!usedPrompt) throw new Error("EMPTY_PROMPT");

      const imageInputs = buildSeedreamImageInputs(working);
      const aspect_ratio =
        working?.inputs?.aspect_ratio ||
        cfg.seadream.aspectRatio ||
        process.env.MMA_SEADREAM_ASPECT_RATIO ||
        "match_input_image";

      const { input, out, timing } = await runSeedream({
        prompt: usedPrompt,
        aspectRatio: aspect_ratio,
        imageInputs,
        size: cfg.seadream.size,
        enhancePrompt: cfg.seadream.enhancePrompt,
      });
      const url = pickFirstUrl(out);
      if (!url) throw new Error("SEADREAM_NO_URL");

      await writeStep({
        supabase,
        generationId,
        stepNo: 2,
        stepType: "seedream_generate",
        payload: {
          input,
          output: out,
          timing,
          error: null,
        },
      });

      // store to R2 public
      remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
      working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    } else {
      usedPrompt = working.prompts.motion_prompt || "";
      if (!usedPrompt) throw new Error("EMPTY_PROMPT");

      const { start, end } = pickKlingImages(working);
      if (!start) throw new Error("Kling requires a start image (start_image_url).");

      // end_image => force pro mode (required by schema)
      const klingMode = end ? "pro" : cfg.kling.mode;

      // include duration (schema default is 5, but settable)
      const duration = Number(cfg.kling.duration || process.env.MMA_KLING_DURATION || 5);

      const input = {
        mode: klingMode, // "standard" | "pro"
        prompt: usedPrompt, // required
        duration, // ✅ required in practice
        start_image: start, // ✅ required for kling-v2.1
        ...(end ? { end_image: end } : {}),
        ...(cfg.kling.negativePrompt ? { negative_prompt: cfg.kling.negativePrompt } : {}),
      };

      const { input: klingInput, out, usedEnd, timing } = await runKling({
        input,
        prompt: usedPrompt,
        startImage: start,
        endImage: end || null,
        mode: klingMode,
        duration,
        negativePrompt: cfg.kling.negativePrompt,
      });
      const url = pickFirstUrl(out);
      if (!url) throw new Error("KLING_NO_URL");

      await writeStep({
        supabase,
        generationId,
        stepNo: 2,
        stepType: "kling_generate",
        payload: {
          input: { ...klingInput, used_end: usedEnd },
          output: out,
          timing,
          error: null,
        },
      });

      remoteUrl = await storeRemoteToR2Public(url, `mma/video/${generationId}`);
      working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    }

    // 4) postscan + finalize
    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");

    working.mg_output_url = remoteUrl;
    working.userMessages = {
      ...(working.userMessages || {}),
      final_line: "Finished generation.",
    };

    working = appendScanLine(working, "Stored output to permanent URL.");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines?.slice(-1)?.[0] || "Stored output.");

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ---------------------------
// Public controller API
// ---------------------------
export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  // Allow frontend to pass passId directly (your MinaApp already has it)
  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentId = body?.generation_id || body?.parent_generation_id || null;
  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode,
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  runProductionPipeline({ supabase, generationId, vars, mode, preferences }).catch((err) => {
    console.error("[mma] pipeline error", err);
  });

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaEvent(body) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: body?.generation_id || null,
    mg_pass_id: passId,
    mg_parent_id: body?.generation_id ? `generation:${body.generation_id}` : null,
    mg_meta: { event_type: body?.event_type || "unknown", payload: body?.payload || {} },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });

  // Keep your existing preference-write logic (unchanged)
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

export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: data.mg_mma_status || data.mg_status,
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

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}



// --- MMA controller factory (compat with server.js loader) ---
export function createMmaController() {
  return {
    handleMmaCreate,
    handleMmaEvent,
    fetchGeneration,
    listErrors,
    listSteps,
    registerSseClient,
  };
}

export default createMmaController;

