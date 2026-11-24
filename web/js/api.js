// Thin client for the FastAPI backend.
export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// Track long-running requests so we can warn before the user closes the tab
// and loses work that is still being processed.
let inFlight = 0;
addEventListener("beforeunload", (e) => { if (inFlight > 0) { e.preventDefault(); e.returnValue = ""; } });

async function request(path, opts = {}) {
  let res;
  inFlight++;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError("Can't reach the SentimentAI server. Check your connection and try again.", 0, "offline");
  } finally {
    inFlight--;
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    let msg = body?.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
    if (!msg) {
      msg = res.status === 413 ? "That file is too large to upload (4 MB maximum)."
        : res.status >= 500 ? "The server ran into a problem. Please try again in a moment."
        : `Request failed (${res.status}).`;
    }
    throw new ApiError(msg, res.status, body?.code);
  }
  return body;
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const form = (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null && v !== "") fd.append(k, v);
  return { method: "POST", body: fd };
};

export const api = {
  health: () => request("/api/health"),
  model: () => request("/api/model"),
  analyze: (text) => request("/api/analyze", json({ text })),
  sources: () => request("/api/sources"),
  monitor: (query, sources, limit = 50) => request("/api/monitor", json({ query, sources, limit })),
  reviewsParse: (platform, { file, text }) => request("/api/reviews/parse", form(file ? { platform, file } : { platform, text: text || "" })),
  reviewsAnalyze: (reviews) => request("/api/reviews/analyze", json({ reviews })),
  batchPreview: (file) => request("/api/batch/preview", form({ file })),
  batch: (file, column) => request("/api/batch", form({ file, column })),
};
