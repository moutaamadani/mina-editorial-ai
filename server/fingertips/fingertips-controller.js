// ./server/fingertips/fingertips-controller.js
// Controller for Fingertips feature — fractional-matcha billing + Replicate model calls.
//
// BILLING MODEL ("pool" system):
//   1. Each fingertips model costs a fraction of 1 matcha (e.g. 0.1, 0.2, 0.5).
//   2. On first use (or when pool is exhausted), we deduct 1 WHOLE matcha from
//      the user's main balance and add 1.0 to their "fingertips pool".
//   3. Each generation then subtracts its cost from the pool.
//   4. When pool < model cost, another matcha is deducted.
//   5. Pool state is stored in mega_customers.mg_mma_preferences.fingertips_pool.
//
// This means the user always sees whole-matcha deductions but gets multiple
// generations per matcha depending on the model used.

import crypto from "node:crypto";
import Replicate from "replicate";

import {
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
} from "../../mega-db.js";

import { getSupabaseAdmin } from "../../supabase.js";
import { replicatePredictWithTimeout } from "../mma/replicate-poll.js";
import { FINGERTIPS_MODELS, getFingertipsModel, FINGERTIPS_MODEL_KEYS } from "./fingertips-config.js";

// ============================================================================
// Replicate client (shared singleton)
// ============================================================================
let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

// ============================================================================
// Small helpers
// ============================================================================
function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// ============================================================================
// Pool management (reads/writes mg_mma_preferences.fingertips_pool)
// ============================================================================
async function readFingertipsPool(supabase, passId) {
  const { data } = await supabase
    .from("mega_customers")
    .select("mg_mma_preferences")
    .eq("mg_pass_id", passId)
    .maybeSingle();

  const prefs = data?.mg_mma_preferences;
  const pool = Number(prefs?.fingertips_pool || 0);
  return { pool: pool > 0 ? pool : 0, prefs: prefs || {} };
}

async function writeFingertipsPool(supabase, passId, prefs, newPool) {
  await supabase
    .from("mega_customers")
    .update({
      mg_mma_preferences: { ...prefs, fingertips_pool: newPool },
      mg_mma_preferences_updated_at: nowIso(),
      mg_updated_at: nowIso(),
    })
    .eq("mg_pass_id", passId);
}

// ============================================================================
// chargeFingertips — the core pool billing logic
//
// 1. Read current pool from preferences.
// 2. If pool >= modelCost → deduct from pool, done.
// 3. Else → deduct 1 whole matcha from main balance, add 1.0 to pool,
//    then deduct modelCost from pool.
// 4. Write updated pool back to preferences.
//
// Returns { charged, matchasDeducted, poolBefore, poolAfter }
// ============================================================================
export async function chargeFingertips({ passId, generationId, modelKey }) {
  const model = getFingertipsModel(modelKey);
  if (!model) throw makeHttpError(400, "UNKNOWN_FINGERTIPS_MODEL", { modelKey });

  const cost = model.costPerGeneration;
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  // Idempotency: check if this generation was already charged
  const refType = "fingertips_charge";
  const refId = `fingertips:${generationId}`;
  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: true, already: true, cost };

  // Read pool
  const { pool: currentPool, prefs } = await readFingertipsPool(supabase, passId);
  let pool = currentPool;
  let matchasDeducted = 0;

  // If pool is insufficient, deduct 1 whole matcha
  if (pool < cost) {
    // Check user has at least 1 matcha
    const { credits } = await megaGetCredits(passId);
    if (credits < 1) {
      throw makeHttpError(402, "INSUFFICIENT_CREDITS", {
        passId,
        balance: credits,
        needed: 1,
        details: {
          userMessage: `you've got ${credits} matcha left. fingertips needs at least 1 matcha to start. top up to keep going.`,
          balance: credits,
          needed: 1,
          modelKey,
          modelLabel: model.label,
          costPerGeneration: cost,
          generationsPerMatcha: Math.floor(1 / cost),
          actions: [{ id: "buy_matcha", label: "Buy matcha", enabled: true }],
        },
      });
    }

    // Deduct 1 matcha (idempotent via ref)
    await megaAdjustCredits({
      passId,
      delta: -1,
      reason: "fingertips_pool_refill",
      source: "fingertips",
      refType,
      refId,
      grantedAt: nowIso(),
    });

    pool += 1.0;
    matchasDeducted = 1;
  } else {
    // Pool has enough — write an idempotency marker directly (megaAdjustCredits rejects delta=0)
    const supabaseAdmin = getSupabaseAdmin();
    if (supabaseAdmin) {
      const txTs = nowIso();
      await supabaseAdmin.from("mega_generations").insert({
        mg_id: `credit_transaction:${crypto.randomUUID()}`,
        mg_record_type: "credit_transaction",
        mg_pass_id: passId,
        mg_delta: 0,
        mg_reason: "fingertips_pool_draw",
        mg_source: "fingertips",
        mg_ref_type: refType,
        mg_ref_id: refId,
        mg_status: "succeeded",
        mg_meta: { pool_before: pool, pool_cost: cost },
        mg_payload: null,
        mg_event_at: txTs,
        mg_created_at: txTs,
        mg_updated_at: txTs,
      });
    }
  }

  // Deduct model cost from pool
  const poolBefore = pool;
  pool = Math.round((pool - cost) * 100) / 100; // avoid floating-point drift
  if (pool < 0) pool = 0;

  // Persist updated pool
  await writeFingertipsPool(supabase, passId, prefs, pool);

  return {
    charged: true,
    already: false,
    cost,
    matchasDeducted,
    poolBefore,
    poolAfter: pool,
    modelKey,
  };
}

// ============================================================================
// refundFingertips — on failure, restore pool (and matcha if pool was just refilled)
// ============================================================================
export async function refundFingertips({ passId, generationId, modelKey }) {
  const model = getFingertipsModel(modelKey);
  if (!model) return { refunded: false };

  const cost = model.costPerGeneration;
  const refType = "fingertips_refund";
  const refId = `fingertips:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { refunded: false, already: true };

  const supabase = getSupabaseAdmin();
  if (!supabase) return { refunded: false };

  // Add cost back to pool
  const { pool: currentPool, prefs } = await readFingertipsPool(supabase, passId);
  const newPool = Math.round((currentPool + cost) * 100) / 100;
  await writeFingertipsPool(supabase, passId, prefs, newPool);

  // Record refund in ledger (idempotent marker — delta=0 so write directly)
  if (supabase) {
    const txTs = nowIso();
    await supabase.from("mega_generations").insert({
      mg_id: `credit_transaction:${crypto.randomUUID()}`,
      mg_record_type: "credit_transaction",
      mg_pass_id: passId,
      mg_delta: 0,
      mg_reason: "fingertips_pool_refund",
      mg_source: "fingertips",
      mg_ref_type: refType,
      mg_ref_id: refId,
      mg_status: "succeeded",
      mg_meta: { pool_refunded: cost, pool_after: newPool },
      mg_payload: null,
      mg_event_at: txTs,
      mg_created_at: txTs,
      mg_updated_at: txTs,
    });
  }

  return { refunded: true, cost, poolAfter: newPool };
}

// ============================================================================
// validateInputs — check required inputs against the model's schema
// ============================================================================
function validateInputs(modelKey, userInputs) {
  const model = getFingertipsModel(modelKey);
  if (!model) throw makeHttpError(400, "UNKNOWN_FINGERTIPS_MODEL", { modelKey });

  const schema = model.inputSchema;
  const cleaned = {};
  const missing = [];

  for (const [param, spec] of Object.entries(schema)) {
    const value = userInputs?.[param];

    if (spec.required && (value === undefined || value === null || value === "")) {
      missing.push(param);
      continue;
    }

    if (value !== undefined && value !== null && value !== "") {
      cleaned[param] = value;
    } else if (spec.default !== undefined) {
      cleaned[param] = spec.default;
    }
  }

  if (missing.length > 0) {
    throw makeHttpError(400, "MISSING_REQUIRED_INPUTS", {
      modelKey,
      missing,
      message: `Missing required inputs for ${model.label}: ${missing.join(", ")}`,
    });
  }

  return cleaned;
}

// ============================================================================
// runFingertipsModel — call Replicate and return result
// ============================================================================
async function runFingertipsModel({ modelKey, input }) {
  const model = getFingertipsModel(modelKey);
  const replicate = getReplicate();

  const { predictionId, prediction, timedOut, elapsedMs } = await replicatePredictWithTimeout({
    replicate,
    version: model.replicateModel,
    input,
    timeoutMs: 180000, // 3 min for image tools
    pollMs: 2000,
  });

  return {
    predictionId,
    prediction,
    timedOut,
    elapsedMs,
    output: prediction?.output || null,
    status: prediction?.status || "unknown",
  };
}

// ============================================================================
// handleFingertipsGenerate — main entry point
//
// Expects: { passId, modelKey, inputs }
// Returns: { generation_id, status, output, model, credits_cost, pool }
// ============================================================================
export async function handleFingertipsGenerate({ passId, modelKey, inputs }) {
  if (!passId) throw makeHttpError(400, "PASS_ID_REQUIRED");
  if (!modelKey || !getFingertipsModel(modelKey)) {
    throw makeHttpError(400, "UNKNOWN_FINGERTIPS_MODEL", {
      modelKey,
      availableModels: FINGERTIPS_MODEL_KEYS,
    });
  }

  const model = getFingertipsModel(modelKey);
  const generationId = crypto.randomUUID();
  const supabase = getSupabaseAdmin();

  // 1. Validate inputs
  const cleanedInputs = validateInputs(modelKey, inputs || {});

  // 2. Charge (pool-based)
  const chargeResult = await chargeFingertips({ passId, generationId, modelKey });

  // 3. Write generation record
  const ts = nowIso();
  if (supabase) {
    await supabase.from("mega_generations").insert({
      mg_id: `generation:${generationId}`,
      mg_record_type: "generation",
      mg_generation_id: generationId,
      mg_pass_id: passId,
      mg_mma_mode: "fingertips",
      mg_mma_status: "generating",
      mg_status: "pending",
      mg_provider: "replicate",
      mg_model: model.replicateModel,
      mg_mma_vars: {
        modelKey,
        inputs: cleanedInputs,
        charge: chargeResult,
      },
      mg_created_at: ts,
      mg_updated_at: ts,
    });
  }

  // 4. Call Replicate
  let result;
  try {
    result = await runFingertipsModel({ modelKey, input: cleanedInputs });
  } catch (err) {
    // Refund on failure
    const refundResult = await refundFingertips({ passId, generationId, modelKey });

    // Update generation record
    if (supabase) {
      await supabase
        .from("mega_generations")
        .update({
          mg_mma_status: "error",
          mg_status: "failed",
          mg_error: {
            code: err?.code || "REPLICATE_ERROR",
            message: err?.message || String(err),
            provider: err?.provider || null,
          },
          mg_mma_vars: {
            modelKey,
            inputs: cleanedInputs,
            charge: chargeResult,
            refund: refundResult,
          },
          mg_updated_at: nowIso(),
        })
        .eq("mg_id", `generation:${generationId}`);
    }

    throw makeHttpError(502, "FINGERTIPS_GENERATION_FAILED", {
      generationId,
      modelKey,
      refunded: refundResult.refunded,
      message: err?.message || String(err),
    });
  }

  // 5. Handle timeout
  if (result.timedOut) {
    if (supabase) {
      await supabase
        .from("mega_generations")
        .update({
          mg_mma_status: "generating",
          mg_status: "pending",
          mg_meta: { predictionId: result.predictionId, timedOut: true, elapsedMs: result.elapsedMs },
          mg_updated_at: nowIso(),
        })
        .eq("mg_id", `generation:${generationId}`);
    }

    return {
      generation_id: generationId,
      status: "processing",
      model: model.replicateModel,
      model_key: modelKey,
      prediction_id: result.predictionId,
      credits_cost: chargeResult.cost,
      matchas_deducted: chargeResult.matchasDeducted,
      pool_remaining: chargeResult.poolAfter,
      message: "Generation is still processing. Poll /fingertips/generations/:id for result.",
    };
  }

  // 6. Success — finalize
  const outputUrl = extractOutputUrl(result.output);

  if (supabase) {
    await supabase
      .from("mega_generations")
      .update({
        mg_mma_status: "done",
        mg_status: "succeeded",
        mg_output_url: outputUrl,
        mg_latency_ms: result.elapsedMs,
        mg_meta: { predictionId: result.predictionId },
        mg_updated_at: nowIso(),
      })
      .eq("mg_id", `generation:${generationId}`);
  }

  return {
    generation_id: generationId,
    status: "done",
    model: model.replicateModel,
    model_key: modelKey,
    output: result.output,
    output_url: outputUrl,
    prediction_id: result.predictionId,
    elapsed_ms: result.elapsedMs,
    credits_cost: chargeResult.cost,
    matchas_deducted: chargeResult.matchasDeducted,
    pool_remaining: chargeResult.poolAfter,
  };
}

// ============================================================================
// fetchFingertipsGeneration — get status of a fingertips generation
// ============================================================================
export async function fetchFingertipsGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error || !data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: data.mg_mma_status,
    mode: data.mg_mma_mode,
    model: data.mg_model,
    model_key: data.mg_mma_vars?.modelKey || null,
    output_url: data.mg_output_url || null,
    error: data.mg_error || null,
    latency_ms: data.mg_latency_ms || null,
    created_at: data.mg_created_at,
    updated_at: data.mg_updated_at,
  };
}

// ============================================================================
// getPoolStatus — return current pool balance for a user
// ============================================================================
export async function getPoolStatus(passId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { pool: 0 };

  const { pool } = await readFingertipsPool(supabase, passId);
  const { credits, expiresAt } = await megaGetCredits(passId);

  return {
    pool,
    matchaBalance: credits,
    expiresAt,
  };
}

// ============================================================================
// listModels — return available models + their costs and schemas
// ============================================================================
export function listFingertipsModels() {
  return Object.entries(FINGERTIPS_MODELS).map(([key, model]) => ({
    key,
    label: model.label,
    description: model.description,
    replicateModel: model.replicateModel,
    costPerGeneration: model.costPerGeneration,
    generationsPerMatcha: Math.floor(1 / model.costPerGeneration),
    inputSchema: model.inputSchema,
  }));
}

// ============================================================================
// Helper: extract URL from various Replicate output formats
// ============================================================================
function extractOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return typeof output[0] === "string" ? output[0] : null;
  if (typeof output === "object" && output.url) return output.url;
  return null;
}
