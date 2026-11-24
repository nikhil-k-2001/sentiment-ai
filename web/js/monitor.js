// Brand Monitor view: track a brand across live sources and see what people feel.
import { BRAND_COLORS, SOURCE_META, brands, runAlerts } from "./brands.js";
import { stackedRows, trend } from "./charts.js";
import { initReviews, loadSamples, renderReviewsTab, resetReviewFeed } from "./reviews.js";
import {
  $, COLORS, LABELS, SOFT, badge, cap, confirmDialog, debounce, download, esc, fmt, icon, pagerHTML, pct, stamp, timeAgo, toCSV, toast,
} from "./utils.js";

const PER_PAGE = 20;
// Word lists are shown on screen during demos; mask profanity (display only).
const PROFANE = new Set(["fuck", "fucking", "fucked", "shit", "shitty", "bullshit", "bitch", "asshole", "cunt", "dick", "crap", "damn"]);
const maskWord = (w) => (PROFANE.has(w) ? w[0] + "*".repeat(w.length - 2) + w.at(-1) : w);
const EXAMPLES = ["Netflix", "Spotify", "Tesla", "Duolingo", "OpenAI"];
let selected = new Set(Object.keys(SOURCE_META));
let busy = false;
let feed = { filter: "all", source: "all", sort: "newest", q: "", page: 1 };
let onAnalyze = () => {};
let ready = true;
let tab = "mentions";

export function setMonitorReady(ok) { ready = ok; $("#mon-run").disabled = !ok || busy; }

export function initMonitor({ analyze }) {
  onAnalyze = analyze;
  initReviews($("#mon-reviews"), { analyze });
  $("#mon-head").addEventListener("click", onResultsClick);
  $("#mon-load-samples").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await loadSamples(); tab = "reviews"; resetReviewFeed(); render(); toast("Sample reviews loaded", { body: "40 synthetic Glassdoor & AmbitionBox reviews for a fictional company." }); }
    catch (err) { toast("Couldn't load samples", { type: "error", body: err.message }); }
    finally { btn.disabled = false; }
  });
  renderSourceChips();
  $("#mon-examples").innerHTML = EXAMPLES.map((e) => `<button class="chip" data-example="${e}">${e}</button>`).join("");

  $("#mon-form").addEventListener("submit", (e) => { e.preventDefault(); run($("#mon-query").value); });
  $("#mon-sources").addEventListener("click", (e) => {
    const c = e.target.closest("[data-src]"); if (!c) return;
    const k = c.dataset.src;
    if (selected.has(k) && selected.size === 1) { toast("Keep at least one source", { type: "info" }); return; }
    selected.has(k) ? selected.delete(k) : selected.add(k);
    renderSourceChips();
  });
  document.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-example]");
    if (ex && ex.closest('[data-view="monitor"]')) { $("#mon-query").value = ex.dataset.example; run(ex.dataset.example); }
  });
  $("#mon-brands").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-remove]");
    if (del) {
      e.stopPropagation();
      const b = brands.get(del.dataset.remove);
      if (await confirmDialog({ title: `Stop tracking “${b.query}”?`, body: "Its saved mentions and run history will be deleted from this browser.", ok: "Remove" })) {
        brands.remove(b.key); toast(`Stopped tracking ${b.query}`);
      }
      return;
    }
    const chip = e.target.closest("[data-brand]");
    if (chip) { feed = { ...feed, page: 1 }; resetReviewFeed(); brands.setActive(chip.dataset.brand); }
  });
  $("#mon-results").addEventListener("click", onResultsClick);
  $("#mon-results").addEventListener("input", debounce((e) => {
    if (e.target.id === "feed-search") { feed.q = e.target.value.trim().toLowerCase(); feed.page = 1; renderFeed(); }
  }, 150));
  $("#mon-results").addEventListener("change", (e) => {
    if (e.target.id === "feed-source") { feed.source = e.target.value; feed.page = 1; renderFeed(); }
    if (e.target.id === "feed-sort") { feed.sort = e.target.value; feed.page = 1; renderFeed(); }
  });
  let lastW = 0;
  new ResizeObserver(debounce(() => {
    const el = $("#mon-trend"); const w = el?.clientWidth || 0;
    if (w && Math.abs(w - lastW) > 8 && !$('[data-view="monitor"]').hidden) { lastW = w; drawTrend(); }
  }, 150)).observe($("#mon-results"));
}

function renderSourceChips() {
  $("#mon-sources").innerHTML = Object.entries(SOURCE_META).map(([k, m]) =>
    `<button type="button" class="chip src-chip ${selected.has(k) ? "on" : ""}" data-src="${k}" aria-pressed="${selected.has(k)}" style="--sc:${m.color}"><span class="src-dot"></span>${m.name}</button>`).join("");
}

export async function run(query, sources) {
  query = (query || "").trim().replace(/\s+/g, " ");
  if (busy) return;
  if (query.length < 2 || !/[A-Za-z]/.test(query)) { toast("Enter a brand to track", { type: "error", body: "At least 2 characters, e.g. “Spotify”." }); $("#mon-query").focus(); return; }
  if (!ready) { toast("Model not ready", { type: "error", body: "Train the model first." }); return; }
  const srcs = sources || [...selected];
  busy = true;
  const btn = $("#mon-run");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>Listening…</span>`;
  renderLoading(query, srcs);
  try {
    const b = await brands.track(query, srcs, +$("#mon-limit").value || 50);
    feed = { filter: "all", source: "all", sort: "newest", q: "", page: 1 };
    const s = b.last.summary;
    const failed = b.last.sources.filter((x) => !x.ok);
    if (!s.total) toast(`No mentions found for “${b.query}”`, { type: "info", body: "Try a more widely discussed name or enable more sources.", ms: 4500 });
    else toast(`${fmt(s.total)} mentions analysed`, { body: failed.length ? `${failed.map((f) => f.name).join(", ")} unavailable right now.` : `Net sentiment ${s.net_score > 0 ? "+" : ""}${s.net_score}.` });
    $("#mon-query").value = "";
  } catch (err) {
    toast("Couldn't monitor that brand", { type: "error", body: err.message, ms: 6000 });
    render();
  } finally {
    busy = false;
    btn.disabled = !ready; btn.innerHTML = `${icon("radar")}<span>Track brand</span>`;
  }
}

/* ------------------------------------------------------------------ render */
export function render() {
  const all = brands.all(), b = brands.active();
  $("#mon-brands").innerHTML = all.map((x) => `<div class="brand-chip ${b && x.key === b.key ? "active" : ""}" data-brand="${x.key}" role="button" tabindex="0">
      <span class="bc-net ${x.runs.at(-1)?.net > 0 ? "pos" : x.runs.at(-1)?.net < 0 ? "neg" : ""}">${x.runs.at(-1) ? (x.runs.at(-1).net > 0 ? "+" : "") + x.runs.at(-1).net : "–"}</span>
      <span>${esc(x.query)}</span><button class="bc-x" data-remove="${x.key}" aria-label="Stop tracking ${esc(x.query)}" data-tip="Stop tracking">${icon("x")}</button></div>`).join("");
  $("#mon-brands-wrap").hidden = !all.length;
  $("#mon-empty").hidden = !!b;
  if (!b) { ["#mon-head", "#mon-results", "#mon-reviews"].forEach((id) => ($(id).hidden = true)); return; }
  renderHead(b);
  $("#mon-results").hidden = tab !== "mentions";
  $("#mon-reviews").hidden = tab !== "reviews";
  if (tab === "mentions") renderResults(b); else renderReviewsTab(b);
}

function renderHead(b) {
  const r = b.last, nRev = b.reviews?.items?.length || 0;
  const okCount = r ? r.sources.filter((x) => x.ok && x.count).length : 0;
  const sub = tab === "reviews"
    ? (nRev ? `${fmt(nRev)} imported reviews · ${b.reviews.imports.length} import${b.reviews.imports.length === 1 ? "" : "s"}` : "No reviews imported yet")
    : (r ? `Updated ${timeAgo(new Date(r.fetched_at).getTime())} · ${fmt(r.summary.total)} mentions from ${okCount} source${okCount === 1 ? "" : "s"} · ${b.runs.length} check${b.runs.length === 1 ? "" : "s"} so far` : "Public mentions not checked yet");
  $("#mon-head").hidden = false;
  $("#mon-head").innerHTML = `<div class="mon-head">
    <div><h2>${esc(b.query)}</h2><p class="muted-sm">${sub}</p></div>
    ${tab === "mentions" ? `<div class="row-gap">
      <button class="btn btn-ghost btn-sm" data-act="export" ${r?.summary.total ? "" : "disabled"}>${icon("download")}Export CSV</button>
      <button class="btn btn-secondary btn-sm" data-act="refresh" data-tip="Fetch the latest mentions again">${icon("refresh")}${r ? "Refresh" : "Check now"}</button></div>` : ""}
  </div>
  <div class="tabs" role="tablist">
    <button class="tab ${tab === "mentions" ? "on" : ""}" data-tab="mentions" role="tab" aria-selected="${tab === "mentions"}">${icon("globe")}Public mentions${r ? `<span class="chip-count">${fmt(r.summary.total)}</span>` : ""}</button>
    <button class="tab ${tab === "reviews" ? "on" : ""}" data-tab="reviews" role="tab" aria-selected="${tab === "reviews"}">${icon("users")}Employee reviews${nRev ? `<span class="chip-count">${fmt(nRev)}</span>` : ""}</button>
  </div>`;
}

function renderLoading(query, srcs) {
  tab = "mentions";
  $("#mon-empty").hidden = true;
  $("#mon-head").hidden = true;
  $("#mon-reviews").hidden = true;
  $("#mon-results").hidden = false;
  $("#mon-results").innerHTML = `<div class="card listen-card">
    <div class="listen-radar">${icon("radar")}</div>
    <h3>Listening for “${esc(query)}”…</h3>
    <p class="muted-sm">Fetching recent public mentions and running each one through the sentiment model.</p>
    <div class="listen-sources">${srcs.map((k) => `<span class="chip src-chip on" style="--sc:${SOURCE_META[k].color}"><span class="spinner xs"></span>${SOURCE_META[k].name}</span>`).join("")}</div></div>`;
}

function kpi(k, v, sub, ic, style = "", tip = "") {
  return `<div class="card stat" style="${style}" ${tip ? `data-tip="${esc(tip)}"` : ""}><div class="stat-top"><span>${k}</span><span class="stat-ico">${icon(ic)}</span></div>
    <div class="stat-val">${v}</div><div class="stat-sub">${sub}</div></div>`;
}

function renderResults(b) {
  if (!b.last) {
    $("#mon-results").innerHTML = `<div class="card empty"><div class="empty-art">${icon("globe")}</div><h3>Public mentions not checked yet</h3>
      <p>Fetch recent mentions of “${esc(b.query)}” from Bluesky, Mastodon, Lemmy, Hacker News and Google News.</p>
      <button class="btn btn-primary" data-act="refresh" style="margin-top:8px">${icon("radar")}Check public mentions</button></div>`;
    return;
  }
  const r = b.last, s = r.summary, n = s.total || 1;
  const alerts = [...runAlerts(b), ...s.insights];
  const okSources = r.sources.filter((x) => x.ok);
  const netCls = s.net_score > 0 ? "t-pos" : s.net_score < 0 ? "t-neg" : "";
  const typeIcon = { alert: "bell", negative: "frown", positive: "smile", info: "info" };

  $("#mon-results").innerHTML = `
  ${!s.total ? `<div class="card empty"><div class="empty-art">${icon("search")}</div><h3>No mentions found</h3>
    <p>None of the selected sources returned recent posts that mention “${esc(b.query)}”. Try a more widely discussed name, a different spelling, or enable more sources.</p></div>` : `

  ${alerts.length ? `<div class="card insights"><div class="card-head"><h3>${icon("bell")} Alerts & insights</h3><span class="muted-sm">rule-based, from the numbers below</span></div>
    <ul>${alerts.map((a) => `<li class="ins ${a.type}"><span class="ins-ico">${icon(typeIcon[a.type] || "info")}</span><span>${esc(a.text)}${a.mention_id ? ` <button class="link-btn" data-show="${esc(a.mention_id)}">Show</button>` : ""}</span></li>`).join("")}</ul></div>` : ""}

  <div class="stat-grid five">
    ${kpi("Mentions", fmt(s.total), s.mentions_per_day != null ? `≈ ${fmt(Math.round(s.mentions_per_day))} / day across sources` : "", "globe", "", "Mentions per day is estimated from the time span the fetched mentions cover in each source.")}
    ${kpi("Net sentiment", `<span class="${netCls}">${s.net_score > 0 ? "+" : ""}${s.net_score}</span>`, "% positive − % negative", "scale", "", "Ranges from −100 (all negative) to +100 (all positive).")}
    ${LABELS.filter((l) => l !== "neutral").map((l) => kpi(cap(l), fmt(s.counts[l]), `${pct(s.counts[l] / n, 1)} of mentions`, l === "positive" ? "smile" : "frown", `--c:${COLORS[l]};--soft:${SOFT[l]}`)).join("")}
    ${kpi("Engagement", fmt(s.engagement), "likes, reposts, replies & points", "heart")}
  </div>

  <div class="grid-1-2">
    <div class="card"><div class="card-head"><h3>Sentiment by source</h3><span class="muted-sm">${fmt(s.counts.neutral)} neutral overall</span></div><div id="mon-sources-chart"></div></div>
    <div class="card"><div class="card-head"><h3>Mention volume</h3><span class="muted-sm" id="mon-trend-sub"></span></div><div id="mon-trend"></div></div>
  </div>

  <div class="grid-1-1">
    ${["positive", "negative"].map((l) => `<div class="card"><div class="card-head"><h3>What stands out in ${l} mentions</h3><span class="muted-sm" data-tip="Words that appear much more often in ${l} mentions than in the rest. The number is how many ${l} mentions contain the word.">over-represented words ${icon("info")}</span></div>
      ${s.keywords[l].length ? `<div class="wordcloud">${s.keywords[l].map(([w, c], i) => `<button class="word ${l}" style="--s:${(1 - i / (s.keywords[l].length * 1.4)).toFixed(2)}" data-word="${esc(w)}" data-tip="In ${c} ${l} mentions — click to filter">${esc(maskWord(w))}<small>${c}</small></button>`).join("")}</div>`
        : `<p class="no-drivers">No word stands out — ${l} mentions don't share a common theme.</p>`}</div>`).join("")}
  </div>

  <div class="card" id="mon-feed-card">
    <div class="card-head"><h3>Mentions</h3><span class="muted-sm" id="feed-count"></span></div>
    <div class="table-toolbar">
      <div class="search-wrap">${icon("search")}<input id="feed-search" type="search" placeholder="Search mentions…" aria-label="Search mentions" value="${esc(feed.q)}" /></div>
      <div class="chips" id="feed-filter"></div>
      <div class="row-gap feed-selects">
        <select id="feed-source" aria-label="Filter by source"><option value="all">All sources</option>${Object.keys(s.by_source).map((k) => `<option value="${k}" ${feed.source === k ? "selected" : ""}>${SOURCE_META[k].name}</option>`).join("")}</select>
        <select id="feed-sort" aria-label="Sort mentions">${[["newest", "Newest"], ["engagement", "Most engagement"], ["negative", "Most negative"], ["positive", "Most positive"]].map(([v, t]) => `<option value="${v}" ${feed.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
      </div>
    </div>
    <div id="feed-list" class="feed"></div>
    <div class="pager" id="feed-pager"></div>
  </div>`}

  <div class="source-status">${r.sources.map((x) => `<span class="ss ${x.ok ? "" : "err"}" style="--sc:${SOURCE_META[x.source].color}" data-tip="${x.ok ? `${x.count} fetched${x.filtered ? `, ${x.filtered} repetitive posts filtered` : ""}${x.cached ? " (cached, < 10 min old)" : ""}` : esc(x.error)}"><span class="src-dot"></span>${esc(x.name)} ${x.ok ? x.count - (x.filtered || 0) : "unavailable"}</span>`).join("")}
    ${s.filtered_repetitive ? `<span class="ss" data-tip="Max 3 mentions per account per source, so bots and auto-posters can't dominate the numbers.">${icon("shield")} ${fmt(s.filtered_repetitive)} repetitive posts filtered</span>` : ""}
    <span class="ss-note">Sentiment is predicted per mention by the model — aggregates are more reliable than any single mention.</span></div>`;

  if (!s.total) return;
  stackedRows($("#mon-sources-chart"), Object.entries(s.by_source).map(([k, v]) => ({
    label: SOURCE_META[k].name, color: SOURCE_META[k].color, counts: v.counts,
    sub: `${v.total} · net <b class="${v.net_score > 0 ? "t-pos" : v.net_score < 0 ? "t-neg" : ""}">${v.net_score > 0 ? "+" : ""}${v.net_score}</b>`,
  })));
  drawTrend();
  renderFeed();
}

function drawTrend() {
  const b = brands.active(); if (!b?.last?.summary.total || !$("#mon-trend")) return;
  const entries = b.last.mentions.filter((m) => m.ts).map((m) => ({ ts: m.ts * 1000, label: m.label }));
  $("#mon-trend-sub").textContent = trend($("#mon-trend"), entries);
}

function feedRows() {
  const b = brands.active(); if (!b?.last) return [];
  let rows = b.last.mentions.filter((m) =>
    (feed.filter === "all" || m.label === feed.filter) && (feed.source === "all" || m.source === feed.source)
    && (!feed.q || m.text.toLowerCase().includes(feed.q) || (m.author || "").toLowerCase().includes(feed.q)));
  const by = {
    newest: (a, c) => (c.ts || 0) - (a.ts || 0),
    engagement: (a, c) => c.engagement - a.engagement,
    negative: (a, c) => c.probabilities.negative - a.probabilities.negative,
    positive: (a, c) => c.probabilities.positive - a.probabilities.positive,
  }[feed.sort];
  return [...rows].sort(by);
}

function renderFeed() {
  const b = brands.active(); if (!b?.last || !$("#feed-list")) return;
  const all = b.last.mentions;
  const counts = { all: all.length }; LABELS.forEach((l) => (counts[l] = all.filter((m) => m.label === l).length));
  $("#feed-filter").innerHTML = ["all", ...LABELS].map((k) => `<button class="chip ${feed.filter === k ? "active" : ""}" data-ffilter="${k}">${k === "all" ? "All" : cap(k)}<span class="chip-count">${counts[k]}</span></button>`).join("");
  const rows = feedRows();
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); feed.page = Math.min(feed.page, pages);
  $("#feed-count").textContent = `${fmt(rows.length)} shown`;
  $("#feed-list").innerHTML = rows.length ? rows.slice((feed.page - 1) * PER_PAGE, feed.page * PER_PAGE).map(mentionCard).join("")
    : `<div class="empty compact bare"><div class="empty-art">${icon("search")}</div><h3>No matching mentions</h3><p>Try another filter or search term.</p></div>`;
  $("#feed-pager").innerHTML = pagerHTML(feed.page, pages, rows.length, PER_PAGE);
}

function mentionCard(m) {
  const meta = SOURCE_META[m.source];
  return `<article class="mention" id="m-${cssId(m.id)}" style="--sc:${meta.color}">
    <div class="mention-top"><span class="src-pill"><span class="src-dot"></span>${meta.name}</span>
      <span class="mention-author">${esc(m.author || "unknown")}</span><span class="dotsep">·</span><span class="muted-sm">${m.ts ? timeAgo(m.ts * 1000) : "date unknown"}</span>
      ${m.engagement ? `<span class="muted-sm eng" data-tip="Likes, reposts, replies or points">${icon("heart")}${fmt(m.engagement)}</span>` : ""}
      <span class="mention-badge">${badge(m.label)}<small data-tip="Neg ${pct(m.probabilities.negative)} · Neu ${pct(m.probabilities.neutral)} · Pos ${pct(m.probabilities.positive)}">${pct(m.confidence)}</small></span></div>
    <p class="mention-text">${m.title ? `<b>${esc(m.title)}</b> ` : ""}${esc(m.title && m.text.startsWith(m.title) ? m.text.slice(m.title.length) : m.text)}</p>
    <div class="mention-actions">
      ${m.url ? `<a class="btn btn-ghost btn-xs" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${icon("external")}Open original</a>` : ""}
      <button class="btn btn-ghost btn-xs" data-analyze="${esc(m.id)}" data-tip="Open in the Analyzer to see which words drove the prediction">${icon("sparkles")}Explain prediction</button>
    </div></article>`;
}

const cssId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

async function onResultsClick(e) {
  const b = brands.active(); if (!b) return;
  const tb = e.target.closest("[data-tab]");
  if (tb) { tab = tb.dataset.tab; return render(); }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "refresh") return run(b.query, b.sources);
  if (act === "export") return b.last && exportCSV(b);
  const f = e.target.closest("[data-ffilter]");
  if (f) { feed.filter = f.dataset.ffilter; feed.page = 1; return renderFeed(); }
  const p = e.target.closest("#feed-pager [data-page]");
  if (p && !p.disabled) { feed.page = +p.dataset.page; renderFeed(); return $("#mon-feed-card").scrollIntoView({ behavior: "smooth" }); }
  const w = e.target.closest("[data-word]");
  if (w) {
    feed = { ...feed, q: w.dataset.word, filter: w.classList.contains("positive") ? "positive" : "negative", page: 1 };
    $("#feed-search").value = w.dataset.word; renderFeed();
    return $("#mon-feed-card").scrollIntoView({ behavior: "smooth" });
  }
  const show = e.target.closest("[data-show]");
  if (show) {
    feed = { filter: "all", source: "all", sort: "engagement", q: "", page: 1 };
    $("#feed-search").value = ""; $("#feed-sort").value = "engagement"; $("#feed-source").value = "all"; renderFeed();
    const el = document.getElementById(`m-${cssId(show.dataset.show)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" }); el?.classList.add("flash");
    return;
  }
  const an = e.target.closest("[data-analyze]");
  if (an) { const m = b.last.mentions.find((x) => x.id === an.dataset.analyze); if (m) onAnalyze(m.text); }
}

function exportCSV(b) {
  const rows = feedRows();
  const csv = toCSV(["source", "published_at", "author", "text", "url", "engagement", "sentiment", "confidence", "p_negative", "p_neutral", "p_positive"],
    rows.map((m) => [SOURCE_META[m.source].name, m.published_at, m.author, m.text, m.url, m.engagement, m.label, m.confidence, m.probabilities.negative, m.probabilities.neutral, m.probabilities.positive]));
  download(`${b.query.replace(/\W+/g, "-").toLowerCase()}-mentions-${stamp()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  toast("Mentions exported", { body: `${fmt(rows.length)} rows${feed.filter !== "all" || feed.source !== "all" || feed.q ? " (filtered)" : ""}.` });
}

export { BRAND_COLORS };
