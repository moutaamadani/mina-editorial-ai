// ./server/mma/replicate-poll.js
// Replicate polling helper with hard timeout + last-chance fetch.
// - Avoids replicate.run() hanging forever.
// - Stores predictionId so you can recover later.

"use strict";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label = "REPLICATE_CALL_TIMEOUT") {
  const t = Math.max(1000, Number(ms || 0) || 15000);
  let timer = null;

  const timeoutPromise = new Promise((_, rej) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = label;
      rej(err);
    }, t);
  });

  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

export async function replicatePredictWithTimeout({
  replicate,
  version,
  input,
  timeoutMs = 240000,
  pollMs = 2500,
  callTimeoutMs = 15000,
  cancelOnTimeout = false,
}) {
  if (!replicate) throw new Error("REPLICATE_CLIENT_MISSING");
  if (!version) throw new Error("REPLICATE_VERSION_MISSING");

  const t0 = Date.now();
  const hard = Math.max(30000, Number(timeoutMs || 0) || 240000);
  const poll = Math.max(800, Number(pollMs || 0) || 2500);
  const callT = Math.max(3000, Number(callTimeoutMs || 0) || 15000);

  // 1) create prediction
  let created;
  created = await withTimeout(
    replicate.predictions.create({ version, input }),
    callT,
    "REPLICATE_CREATE_TIMEOUT"
  );

  const predictionId = created?.id || "";
  let last = created;

  // 2) poll
  while (true) {
    const status = String(last?.status || "");
    if (status === "succeeded" || status === "failed" || status === "canceled") break;

    const elapsed = Date.now() - t0;
    if (elapsed >= hard) break;

    await sleep(poll);

    try {
      last = await withTimeout(
        replicate.predictions.get(predictionId),
        callT,
        "REPLICATE_GET_TIMEOUT"
      );
    } catch {
      // ignore transient get timeouts, keep polling
    }
  }

  // 3) last chance fetch
  try {
    last = await withTimeout(
      replicate.predictions.get(predictionId),
      callT,
      "REPLICATE_GET_TIMEOUT_FINAL"
    );
  } catch {
    // keep whatever we had
  }

  const elapsedMs = Date.now() - t0;

  const status = String(last?.status || "");
  const done = status === "succeeded" || status === "failed" || status === "canceled";
  const timedOut = !done && elapsedMs >= hard;

  // ✅ if provider actually failed/canceled, THROW with provider details
  if (status === "failed" || status === "canceled") {
    const err = new Error(status === "failed" ? "REPLICATE_FAILED" : "REPLICATE_CANCELED");
    err.code = err.message;
    err.provider = {
      id: last?.id || predictionId || null,
      status,
      error: last?.error || null,
      logs: last?.logs || null,
      model: last?.model || null,
      version: last?.version || null,
      input: last?.input || null,
    };
    throw err;
  }

  // optional cancel (default false — better for “recover later”)
  if (timedOut && cancelOnTimeout) {
    try {
      await withTimeout(
        replicate.predictions.cancel(predictionId),
        callT,
        "REPLICATE_CANCEL_TIMEOUT"
      );
    } catch {}
  }

  return {
    predictionId,
    prediction: last,
    timedOut,
    elapsedMs,
  };
}
