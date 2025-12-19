import crypto from "node:crypto";
import EventEmitter from "node:events";
import OpenAI from "openai";
import Replicate from "replicate";
import {
  megaEnsureCustomer,
  megaWriteCreditTxnEvent,
} from "../../mega-db.js";
import { storeRemoteImageToR2 } from "../../r2.js";

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback = {}) {
  if (!value || typeof value !== "object") return fallback;
  if (Array.isArray(value)) return fallback;
  return value;
}

function parseVersionFromId(mgId) {
  const match = String(mgId || "").match(/\.v(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function fetchAppConfig(supabaseAdmin, key) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("mega_admin")
    .select("mg_id, mg_value, mg_key")
    .eq("mg_record_type", "app_config")
    .eq("mg_key", key)
    .order("mg_created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    key,
    id: data.mg_id,
    version: parseVersionFromId(data.mg_id) || safeJson(data.mg_value).version || null,
    value: safeJson(data.mg_value),
  };
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
    const resp = await openai.chat.completions.create({
      model: config?.model || "gpt-4o-mini",
      messages,
      max_tokens: config?.max_tokens || 300,
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
    model: config?.model || "gpt-4o-mini",
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
    const resp = await openai.chat.completions.create({
      model: config?.model || "gpt-4o-mini",
      messages,
      max_tokens: config?.max_tokens || 400,
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
    model: config?.model || "gpt-4o-mini",
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
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.gpt_reader"),
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.gpt_feedback_still"),
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.gpt_feedback_motion"),
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.gpt_reader_motion"),
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.motion_suggestion"),
      fetchAppConfig(this.supabaseAdmin, "mma.ctx.gpt_scanner"),
    ]);

    const [seedreamDefaults, klingDefaults] = await Promise.all([
      fetchAppConfig(this.supabaseAdmin, "mma.provider.seedream.defaults"),
      fetchAppConfig(this.supabaseAdmin, "mma.provider.kling.defaults"),
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

  async runStillCreate({ customerId, email, userId, assets = {}, brief = "", settings = {} }) {
    const generationId = `mma_${crypto.randomUUID()}`;
    const cust = await megaEnsureCustomer(this.supabaseAdmin, { customerId, email, userId });
    const mmaVars = {
      assets,
      prompts: {},
      scans: {},
      outputs: {},
      settings: {},
      userMessages: { scan_lines: [] },
      meta: { ctx_versions: {}, settings_versions: {} },
    };

    await insertGenerationRow(this.supabaseAdmin, generationId, cust.passId, "still", mmaVars);
    this.sseHub.send(generationId, "status", { status: "queued" });

    const configs = await this.loadConfigs();
    if (configs.ctx.gpt_reader?.version)
      mmaVars.meta.ctx_versions.gpt_reader = configs.ctx.gpt_reader.version;
    if (configs.ctx.gpt_scanner?.version)
      mmaVars.meta.ctx_versions.gpt_scanner = configs.ctx.gpt_scanner.version;
    if (configs.providers.seedream?.version)
      mmaVars.meta.settings_versions.seedream = configs.providers.seedream.version;

    let stepNo = 0;
    const scanLine = (line) => {
      mmaVars.userMessages.scan_lines.push(line);
      this.sseHub.send(generationId, "scan_line", { line });
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
        await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "scan_product", scan.payload, {
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
        await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "scan_logo", scan.payload, {
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
        await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "scan_inspiration", inspScan.payload, {
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
        inputText: `${brief}\n${mmaVars.scans.product_crt || ""}`.trim(),
        stepType: "gpt_reader",
      });
      mmaVars.prompts.clean_prompt = promptStep.payload.output.text;
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "gpt_reader", promptStep.payload, {
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
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "seedream_generate", seedreamStep.payload, {
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
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "postscan_output_still", postscan.payload, {
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
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "gpt_feedback_still", feedback.payload, {
        mode: "still",
        model: feedback.model,
        latencyMs: feedback.latencyMs,
      });

      await updateGenerationStatus(this.supabaseAdmin, generationId, "done", mmaVars, {
        mg_prompt: mmaVars.prompts.clean_prompt || null,
        mg_output_url: publicImageUrl || null,
      });
      this.sseHub.send(generationId, "status", { status: "done", output_url: publicImageUrl });
      return { generationId, mma_vars: mmaVars, outputs: { seedream_image_url: publicImageUrl } };
    } catch (err) {
      await updateGenerationStatus(this.supabaseAdmin, generationId, "error", mmaVars, {
        mg_error: err?.message || "UNKNOWN_ERROR",
      });
      this.sseHub.send(generationId, "status", { status: "error", message: err?.message });
      await refundCredits(this.supabaseAdmin, cust, Number(process.env.IMAGE_CREDITS_COST || 1), "mma_seedream_generate_refund");
      throw err;
    }
  }

  async runVideoAnimate({ customerId, email, userId, stillUrl, brief = "", settings = {} }) {
    const generationId = `mma_${crypto.randomUUID()}`;
    const cust = await megaEnsureCustomer(this.supabaseAdmin, { customerId, email, userId });
    const mmaVars = {
      assets: { still_url: stillUrl },
      prompts: {},
      scans: {},
      outputs: {},
      settings: {},
      userMessages: { scan_lines: [] },
      meta: { ctx_versions: {}, settings_versions: {} },
    };

    await insertGenerationRow(this.supabaseAdmin, generationId, cust.passId, "video", mmaVars);
    this.sseHub.send(generationId, "status", { status: "queued" });

    const configs = await this.loadConfigs();
    if (configs.ctx.gpt_reader_motion?.version)
      mmaVars.meta.ctx_versions.gpt_reader_motion = configs.ctx.gpt_reader_motion.version;
    if (configs.ctx.motion_suggestion?.version)
      mmaVars.meta.ctx_versions.motion_suggestion = configs.ctx.motion_suggestion.version;
    if (configs.providers.kling?.version)
      mmaVars.meta.settings_versions.kling = configs.providers.kling.version;

    let stepNo = 0;
    const scanLine = (line) => {
      mmaVars.userMessages.scan_lines.push(line);
      this.sseHub.send(generationId, "scan_line", { line });
      updateGenerationStatus(this.supabaseAdmin, generationId, "scanning", mmaVars).catch(() => {});
    };

    try {
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
        await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "scan_input_still", scan.payload, {
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
        inputText: `${brief}\n${mmaVars.scans.still_crt || ""}`,
        stepType: "motion_suggestion",
      });
      mmaVars.prompts.motion_suggestion = motionSuggestion.payload.output.text;
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "motion_suggestion", motionSuggestion.payload, {
        mode: "video",
        model: motionSuggestion.model,
        latencyMs: motionSuggestion.latencyMs,
      });

      const motionPrompt = await runGptTextStep({
        openai: this.openai,
        config: configs.ctx.gpt_reader_motion,
        inputText: `${mmaVars.prompts.motion_suggestion}\n${brief}`,
        stepType: "gpt_reader_motion",
      });
      mmaVars.prompts.motion_prompt = motionPrompt.payload.output.text;
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "gpt_reader_motion", motionPrompt.payload, {
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
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "kling_generate", klingStep.payload, {
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
      await insertStepRow(this.supabaseAdmin, generationId, stepNo++, "gpt_feedback_motion", feedback.payload, {
        mode: "video",
        model: feedback.model,
        latencyMs: feedback.latencyMs,
      });

      await updateGenerationStatus(this.supabaseAdmin, generationId, "done", mmaVars, {
        mg_prompt: mmaVars.prompts.motion_prompt || null,
        mg_output_url: publicVideoUrl || null,
      });
      this.sseHub.send(generationId, "status", { status: "done", output_url: publicVideoUrl });
      return { generationId, mma_vars: mmaVars, outputs: { kling_video_url: publicVideoUrl } };
    } catch (err) {
      await updateGenerationStatus(this.supabaseAdmin, generationId, "error", mmaVars, {
        mg_error: err?.message || "UNKNOWN_ERROR",
      });
      this.sseHub.send(generationId, "status", { status: "error", message: err?.message });
      await refundCredits(this.supabaseAdmin, cust, Number(process.env.MOTION_CREDITS_COST || 5), "mma_kling_generate_refund");
      throw err;
    }
  }
}

export function createMmaController(opts = {}) {
  return new MmaController(opts);
}

export { SseHub };
