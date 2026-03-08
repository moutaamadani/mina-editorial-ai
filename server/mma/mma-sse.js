// ./server/mma/mma-sse.js
// Part 4: Tiny in-memory SSE hub for MMA streams
// Part 4.1: Manages per-generation subscribers and forwards pipeline events.

// -----------------------------------------------------------------------------
// Event names
// -----------------------------------------------------------------------------
const EVENT_SCAN_LINE = "scan_line";
const EVENT_STATUS = "status";
const EVENT_DONE = "done";

// -----------------------------------------------------------------------------
// In-memory hub state
// -----------------------------------------------------------------------------
/**
 * streams: Map<generationId, { clients:Set<res>, nextLineIndex:number }>
 */
const streams = new Map();

function safeWrite(res, chunk) {
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function writeEvent(res, event, data) {
  // SSE frame: event + data + blank line
  if (!safeWrite(res, `event: ${event}\n`)) return false;
  if (!safeWrite(res, `data: ${JSON.stringify(data)}\n\n`)) return false;
  return true;
}

function ensureStream(generationId) {
  if (!streams.has(generationId)) {
    streams.set(generationId, { clients: new Set(), nextLineIndex: 0 });
  }
  return streams.get(generationId);
}

function normalizeScanLine(stream, line) {
  // Accept string or object; always return { index, text }
  if (typeof line === "string") {
    const payload = { index: stream.nextLineIndex++, text: line };
    return payload;
  }

  const obj = line && typeof line === "object" ? line : {};
  const text = typeof obj.text === "string" ? obj.text : String(obj.text || "");
  let index = Number.isFinite(obj.index) ? Number(obj.index) : null;

  if (index === null) {
    index = stream.nextLineIndex++;
  } else {
    // keep stream counter ahead of any incoming indexes
    stream.nextLineIndex = Math.max(stream.nextLineIndex, index + 1);
  }

  return { ...obj, index, text };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export function addSseClient(generationId, res, { scanLines = [], status = "queued" } = {}) {
  const stream = ensureStream(generationId);
  stream.clients.add(res);

  // Replay stored scan lines on connect (and set nextLineIndex correctly)
  const lines = Array.isArray(scanLines) ? scanLines : [];
  for (const line of lines) {
    const payload =
      typeof line === "string"
        ? normalizeScanLine(stream, line)
        : normalizeScanLine(stream, line); // normalizes + advances counter
    writeEvent(res, EVENT_SCAN_LINE, payload);
  }

  // Send initial status (pass-through)
  writeEvent(res, EVENT_STATUS, { status: String(status || "") });

  res.on("close", () => {
    const s = streams.get(generationId);
    if (!s) return;
    s.clients.delete(res);
    if (s.clients.size === 0) streams.delete(generationId);
  });
}

export function sendSseEvent(generationId, event, data) {
  const stream = streams.get(generationId);
  if (!stream) return;

  // If a client write fails, drop it.
  for (const res of Array.from(stream.clients)) {
    const ok = writeEvent(res, event, data);
    if (!ok) stream.clients.delete(res);
  }

  if (stream.clients.size === 0) streams.delete(generationId);
}

export function sendScanLine(generationId, line) {
  const stream = ensureStream(generationId);
  const payload = normalizeScanLine(stream, line);
  sendSseEvent(generationId, EVENT_SCAN_LINE, payload);
}

export function sendStatus(generationId, status) {
  sendSseEvent(generationId, EVENT_STATUS, { status: String(status || "") });
}

export function sendDone(generationId, status = "done") {
  sendSseEvent(generationId, EVENT_DONE, { status: String(status || "") });
}
