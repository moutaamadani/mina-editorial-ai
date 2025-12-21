import crypto from "node:crypto";
import EventEmitter from "node:events";
import OpenAI from "openai";
import Replicate from "replicate";
import { getActiveAppConfig } from "../app-config.js";
import {
  megaEnsureCustomer,
  megaWriteCreditTxnEvent,
} from "../../mega-db.js";
import { storeRemoteImageToR2 } from "../../r2.js";

function nowIso() {
  return new Date().toISOString();
}

function withTiming(fn) {
  return async (...args) => {
    const started = Date.now();
    try {
      const output = await fn(...args);
      return {
        output,
        timing: {
          started_at: new Date(started).toISOString(),
          ended_at: nowIso(),
          duration_ms: Date.now() - started,
        },
        error: null,
      };
    } catch (err) {
      return {
        output: null,
        timing: {
          started_at: new Date(started).toISOString(),
          ended_at: nowIso(),
          duration_ms: Date.now() - started,
        },
        error: {
          message: err?.message || "UNKNOWN_ERROR",
          stack: err?.stack,
        },
      };
    }
  };
}

class SseHub {
  constructor() {
    this.emitter = new EventEmitter();
    this.listeners = new Map();
  }

  subscribe(generationId, listener) {
    const list = this.listeners.get(generationId) || new Set();
    list.add(listener);
    this.listeners.set(generationId, list);

    return () => {
      list.delete(listener);
      if (list.size === 0) this.listeners.delete(generationId);
    };
  }

  send(generationId, event, data) {
    const list = this.listeners.get(generationId);
    if (!list || list.size === 0) return;
    for (const listener of list) {
      try {
        listener({ event, data });
      } catch (err) {
        console.error("[SSE] listener error", err);
      }
    }
  }
}

async function insertGenerationRow(supabaseAdmin, generationId, passId, mode, mmaVars) {
  if (!supabaseAdmin) return;
  const payload = {
    mg_id: `generation:${generationId}`,
    mg_record_type: "generation",
    mg_pass_id: passId,
    mg_generation_id: generationId,
    mg_type: mode === "video" ? "motion" : "image",
    mg_mma_mode: mode,
    mg_mma_status: "queued",
    mg_status: "pending",
    mg_mma_vars: mmaVars,
    mg_prompt: null,
    mg_output_url: null,
    mg_meta: {},
    mg_payload: {},
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  };
  await supabaseAdmin.from("mega_generations").upsert(payload, { onConflict: "mg_id" });
}

async function updateGenerationStatus(supabaseAdmin, generationId, status, mmaVars = null, fields = {}) {
  if (!supabaseAdmin) return;
  const updates = {
    mg_mma_status: status,
    mg_status: status === "done" ? "succeeded" : status === "error" ? "failed" : "processing",
    mg_updated_at: nowIso(),
    ...fields,
  };
  if (mmaVars) updates.mg_mma_vars = mmaVars;
  await supabaseAdmin
    .from("mega_generations")
    .update(updates)
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function insertStepRow(
  supabaseAdmin,
  generationId,
  stepNo,
  stepType,
  payload,
  { mode, provider = null, model = null, latencyMs = null, status = null } = {}
) {
  if (!supabaseAdmin) return;
  const row = {
    mg_id: `mma_step:${generationId}:${stepNo}`,
    mg_record_type: "mma_step",
    mg_generation_id: generationId,
    mg_step_no: stepNo,
    mg_step_type: stepType,
    mg_payload: payload,
    mg_provider: provider,
    mg_model: model,
    mg_latency_ms: latencyMs,
    mg_mma_mode: mode,
    mg_mma_status: status,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  };
  await supabaseAdmin.from("mega_generations").insert(row);
}

async function insertMmaErrorRow(supabaseAdmin, { generationId, passId = null, stepType = null, provider = null, ctxVersions = {}, settingsVersions = {}, payloadError = null, message = null }) {
  if (!supabaseAdmin) return;
  const detail = {
    generation_id: generationId,
    step_type: stepType,
    provider,
    ctx_versions: ctxVersions || {},
    settings_versions: settingsVersions || {},
    error: payloadError || null,
    message: message || payloadError?.message || null,
  };

  const row = {
    mg_id: `error:${crypto.randomUUID()}`,
    mg_record_type: "error",
    mg_actor_pass_id: passId,
    mg_route: "mma",
    mg_method: stepType || null,
    mg_status: 500,
    mg_detail: detail,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  };

  await supabaseAdmin.from("mega_admin").insert(row);
}

async function recordMmaStep({
  supabaseAdmin,
  generationId,
  stepNo,
  stepType,
  payload,
  mode,
  provider = null,
  model = null,
  latencyMs = null,
  status = null,
}) {
  const effectiveStatus = payload?.error ? "error" : status;
  await insertStepRow(supabaseAdmin, generationId, stepNo, stepType, payload, {
    mode,
    provider,
    model,
    latencyMs,
    status: effectiveStatus,
  });

  if (payload?.error) {
    const err = new Error(payload.error.message || `${stepType}_failed`);
    err.stepType = stepType;
    err.stepNo = stepNo;
    err.payloadError = payload.error;
    err.provider = provider;
    throw err;
  }
}

async function ensureCredits(supabaseAdmin, customer, cost, reason) {
  if (!supabaseAdmin) return null;
  if (!cost || cost <= 0) return null;
  const balance = Number(customer.credits || 0);
  if (balance < cost) {
    throw new Error("INSUFFICIENT_CREDITS");
  }
  await megaWriteCreditTxnEvent(supabaseAdmin, {
    customerId: customer.shopifyCustomerId,
    userId: null,
    email: null,
    delta: -Math.abs(cost),
    reason,
    source: "mma",
    refType: "generation",
    refId: customer.passId,
  });
  return true;
}

async function refundCredits(supabaseAdmin, customer, cost, reason) {
  if (!supabaseAdmin) return;
  if (!cost || cost <= 0) return;
  try {
    await megaWriteCreditTxnEvent(supabaseAdmin, {
      customerId: customer.shopifyCustomerId,
      userId: null,
      email: null,
      delta: Math.abs(cost),
      reason,
      source: "mma_refund",
      refType: "generation",
      refId: customer.passId,
    });
  } catch (err) {
    console.error("[MMA] refund failed", err);
  }
}

async function runGptVisionStep({
  openai,
  config,
  imageUrls = [],
  prompt,
  stepType,
}) {
  const runner = withTiming(async () => {
    if (!openai) throw new Error("OPENAI_MISSING");
    const messages = [];
    if (config?.system) messages.push({ role: "system", content: config.system });
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt || config?.prompt || "Analyze the image." },
        ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    });

    const maxTokens = Number(
      config?.max_completion_tokens ?? config?.max_tokens ?? 500
    );
    const resp = await openai.chat.completions.create({
      model: config?.model || "gpt-5-mini",
      messages,
      max_completion_tokens: Number.isFinite(maxTokens) ? maxTokens : 500,
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || "";
    return { text, raw: resp };
  });

  const result = await runner();
  return {
    stepType,
    payload: {
      input: {
        ctx_key: config?.key || null,
        ctx_version: config?.version || null,
        ctx_id: config?.id || null,
        prompt: prompt || config?.prompt || null,
        image_urls: imageUrls,
      },
      output: { text: result.output?.text },
      timing: result.timing,
      error: result.error,
    },
    model: config?.model || "gpt-5-mini",
    latencyMs: result.timing?.duration_ms || null,
    rawResponse: result.output?.raw,
  };
}

async function runGptTextStep({ openai, config, inputText, stepType }) {
  const runner = withTiming(async () => {
    if (!openai) throw new Error("OPENAI_MISSING");
    const messages = [];
    if (config?.system) messages.push({ role: "system", content: config.system });
    messages.push({ role: "user", content: inputText || config?.prompt || "" });

    const maxTokens = Number(
      config?.max_completion_tokens ?? config?.max_tokens ?? 500
    );
    const resp = await openai.chat.completions.create({
      model: config?.model || "gpt-5-mini",
      messages,
      max_completion_tokens: Number.isFinite(maxTokens) ? maxTokens : 500,
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || "";
    return { text, raw: resp };
  });

  const result = await runner();
  return {
    stepType,
    payload: {
      input: {
        ctx_key: config?.key || null,
        ctx_version: config?.version || null,
        ctx_id: config?.id || null,
        input_text: inputText,
      },
      output: { text: result.output?.text },
      timing: result.timing,
      error: result.error,
    },
    model: config?.model || "gpt-5-mini",
    latencyMs: result.timing?.duration_ms || null,
    rawResponse: result.output?.raw,
  };
}

async function runSeedream({ replicate, prompt, settings }) {
  const resolved = settings?.resolved || settings || {};
  const model = settings?.model || resolved.model || process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
  const runner = withTiming(async () => {
    if (!replicate) throw new Error("REPLICATE_MISSING");
    const request = { ...resolved, prompt };
    const output = await replicate.run(model, {
      input: request,
    });
    const imageUrl = Array.isArray(output) ? output[0] : output?.output || output;
    return { request, response: output, imageUrl };
  });

  const result = await runner();
  return {
    provider: "seedream",
    model: settings?.model || settings?.resolved?.model || process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4",
    payload: {
      input: {
        prompt,
        settings_key: settings?.key || null,
        settings_version: settings?.version || null,
        settings_id: settings?.id || null,
        settings_resolved: resolved,
      },
      output: { output_url: result.output?.imageUrl, response: result.output?.response },
      timing: result.timing,
      error: result.error,
    },
    latencyMs: result.timing?.duration_ms || null,
    outputUrl: result.output?.imageUrl,
  };
}

async function runKling({ replicate, prompt, settings }) {
  const resolved = settings?.resolved || settings || {};
  const model = settings?.model || resolved.model || process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";
  const runner = withTiming(async () => {
    if (!replicate) throw new Error("REPLICATE_MISSING");
    const request = { ...resolved, prompt };
    const output = await replicate.run(model, {
      input: request,
    });
    const videoUrl = Array.isArray(output) ? output[0] : output?.output || output;
    return { request, response: output, videoUrl };
  });

  const result = await runner();
  return {
    provider: "kling",
    model: settings?.model || settings?.resolved?.model || process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1",
    payload: {
      input: {
        prompt,
        settings_key: settings?.key || null,
        settings_version: settings?.version || null,
        settings_id: settings?.id || null,
        settings_resolved: resolved,
      },
      output: { output_url: result.output?.videoUrl, response: result.output?.response },
      timing: result.timing,
      error: result.error,
    },
    latencyMs: result.timing?.duration_ms || null,
    outputUrl: result.output?.videoUrl,
  };
}

export class MmaController {
  constructor({ supabaseAdmin, openai = null, replicate = null, sseHub = null } = {}) {
    this.supabaseAdmin = supabaseAdmin;
    this.openai = openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.replicate = replicate || new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    this.sseHub = sseHub || new SseHub();
  }

  getHub() {
    return this.sseHub;
  }

  async loadConfigs() {
    const [gptReader, gptFeedbackStill, gptFeedbackMotion, gptMotion, motionSuggest, gptScan] = await Promise.all([
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.gpt_reader"),
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.gpt_feedback_still"),
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.gpt_feedback_motion"),
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.gpt_reader_motion"),
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.motion_suggestion"),
      getActiveAppConfig(this.supabaseAdmin, "mma.ctx.gpt_scanner"),
    ]);

    const [seedreamDefaults, klingDefaults] = await Promise.all([
      getActiveAppConfig(this.supabaseAdmin, "mma.provider.seedream.defaults"),
      getActiveAppConfig(this.supabaseAdmin, "mma.provider.kling.defaults"),
    ]);

    return {
      ctx: {
        gpt_reader: gptReader,
        gpt_feedback_still: gptFeedbackStill,
        gpt_feedback_motion: gptFeedbackMotion,
        gpt_reader_motion: gptMotion,
        motion_suggestion: motionSuggest,
        gpt_scanner: gptScan,
      },
      providers: {
        seedream: seedreamDefaults,
        kling: klingDefaults,
      },
    };
  }

  async runStillCreate({
    customerId,
    email,
    userId,
    assets = {},
    inputs = {},
    history = {},
    brief = "",
    settings = {},
    meta = {},
    feedback = {},
  }) {
    const generationId = `mma_${crypto.randomUUID()}`;
    const cust = await megaEnsureCustomer(this.supabaseAdmin, { customerId, email, userId });
    const passId = cust?.passId || null;
    const mmaVars = {
      assets,
      inputs,
      history,
      feedback,
      prompts: {},
      scans: {},
      outputs: {},
      settings: {},
      userMessages: { scan_lines: [] },
      meta: { ctx_versions: {}, settings_versions: {}, ...meta },
    };

    const combinedBrief = (brief || `${inputs.userBrief || ""}\n${inputs.style || ""}`).trim();

    await insertGenerationRow(this.supabaseAdmin, generationId, passId, "still", mmaVars);
    this.sseHub.send(generationId, "status", { status: "queued" });

    const configs = await this.loadConfigs();
    for (const [ctxKey, ctxConfig] of Object.entries(configs.ctx || {})) {
      if (ctxConfig?.version != null) mmaVars.meta.ctx_versions[ctxKey] = ctxConfig.version;
    }
    for (const [providerKey, providerConfig] of Object.entries(configs.providers || {})) {
      if (providerConfig?.version != null)
        mmaVars.meta.settings_versions[providerKey] = providerConfig.version;
    }

    let stepNo = 0;
    const scanLine = (line) => {
      mmaVars.userMessages.scan_lines.push(line);
      this.sseHub.send(generationId, "scan_line", { index: mmaVars.userMessages.scan_lines.length, text: line });
      updateGenerationStatus(this.supabaseAdmin, generationId, "scanning", mmaVars).catch(() => {});
    };

    try {
      if (assets.product_url) {
        scanLine("Scanning product image...");
        const scan = await runGptVisionStep({
          openai: this.openai,
          config: configs.ctx.gpt_scanner,
          imageUrls: [assets.product_url],
          prompt: "Describe the product for a photoshoot.",
          stepType: "scan_product",
        });
        mmaVars.scans.product_crt = scan.payload.output.text;
        await recordMmaStep({
          supabaseAdmin: this.supabaseAdmin,
          generationId,
          stepNo: stepNo++,
          stepType: "scan_product",
          payload: scan.payload,
          mode: "still",
          model: scan.model,
          latencyMs: scan.latencyMs,
        });
      }

      if (assets.logo_url) {
        scanLine("Scanning logo...");
        const scan = await runGptVisionStep({
          openai: this.openai,
          config: configs.ctx.gpt_scanner,
          imageUrls: [assets.logo_url],
          prompt: "Describe the logo and placement guidance.",
          stepType: "scan_logo",
        });
        mmaVars.scans.logo_crt = scan.payload.output.text;
        await recordMmaStep({
          supabaseAdmin: this.supabaseAdmin,
          generationId,
          stepNo: stepNo++,
          stepType: "scan_logo",
          payload: scan.payload,
          mode: "still",
          model: scan.model,
          latencyMs: scan.latencyMs,
        });
      }

      if (Array.isArray(assets.inspiration_urls) && assets.inspiration_urls.length) {
        scanLine("Scanning inspiration...");
        const inspScan = await runGptVisionStep({
          openai: this.openai,
          config: configs.ctx.gpt_scanner,
          imageUrls: assets.inspiration_urls,
          prompt: "Summarize the visual inspiration.",
          stepType: "scan_inspiration",
        });
        mmaVars.scans.inspiration_crt = inspScan.payload.output.text;
        await recordMmaStep({
          supabaseAdmin: this.supabaseAdmin,
          generationId,
          stepNo: stepNo++,
          stepType: "scan_inspiration",
          payload: inspScan.payload,
          mode: "still",
          model: inspScan.model,
          latencyMs: inspScan.latencyMs,
        });
      }

      this.sseHub.send(generationId, "status", { status: "prompting" });
      await updateGenerationStatus(this.supabaseAdmin, generationId, "prompting", mmaVars);

      const promptStep = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.gpt_reader,
        inputText: `${combinedBrief}\n${mmaVars.scans.product_crt || ""}`.trim(),
        stepType: "gpt_reader",
      });
      mmaVars.prompts.clean_prompt = promptStep.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_reader",
        payload: promptStep.payload,
        mode: "still",
        model: promptStep.model,
        latencyMs: promptStep.latencyMs,
      });

      this.sseHub.send(generationId, "status", { status: "generating" });
      await updateGenerationStatus(this.supabaseAdmin, generationId, "generating", mmaVars);

      await ensureCredits(this.supabaseAdmin, cust, Number(process.env.IMAGE_CREDITS_COST || 1), "mma_seedream_generate");

      const seedreamResolved = { ...(configs.providers.seedream?.value || {}), ...(settings.seedream || {}) };
      const seedreamSettings = {
        key: configs.providers.seedream?.key || "mma.provider.seedream.defaults",
        version: configs.providers.seedream?.version || seedreamResolved.version || null,
        id: configs.providers.seedream?.id || null,
        resolved: seedreamResolved,
        model: seedreamResolved.model,
      };
      mmaVars.meta.settings_versions.seedream = seedreamSettings.version;
      mmaVars.settings.seedream = seedreamResolved;

      const seedreamStep = await runSeedream({
        replicate: this.replicate,
        prompt: mmaVars.prompts.clean_prompt,
        settings: seedreamSettings,
      });

      let publicImageUrl = seedreamStep.outputUrl;
      if (publicImageUrl) {
        const stored = await storeRemoteImageToR2({ url: publicImageUrl, kind: "generations", customerId: cust.passId });
        publicImageUrl = stored.publicUrl;
      }

      mmaVars.outputs.seedream_image_url = publicImageUrl;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "seedream_generate",
        payload: seedreamStep.payload,
        mode: "still",
        provider: seedreamStep.provider,
        model: seedreamStep.model,
        latencyMs: seedreamStep.latencyMs,
        status: publicImageUrl ? "done" : "error",
      });

      this.sseHub.send(generationId, "scan_line", { line: "Scanning output..." });
      const postscan = await runGptVisionStep({
        openai: this.openai,
        config: configs.ctx.gpt_scanner,
        imageUrls: publicImageUrl ? [publicImageUrl] : [],
        prompt: "Caption the generated still image.",
        stepType: "postscan_output_still",
      });
      mmaVars.scans.output_still_crt = postscan.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "postscan_output_still",
        payload: postscan.payload,
        mode: "still",
        model: postscan.model,
        latencyMs: postscan.latencyMs,
      });

      const feedback = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.gpt_feedback_still,
        inputText: `${mmaVars.prompts.clean_prompt}\n${mmaVars.scans.output_still_crt || ""}`,
        stepType: "gpt_feedback_still",
      });
      mmaVars.prompts.feedback = feedback.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_feedback_still",
        payload: feedback.payload,
        mode: "still",
        model: feedback.model,
        latencyMs: feedback.latencyMs,
      });

      await updateGenerationStatus(this.supabaseAdmin, generationId, "done", mmaVars, {
        mg_prompt: mmaVars.prompts.clean_prompt || null,
        mg_output_url: publicImageUrl || null,
      });
      this.sseHub.send(generationId, "status", { status: "done", output_url: publicImageUrl });
      return { generationId, passId, mma_vars: mmaVars, outputs: { seedream_image_url: publicImageUrl } };
    } catch (err) {
      await updateGenerationStatus(this.supabaseAdmin, generationId, "error", mmaVars, {
        mg_error: err?.message || "UNKNOWN_ERROR",
        mg_prompt: mmaVars.prompts.clean_prompt || null,
        mg_output_url: mmaVars.outputs.seedream_image_url || null,
      });
      await insertMmaErrorRow(this.supabaseAdmin, {
        generationId,
        passId: cust.passId,
        stepType: err?.stepType || null,
        provider: err?.provider || null,
        ctxVersions: mmaVars.meta?.ctx_versions,
        settingsVersions: mmaVars.meta?.settings_versions,
        payloadError: err?.payloadError || null,
        message: err?.message,
      });
      this.sseHub.send(generationId, "status", { status: "error", message: err?.message });
      await refundCredits(this.supabaseAdmin, cust, Number(process.env.IMAGE_CREDITS_COST || 1), "mma_seedream_generate_refund");
      throw err;
    }
  }

  async runVideoAnimate({
    customerId,
    email,
    userId,
    assets = {},
    inputs = {},
    mode = {},
    history = {},
    brief = "",
    settings = {},
    meta = {},
    feedback = {},
  }) {
    const generationId = `mma_${crypto.randomUUID()}`;
    const cust = await megaEnsureCustomer(this.supabaseAdmin, { customerId, email, userId });
    const passId = cust?.passId || null;
    const mmaVars = {
      assets,
      inputs,
      mode,
      history,
      feedback,
      prompts: {},
      scans: {},
      outputs: {},
      settings: {},
      userMessages: { scan_lines: [] },
      meta: { ctx_versions: {}, settings_versions: {}, ...meta },
    };

    const combinedBrief = (brief || `${inputs.motion_user_brief || ""}\n${inputs.movement_style || ""}`).trim();

    await insertGenerationRow(this.supabaseAdmin, generationId, passId, "video", mmaVars);
    this.sseHub.send(generationId, "status", { status: "queued" });

    const configs = await this.loadConfigs();
    if (configs.ctx.gpt_reader_motion?.version)
      mmaVars.meta.ctx_versions.gpt_reader_motion = configs.ctx.gpt_reader_motion.version;
    if (configs.ctx.motion_suggestion?.version)
      mmaVars.meta.ctx_versions.motion_suggestion = configs.ctx.motion_suggestion.version;
    if (configs.ctx.gpt_feedback_motion?.version)
      mmaVars.meta.ctx_versions.gpt_feedback_motion = configs.ctx.gpt_feedback_motion.version;
    if (configs.ctx.gpt_scanner?.version)
      mmaVars.meta.ctx_versions.gpt_scanner = configs.ctx.gpt_scanner.version;
    if (configs.providers.kling?.version)
      mmaVars.meta.settings_versions.kling = configs.providers.kling.version;

    let stepNo = 0;
    const scanLine = (line) => {
      mmaVars.userMessages.scan_lines.push(line);
      this.sseHub.send(generationId, "scan_line", { index: mmaVars.userMessages.scan_lines.length, text: line });
      updateGenerationStatus(this.supabaseAdmin, generationId, "scanning", mmaVars).catch(() => {});
    };

    try {
      const stillUrl = assets?.still_url || assets?.input_still_image_id || null;
      if (stillUrl) {
        scanLine("Scanning input still...");
        const scan = await runGptVisionStep({
          openai: this.openai,
          config: configs.ctx.gpt_scanner,
          imageUrls: [stillUrl],
          prompt: "Describe the source still for animation.",
          stepType: "scan_input_still",
        });
        mmaVars.scans.still_crt = scan.payload.output.text;
        await recordMmaStep({
          supabaseAdmin: this.supabaseAdmin,
          generationId,
          stepNo: stepNo++,
          stepType: "scan_input_still",
          payload: scan.payload,
          mode: "video",
          model: scan.model,
          latencyMs: scan.latencyMs,
        });
      }

      this.sseHub.send(generationId, "status", { status: "prompting" });
      await updateGenerationStatus(this.supabaseAdmin, generationId, "prompting", mmaVars);

      const motionSuggestion = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.motion_suggestion,
        inputText: `${combinedBrief}\n${mmaVars.scans.still_crt || ""}`,
        stepType: "motion_suggestion",
      });
      mmaVars.prompts.motion_suggestion = motionSuggestion.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "motion_suggestion",
        payload: motionSuggestion.payload,
        mode: "video",
        model: motionSuggestion.model,
        latencyMs: motionSuggestion.latencyMs,
      });

      const motionPrompt = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.gpt_reader_motion,
        inputText: `${mmaVars.prompts.motion_suggestion}\n${combinedBrief}`,
        stepType: "gpt_reader_motion",
      });
      mmaVars.prompts.motion_prompt = motionPrompt.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_reader_motion",
        payload: motionPrompt.payload,
        mode: "video",
        model: motionPrompt.model,
        latencyMs: motionPrompt.latencyMs,
      });

      this.sseHub.send(generationId, "status", { status: "generating" });
      await updateGenerationStatus(this.supabaseAdmin, generationId, "generating", mmaVars);
      await ensureCredits(this.supabaseAdmin, cust, Number(process.env.MOTION_CREDITS_COST || 5), "mma_kling_generate");

      const klingResolved = { ...(configs.providers.kling?.value || {}), ...(settings.kling || {}) };
      const klingSettings = {
        key: configs.providers.kling?.key || "mma.provider.kling.defaults",
        version: configs.providers.kling?.version || klingResolved.version || null,
        id: configs.providers.kling?.id || null,
        resolved: klingResolved,
        model: klingResolved.model,
      };
      mmaVars.meta.settings_versions.kling = klingSettings.version;
      mmaVars.settings.kling = klingResolved;

      const klingStep = await runKling({
        replicate: this.replicate,
        prompt: mmaVars.prompts.motion_prompt,
        settings: klingSettings,
      });

      let publicVideoUrl = klingStep.outputUrl;
      if (publicVideoUrl) {
        const stored = await storeRemoteImageToR2({ url: publicVideoUrl, kind: "generations", customerId: cust.passId });
        publicVideoUrl = stored.publicUrl;
      }

      mmaVars.outputs.kling_video_url = publicVideoUrl;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "kling_generate",
        payload: klingStep.payload,
        mode: "video",
        provider: klingStep.provider,
        model: klingStep.model,
        latencyMs: klingStep.latencyMs,
        status: publicVideoUrl ? "done" : "error",
      });

      const feedback = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.gpt_feedback_motion,
        inputText: `${mmaVars.prompts.motion_prompt}\n${publicVideoUrl || ""}`,
        stepType: "gpt_feedback_motion",
      });
      mmaVars.prompts.motion_feedback = feedback.payload.output.text;
      await recordMmaStep({
        supabaseAdmin: this.supabaseAdmin,
        generationId,
        stepNo: stepNo++,
        stepType: "gpt_feedback_motion",
        payload: feedback.payload,
        mode: "video",
        model: feedback.model,
        latencyMs: feedback.latencyMs,
      });

      await updateGenerationStatus(this.supabaseAdmin, generationId, "done", mmaVars, {
        mg_prompt: mmaVars.prompts.motion_prompt || null,
        mg_output_url: publicVideoUrl || null,
      });
      this.sseHub.send(generationId, "status", { status: "done", output_url: publicVideoUrl });
      return { generationId, passId, mma_vars: mmaVars, outputs: { kling_video_url: publicVideoUrl } };
    } catch (err) {
      await updateGenerationStatus(this.supabaseAdmin, generationId, "error", mmaVars, {
        mg_error: err?.message || "UNKNOWN_ERROR",
        mg_prompt: mmaVars.prompts.motion_prompt || null,
        mg_output_url: mmaVars.outputs.kling_video_url || null,
      });
      await insertMmaErrorRow(this.supabaseAdmin, {
        generationId,
        passId: cust.passId,
        stepType: err?.stepType || null,
        provider: err?.provider || null,
        ctxVersions: mmaVars.meta?.ctx_versions,
        settingsVersions: mmaVars.meta?.settings_versions,
        payloadError: err?.payloadError || null,
        message: err?.message,
      });
      this.sseHub.send(generationId, "status", { status: "error", message: err?.message });
      await refundCredits(this.supabaseAdmin, cust, Number(process.env.MOTION_CREDITS_COST || 5), "mma_kling_generate_refund");
      throw err;
    }
  }

  async runStillTweak({ baseGenerationId, customerId, email, userId, feedback = {}, settings = {} }) {
    const { data } = await (this.supabaseAdmin
      ? this.supabaseAdmin
          .from("mega_generations")
          .select("mg_mma_vars")
          .eq("mg_generation_id", baseGenerationId)
          .eq("mg_record_type", "generation")
          .maybeSingle()
      : { data: null });

    const baseVars = data?.mg_mma_vars || {};

    return this.runStillCreate({
      customerId,
      email,
      userId,
      assets: baseVars.assets || {},
      inputs: baseVars.inputs || {},
      history: baseVars.history || {},
      feedback: { ...baseVars.feedback, ...feedback },
      brief: feedback.still_feedback || baseVars.inputs?.userBrief || "",
      settings,
      meta: { ...(baseVars.meta || {}), base_generation_id: baseGenerationId },
    });
  }

  async runVideoTweak({ baseGenerationId, customerId, email, userId, feedback = {}, settings = {} }) {
    const { data } = await (this.supabaseAdmin
      ? this.supabaseAdmin
          .from("mega_generations")
          .select("mg_mma_vars")
          .eq("mg_generation_id", baseGenerationId)
          .eq("mg_record_type", "generation")
          .maybeSingle()
      : { data: null });

    const baseVars = data?.mg_mma_vars || {};

    return this.runVideoAnimate({
      customerId,
      email,
      userId,
      assets: baseVars.assets || {},
      inputs: baseVars.inputs || {},
      mode: baseVars.mode || {},
      history: baseVars.history || {},
      feedback: { ...baseVars.feedback, ...feedback },
      brief: feedback.motion_feedback || baseVars.inputs?.motion_user_brief || "",
      settings,
      meta: { ...(baseVars.meta || {}), base_generation_id: baseGenerationId },
    });
  }
}

export function createMmaController(opts = {}) {
  return new MmaController(opts);
}

export { SseHub };
