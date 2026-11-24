// Analysis history, persisted in localStorage so it survives page refreshes.
// Every entry is a real model prediction returned by the API.
const KEY = "sentimentai.history.v1";
const MAX_ENTRIES = 2000;
const MAX_TEXT = 1200;

let entries = load();
const listeners = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((e) => e && e.label && e.ts) : [];
  } catch { return []; }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full: drop the oldest half and retry once.
    entries = entries.slice(0, Math.floor(entries.length / 2));
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* give up silently */ }
  }
  listeners.forEach((fn) => fn(entries));
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const history = {
  all: () => entries,
  get: (id) => entries.find((e) => e.id === id),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  addSingle(result) {
    const entry = {
      id: uid(), ts: Date.now(), source: "single",
      text: result.text.slice(0, MAX_TEXT), truncated: result.text.length > MAX_TEXT,
      label: result.label, confidence: result.confidence, probabilities: result.probabilities,
      keywords: (result.keywords || []).slice(0, 12), summary: result.summary, latency_ms: result.latency_ms,
      warnings: result.warnings || [],
    };
    entries = [entry, ...entries].slice(0, MAX_ENTRIES);
    persist();
    return entry;
  },

  addBatch(rows, filename) {
    const ts = Date.now();
    const items = rows.map((r, i) => ({
      id: uid(), ts: ts - i, source: "batch", file: filename,
      text: r.text.slice(0, 400), truncated: r.text.length > 400,
      label: r.label, confidence: r.confidence, probabilities: r.probabilities,
    }));
    entries = [...items, ...entries].slice(0, MAX_ENTRIES);
    persist();
    return Math.min(items.length, MAX_ENTRIES);
  },

  remove(id) { entries = entries.filter((e) => e.id !== id); persist(); },
  clear() { entries = []; persist(); },

  stats() {
    const s = { total: entries.length, positive: 0, negative: 0, neutral: 0, confSum: 0,
      conf: { positive: [0, 0], negative: [0, 0], neutral: [0, 0] } };
    for (const e of entries) {
      s[e.label]++; s.confSum += e.confidence;
      s.conf[e.label][0] += e.confidence; s.conf[e.label][1]++;
    }
    s.avgConfidence = s.total ? s.confSum / s.total : 0;
    return s;
  },
};
