// Thin client for the FastAPI backend.
export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError("Can't reach the SentimentAI server. Is it still running?", 0, "offline");
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    let msg = body?.detail;
    if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, body?.code);
  }
  return body;
}

export const api = {
  health: () => request("/api/health"),
  model: () => request("/api/model"),
  analyze: (text) => request("/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  }),
  sources: () => request("/api/sources"),
  monitor: (query, sources, limit = 50) => request("/api/monitor", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, sources, limit }),
  }),
  reviewsParse: (platform, { file, text }) => {
    const fd = new FormData();
    fd.append("platform", platform);
    if (file) fd.append("file", file); else fd.append("text", text || "");
    return request("/api/reviews/parse", { method: "POST", body: fd });
  },
  reviewsAnalyze: (reviews) => request("/api/reviews/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviews }),
  }),
  batch: (file, column) => {
    const fd = new FormData();
    fd.append("file", file);
    if (column) fd.append("column", column);
    return request("/api/batch", { method: "POST", body: fd });
  },
};
