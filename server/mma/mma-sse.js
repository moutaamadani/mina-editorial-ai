// ./server/mma/mma-sse.js Part 4: Tiny in-memory SSE hub for MMA streams
// Part 4.1: Manages per-generation subscribers and forwards pipeline events.
const clients = new Map();

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function addSseClient(generationId, res, { scanLines = [], status = "queued" } = {}) {
  if (!clients.has(generationId)) clients.set(generationId, new Set());
  clients.get(generationId).add(res);

  // Replay stored scan lines on connect
  (scanLines || []).forEach((line, idx) => {
    const payload = typeof line === "string" ? { index: idx, text: line } : line;
    writeEvent(res, "scan_line", payload);
  });
  writeEvent(res, "status", { status });

  res.on("close", () => {
    const set = clients.get(generationId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(generationId);
  });
}

export function sendSseEvent(generationId, event, data) {
  const set = clients.get(generationId);
  if (!set) return;
  set.forEach((res) => writeEvent(res, event, data));
}

export function sendScanLine(generationId, line) {
  const payload = typeof line === "string" ? { text: line } : line;
  sendSseEvent(generationId, "scan_line", payload);
}

export function sendStatus(generationId, status) {
  sendSseEvent(generationId, "status", { status });
}

export function sendDone(generationId, status = "done") {
  sendSseEvent(generationId, "done", { status });
}
