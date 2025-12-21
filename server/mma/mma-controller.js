// Hero Part 2: Lightweight MMA controller (synchronous stub pipeline)
// Part 2.1: This keeps an in-process async job that simulates pipeline stages with placeholder URLs.
import { getSupabaseAdmin } from "../../supabase.js";
import {
  appendScanLine,
  computePassId,
  eventIdentifiers,
  generationIdentifiers,
  makeInitialVars,
  makePlaceholderUrl,
  newUuid,
  nowIso,
  stepIdentifiers,
} from "./mma-utils.js";
import { addSseClient, sendDone, sendScanLine, sendStatus } from "./mma-sse.js";

async function ensureCustomerRow(supabase, passId, { shopifyCustomerId, userId, email }) {
  const { data } = await supabase
    .from("mega_customers")
    .select("mg_pass_id, mg_mma_preferences")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  const prefs = data?.mg_mma_preferences || {};

  if (!data) {
    const payload = {
      mg_pass_id: passId,
      mg_shopify_customer_id: shopifyCustomerId || null,
      mg_user_id: userId || null,
      mg_email: email || null,
      mg_credits: 0,
      mg_mma_preferences: prefs,
      mg_created_at: nowIso(),
      mg_updated_at: nowIso(),
    };
    await supabase.from("mega_customers").insert(payload);
  }

  return { preferences: prefs };
}

async function writeGeneration({ supabase, generationId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);
  const payload = {
    ...identifiers,
    mg_parent_id: null,
    mg_pass_id: passId,
    mg_status: "queued",
    mg_mma_status: "queued",
    mg_mma_mode: mode,
    mg_mma_vars: vars,
    mg_prompt: null,
    mg_output_url: null,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
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
    .update({
      mg_mma_vars: vars,
      mg_updated_at: nowIso(),
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
  });
  return eventId;
}

async function runStubPipeline({ supabase, generationId, vars, mode }) {
  let working = vars;
  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");
    working = appendScanLine(working, "Scanning inputs...");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, working.userMessages.scan_lines[working.userMessages.scan_lines.length - 1]);

    const startPrompt = Date.now();
    await writeStep({
      supabase,
      generationId,
      stepNo: 1,
      stepType: mode === "video" ? "gpt_reader_motion" : "gpt_reader",
      payload: {
        input: {},
        output: { message: "stubbed" },
        timing: { started_at: nowIso(), ended_at: nowIso(), duration_ms: 0 },
        error: null,
      },
    });

    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");
    working.prompts = {
      ...working.prompts,
      clean_prompt: mode === "still" ? "Placeholder MMA prompt" : working.prompts.clean_prompt,
      motion_prompt: mode === "video" ? "Placeholder motion prompt" : working.prompts.motion_prompt,
    };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");
    const outputUrl = makePlaceholderUrl(mode === "video" ? "video" : "image", generationId);
    await writeStep({
      supabase,
      generationId,
      stepNo: 2,
      stepType: mode === "video" ? "kling_generate" : "seedream_generate",
      payload: {
        input: {},
        output: { url: outputUrl },
        timing: {
          started_at: new Date(startPrompt).toISOString(),
          ended_at: nowIso(),
          duration_ms: Math.max(0, Date.now() - startPrompt),
        },
        error: null,
      },
    });

    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");
    working.outputs = { ...working.outputs };
    if (mode === "video") {
      working.outputs.kling_video_id = generationId;
    } else {
      working.outputs.seedream_image_id = generationId;
    }
    working.mg_output_url = outputUrl;
    working.userMessages.final_line = "Finished placeholder generation";
    await updateVars({ supabase, generationId, vars: working });

    await finalizeGeneration({ supabase, generationId, url: outputUrl, prompt: working.prompts.clean_prompt || working.prompts.motion_prompt });
    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] pipeline error", err);
    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({ mg_error: { code: "PIPELINE_ERROR", message: err?.message || "" } })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");
    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const generationId = newUuid();
  const passId = computePassId({
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  await ensureCustomerRow(supabase, passId, {
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

  await writeGeneration({ supabase, generationId, passId, vars, mode });

  runStubPipeline({ supabase, generationId, vars, mode }).catch((err) => {
    console.error("[mma] pipeline error", err);
  });

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaEvent(body) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId = computePassId({
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventId = await writeEvent({
    supabase,
    eventType: body?.event_type || "unknown",
    generationId: body?.generation_id || null,
    passId,
    payload: body?.payload || {},
  });

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
