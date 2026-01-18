// server/mma/mma-inline-worker.js
// Simple in-process worker that consumes mega_generations queued rows.
// Runs Fabric (audio+image) and Kling motion-control (image+ref-video).

import Replicate from "replicate";
import { getSupabaseAdmin, sbEnabled } from "../../supabase.js";
import { storeRemoteImageToR2 } from "../../r2.js";

const MODEL_FABRIC = "veed/fabric-1.0";
const MODEL_KLING_MOTION_CONTROL = "kwaivgi/kling-v2.6-motion-control";

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function tryParseJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractFirstUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;

  if (Array.isArray(output)) {
    const u = output.find((x) => typeof x === "string" && x.startsWith("http"));
    return u || "";
  }

  if (typeof output === "object") {
    // common shapes
    const candidates = [
      output.url,
      output.output,
      output.video,
      output.video_url,
      output.result,
      output.file,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("http")) return c;
    }
    if (Array.isArray(output.urls)) {
      const u = output.urls.find((x) => typeof x === "string" && x.startsWith("http"));
      if (u) return u;
    }
  }

  return "";
}

function getFrame2(vars) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  const frame2Kind = safeString(inputs.frame2_kind || inputs.frame2Kind, "").toLowerCase();

  const audioUrl = safeString(
    inputs.frame2_url ||
      inputs.frame2Url ||
      inputs.frame2_audio_url ||
      inputs.frame2AudioUrl ||
      assets.frame2_audio_url ||
      assets.frame2AudioUrl ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.audio,
    ""
  );

  const videoUrl = safeString(
    inputs.frame2_url ||
      inputs.frame2Url ||
      inputs.frame2_video_url ||
      inputs.frame2VideoUrl ||
      assets.frame2_video_url ||
      assets.frame2VideoUrl ||
      assets.video_url ||
      assets.videoUrl ||
      assets.video,
    ""
  );

  // If both exist, prefer explicit kind.
  if (frame2Kind.includes("audio")) return { kind: "audio", url: audioUrl };
  if (frame2Kind.includes("video")) return { kind: "video", url: videoUrl };

  // Auto-detect fallback
  if (videoUrl && videoUrl.startsWith("http")) return { kind: "video", url: videoUrl };
  if (audioUrl && audioUrl.startsWith("http")) return { kind: "audio", url: audioUrl };
  return { kind: "", url: "" };
}

function getStartImage(vars) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};
  return safeString(
    assets.start_image_url ||
      assets.startImageUrl ||
      inputs.start_image_url ||
      inputs.startImageUrl ||
      "",
    ""
  );
}

function buildPrompt(vars) {
  const inputs = vars?.inputs || {};
  return safeString(
    inputs.prompt_override ||
      inputs.motion_prompt_override ||
      inputs.motionPromptOverride ||
      inputs.motion_user_brief ||
      inputs.motionUserBrief ||
      inputs.brief ||
      "",
    ""
  );
}

function normalizeMode(vars) {
  const inputs = vars?.inputs || {};
  const raw = safeString(inputs.mode || inputs.kling_mode || "", "").toLowerCase();
  return raw === "pro" ? "pro" : "std";
}

let _started = false;

export function startMmaInlineWorker({
  intervalMs = 2500,
  maxBatch = 1,
} = {}) {
  if (_started) return;
  _started = true;

  const token = safeString(process.env.REPLICATE_API_TOKEN, "");
  if (!token) {
    console.warn("[mma-inline-worker] REPLICATE_API_TOKEN missing -> queue will stay queued.");
    return;
  }

  const replicate = new Replicate({ auth: token });

  let running = false;

  async function claimQueuedRow(supabase, generationId) {
    // claim with compare-and-swap: only one worker can grab it
    const { data, error } = await supabase
      .from("mega_generations")
      .update({
        mg_mma_status: "processing",
        mg_status: "processing",
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_mma_status", "queued")
      .select("mg_generation_id")
      .maybeSingle();

    if (error) throw error;
    return !!data?.mg_generation_id;
  }

  async function markError(supabase, generationId, err) {
    const message = safeString(err?.message, "MMA_JOB_FAILED");
    await supabase
      .from("mega_generations")
      .update({
        mg_mma_status: "error",
        mg_status: "error",
        mg_error: message,
      })
      .eq("mg_generation_id", generationId);
  }

  async function markDone(supabase, generationId, passId, model, publicUrl, latencyMs, nextVars) {
    await supabase
      .from("mega_generations")
      .update({
        mg_mma_status: "done",
        mg_status: "done",
        mg_output_url: publicUrl,
        mg_video_url: publicUrl,
        mg_provider: "replicate",
        mg_model: model,
        mg_latency_ms: latencyMs,
        mg_error: null,
        mg_mma_vars: JSON.stringify(nextVars),
      })
      .eq("mg_generation_id", generationId);
  }

  async function processOne(row) {
    const supabase = getSupabaseAdmin();
    const generationId = safeString(row?.mg_generation_id, "");
    const passId = safeString(row?.mg_pass_id, "anonymous");
    const vars = tryParseJson(row?.mg_mma_vars) || {};

    if (!generationId) return;

    const claimed = await claimQueuedRow(supabase, generationId);
    if (!claimed) return; // another worker grabbed it

    try {
      const startImage = getStartImage(vars);
      if (!startImage) throw new Error("MISSING_START_IMAGE_URL");

      const frame2 = getFrame2(vars);
      if (!frame2.url) throw new Error("MISSING_FRAME2_REFERENCE_URL");

      const startedAt = Date.now();

      let model = "";
      let input = {};

      if (frame2.kind === "audio") {
        model = MODEL_FABRIC;
        input = {
          image: startImage,
          audio: frame2.url,
          resolution: "720p",
        };
      } else if (frame2.kind === "video") {
        model = MODEL_KLING_MOTION_CONTROL;
        input = {
          image: startImage,
          video: frame2.url,
          prompt: buildPrompt(vars),
          mode: normalizeMode(vars), // std|pro
          keep_original_sound: true,
          character_orientation: "video",
        };
      } else {
        throw new Error("UNKNOWN_FRAME2_KIND");
      }

      const out = await replicate.run(model, { input });
      const remoteUrl = extractFirstUrl(out);
      if (!remoteUrl) throw new Error("NO_OUTPUT_URL_FROM_MODEL");

      // Store to R2 so it’s permanent + consistent with your app
      const stored = await storeRemoteImageToR2({
        url: remoteUrl,
        kind: "generations",
        customerId: passId,
      });

      const publicUrl = stored?.publicUrl || stored?.url || "";
      if (!publicUrl) throw new Error("R2_STORE_FAILED");

      const latencyMs = Date.now() - startedAt;

      // write back into vars.outputs too (nice for Profile later)
      const nextVars = { ...vars, outputs: { ...(vars.outputs || {}) } };
      if (model === MODEL_FABRIC) nextVars.outputs.fabric_video_url = publicUrl;
      if (model === MODEL_KLING_MOTION_CONTROL) nextVars.outputs.kling_video_url = publicUrl;

      await markDone(supabase, generationId, passId, model, publicUrl, latencyMs, nextVars);
      console.log("[mma-inline-worker] done", generationId, model);
    } catch (err) {
      console.error("[mma-inline-worker] job failed", generationId, err?.message || err);
      await markError(getSupabaseAdmin(), generationId, err);
    }
  }

  async function tick() {
    if (running) return;
    running = true;

    try {
      if (!sbEnabled()) return;

      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from("mega_generations")
        .select("mg_generation_id, mg_pass_id, mg_mma_vars, mg_mma_status, mg_created_at")
        .eq("mg_mma_status", "queued")
        .order("mg_created_at", { ascending: true })
        .limit(maxBatch);

      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        // process sequentially (safe + simple)
        // eslint-disable-next-line no-await-in-loop
        await processOne(r);
      }
    } catch (e) {
      console.error("[mma-inline-worker] tick failed", e?.message || e);
    } finally {
      running = false;
    }
  }

  // start loop
  setInterval(tick, intervalMs);
  // run immediately once
  tick().catch(() => {});
  console.log("[mma-inline-worker] started");
}
