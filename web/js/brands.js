// Tracked brands and their monitoring runs, persisted in localStorage.
import { api } from "./api.js";

const KEY = "sentimentai.brands.v1";
const MAX_BRANDS = 8;
const MAX_RUNS = 30;

export const SOURCE_META = {
  bluesky: { name: "Bluesky", color: "#1185fe" },
  mastodon: { name: "Mastodon", color: "#6364ff" },
  lemmy: { name: "Lemmy", color: "#00a67e" },
  hn: { name: "Hacker News", color: "#ff6600" },
  news: { name: "Google News", color: "#64748b" },
};
export const BRAND_COLORS = ["#5b4cf5", "#0ea5e9", "#f97316"];

let state = load();
const listeners = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.brands)) return s;
  } catch { /* ignore */ }
  return { brands: [], active: null };
}

function persist() {
  const trySave = () => localStorage.setItem(KEY, JSON.stringify(state));
  try { trySave(); } catch {
    // Storage full: keep only the summary of the oldest brands' last results.
    state.brands.slice(0, -1).forEach((b) => { if (b.last) b.last.mentions = b.last.mentions.slice(0, 50); });
    try { trySave(); } catch { /* give up */ }
  }
  listeners.forEach((fn) => fn(state));
}

const keyOf = (q) => q.trim().toLowerCase().replace(/\s+/g, " ");

export const brands = {
  all: () => state.brands,
  get: (key) => state.brands.find((b) => b.key === key),
  active: () => state.brands.find((b) => b.key === state.active) || state.brands[0] || null,
  setActive(key) { state.active = key; persist(); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  remove(key) {
    state.brands = state.brands.filter((b) => b.key !== key);
    if (state.active === key) state.active = state.brands[0]?.key || null;
    persist();
  },

  /** Create a brand entry without running a live check (e.g. reviews only). */
  ensure(query) {
    const key = keyOf(query);
    let b = state.brands.find((x) => x.key === key);
    if (!b) {
      b = { key, query: query.trim().replace(/\s+/g, " "), created: Date.now(), runs: [], sources: Object.keys(SOURCE_META), limit: 50 };
      state.brands = [b, ...state.brands].slice(0, MAX_BRANDS);
    }
    state.active = key;
    persist();
    return b;
  },

  /** Store imported reviews (analysed) for a brand. */
  setReviews(key, reviews) {
    const b = state.brands.find((x) => x.key === key);
    if (!b) return;
    b.reviews = reviews;
    persist();
  },

  /** Fetch + analyse a brand and record the run. Throws ApiError on failure. */
  async track(query, sources, limit = 50) {
    const res = await api.monitor(query, sources, limit);
    const key = keyOf(res.query);
    let b = state.brands.find((x) => x.key === key);
    if (!b) {
      b = { key, query: res.query, created: Date.now(), runs: [] };
      state.brands = [b, ...state.brands].slice(0, MAX_BRANDS);
    }
    b.sources = sources; b.limit = limit;
    const s = res.summary;
    b.runs = [...b.runs, { ts: Date.now(), total: s.total, counts: s.counts, net: s.net_score, perDay: s.mentions_per_day }].slice(-MAX_RUNS);
    b.last = res;
    state.active = key;
    persist();
    return b;
  },
};

/** Compare the two most recent runs of a brand. Returns alert objects. */
export function runAlerts(b) {
  const runs = b?.runs || [];
  if (runs.length < 2) return [];
  const [prev, cur] = runs.slice(-2);
  if (prev.total < 10 || cur.total < 10) return [];
  const negP = prev.counts.negative / prev.total, negC = cur.counts.negative / cur.total;
  const out = [];
  const when = new Date(prev.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (negC - negP >= 0.10) out.push({ type: "alert", text: `Negative share jumped from ${Math.round(negP * 100)}% to ${Math.round(negC * 100)}% since your last check (${when}).` });
  else if (negP - negC >= 0.10) out.push({ type: "positive", text: `Negative share dropped from ${Math.round(negP * 100)}% to ${Math.round(negC * 100)}% since your last check (${when}).` });
  const dNet = cur.net - prev.net;
  if (Math.abs(dNet) >= 15) out.push({ type: dNet > 0 ? "positive" : "negative", text: `Net sentiment moved ${dNet > 0 ? "up" : "down"} ${Math.abs(dNet)} points (${prev.net > 0 ? "+" : ""}${prev.net} → ${cur.net > 0 ? "+" : ""}${cur.net}) since ${when}.` });
  return out;
}
