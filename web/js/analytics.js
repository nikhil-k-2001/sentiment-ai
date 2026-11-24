// Dashboard widgets + Analytics view. Everything here is derived from the
// locally stored history of real model predictions.
import { donut, hbars, histogram, trend } from "./charts.js";
import { history } from "./store.js";
import {
  $, COLORS, LABELS, SOFT, badge, cap, confCell, confirmDialog, debounce, download, esc, fmt, icon, pagerHTML, pct, stamp, timeAgo, toCSV, toast,
} from "./utils.js";

const PER_PAGE = 25;
let filter = "all", query = "", page = 1;
let openEntry = () => {};

export function initAnalytics({ onOpen }) {
  openEntry = onOpen;
  $("#an-search").addEventListener("input", debounce((e) => { query = e.target.value.trim().toLowerCase(); page = 1; renderTable(); }, 150));
  $("#an-filter").addEventListener("click", (e) => {
    const c = e.target.closest("[data-filter]"); if (!c) return;
    filter = c.dataset.filter; page = 1; renderTable();
  });
  $("#an-pager").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b && !b.disabled) { page = +b.dataset.page; renderTable(); } });
  $("#an-table").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); history.remove(del.dataset.del); toast("Entry removed"); return; }
    const row = e.target.closest("[data-open]");
    if (row) openEntry(row.dataset.open);
  });
  $("#an-clear").addEventListener("click", clearAll);
  $("#hist-clear").addEventListener("click", clearAll);
  $("#an-export").addEventListener("click", exportHistory);
  // Charts are drawn at their real pixel width, so redraw when it changes.
  let lastW = 0;
  new ResizeObserver(debounce(() => {
    const w = $("#an-trend").clientWidth;
    if (w && Math.abs(w - lastW) > 8 && !$('[data-view="analytics"]').hidden) { lastW = w; renderAnalytics(); }
  }, 150)).observe($("#an-trend"));

  $("#dash-recent").addEventListener("click", (e) => { const r = e.target.closest("[data-open]"); if (r) openEntry(r.dataset.open); });
  $("#hist-list").addEventListener("click", (e) => { const r = e.target.closest("[data-open]"); if (r) openEntry(r.dataset.open); });
  $("#hist-search").addEventListener("input", debounce(() => renderHistoryPanel(), 120));
}

export async function clearAll() {
  if (!history.all().length) { toast("History is already empty", { type: "info" }); return; }
  const ok = await confirmDialog({
    title: "Clear analysis history?",
    body: `This permanently deletes ${fmt(history.all().length)} saved analyses from this browser. Model files and evaluation metrics are not affected.`,
    ok: "Clear history",
  });
  if (ok) { history.clear(); toast("History cleared"); }
}

function exportHistory() {
  const all = history.all();
  if (!all.length) { toast("Nothing to export", { type: "error", body: "Analyse some text first." }); return; }
  const csv = toCSV(
    ["timestamp", "source", "text", "sentiment", "confidence", "p_negative", "p_neutral", "p_positive"],
    all.map((e) => [new Date(e.ts).toISOString(), e.source, e.text, e.label, e.confidence.toFixed(4),
      e.probabilities.negative.toFixed(4), e.probabilities.neutral.toFixed(4), e.probabilities.positive.toFixed(4)]),
  );
  download(`sentimentai-history-${stamp()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  toast("History exported", { body: `${fmt(all.length)} records saved as CSV.` });
}

/* ----------------------------------------------------------- stat cards */
function statCards(s, { five = false } = {}) {
  const t = s.total || 1;
  const cards = [
    { k: "Total analysed", v: fmt(s.total), sub: s.total ? "texts in history" : "nothing yet", ic: "activity" },
    ...LABELS.map((l) => ({ k: cap(l), v: fmt(s[l]), sub: s.total ? `${pct(s[l] / t, 1)} of predictions` : "–", ic: { positive: "smile", negative: "frown", neutral: "meh" }[l], c: COLORS[l], soft: SOFT[l], w: s[l] / t })),
  ];
  if (five) cards.push({ k: "Avg. confidence", v: s.total ? pct(s.avgConfidence, 1) : "–", sub: "mean top-class probability", ic: "target" });
  return cards.map((c) => `<div class="card stat" style="${c.c ? `--c:${c.c};--soft:${c.soft}` : ""}">
    <div class="stat-top"><span>${c.k}</span><span class="stat-ico">${icon(c.ic)}</span></div>
    <div class="stat-val">${c.v}</div><div class="stat-sub">${c.sub}</div>
    ${c.w != null && s.total ? `<span class="stat-bar" style="width:${c.w * 100}%"></span>` : ""}</div>`).join("");
}

const emptyChart = (msg) => `<div class="empty compact bare"><div class="empty-art">${icon("chart")}</div><h3>No data yet</h3><p>${msg}</p></div>`;

/* -------------------------------------------------------------- dashboard */
export function renderDashboard() {
  const all = history.all(), s = history.stats();
  $("#dash-stats").innerHTML = statCards(s);
  $("#dash-recent").innerHTML = all.length
    ? `<div class="hist-list">${all.slice(0, 6).map(histItem).join("")}</div>`
    : `<div class="empty compact bare"><div class="empty-art">${icon("clock")}</div><h3>No analyses yet</h3><p>Results you analyse will be listed here and kept after refresh.</p></div>`;
  if (all.length) donut($("#dash-donut"), s); else $("#dash-donut").innerHTML = emptyChart("Analyse a few texts to see the sentiment mix.");
}

function histItem(e) {
  return `<button class="hist-item" data-open="${e.id}">
    <p>${esc(e.text)}</p>
    <div class="hist-meta">${badge(e.label)}<span>${pct(e.confidence)} · ${e.source === "batch" ? "batch · " : ""}${timeAgo(e.ts)}</span></div></button>`;
}

export function renderHistoryPanel(currentId) {
  const q = $("#hist-search").value.trim().toLowerCase();
  const items = history.all().filter((e) => !q || e.text.toLowerCase().includes(q)).slice(0, 100);
  $("#hist-list").innerHTML = items.length
    ? items.map(histItem).join("")
    : `<div class="empty compact bare"><div class="empty-art">${icon(q ? "search" : "clock")}</div><h3>${q ? "No matches" : "No history yet"}</h3><p>${q ? "Try another search." : "Each analysis is saved here automatically."}</p></div>`;
  if (currentId) $(`#hist-list [data-open="${currentId}"]`)?.classList.add("current");
}

/* -------------------------------------------------------------- analytics */
export function renderAnalytics() {
  const all = history.all(), s = history.stats();
  $("#an-stats").innerHTML = statCards(s, { five: true });
  if (!all.length) {
    const m = "Analyse text or run a batch to populate this chart.";
    ["#an-donut", "#an-trend", "#an-conf", "#an-hist"].forEach((id) => ($(id).innerHTML = emptyChart(m)));
    $("#an-trend-sub").textContent = "";
  } else {
    donut($("#an-donut"), s);
    $("#an-trend-sub").textContent = trend($("#an-trend"), all);
    hbars($("#an-conf"), LABELS.map((l) => {
      const [sum, n] = s.conf[l];
      return { label: cap(l), value: n ? sum / n : 0, color: COLORS[l], sub: n ? `${fmt(n)} predictions` : "No predictions" };
    }));
    histogram($("#an-hist"), all);
  }
  renderTable();
}

function renderTable() {
  const all = history.all();
  const counts = { all: all.length }; LABELS.forEach((l) => (counts[l] = all.filter((e) => e.label === l).length));
  $("#an-filter").innerHTML = ["all", ...LABELS].map((k) => `<button class="chip ${filter === k ? "active" : ""}" data-filter="${k}">${k === "all" ? "All" : cap(k)}<span class="chip-count">${fmt(counts[k])}</span></button>`).join("");
  const rows = all.filter((e) => (filter === "all" || e.label === filter) && (!query || e.text.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE)); page = Math.min(page, pages);
  $("#an-count").textContent = `${fmt(all.length)} saved`;
  $("#an-table tbody").innerHTML = rows.length ? rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map((e) => `
    <tr class="row-btn" data-open="${e.id}" data-tip="Open full report">
      <td class="txt"><span>${esc(e.text)}</span></td><td>${badge(e.label)}</td>
      <td class="conf-td">${confCell(e.label, e.confidence)}</td>
      <td><span class="badge plain">${e.source === "batch" ? "Batch" : "Analyzer"}</span></td>
      <td class="when">${timeAgo(e.ts)}</td>
      <td><button class="icon-btn sm" data-del="${e.id}" aria-label="Delete entry" data-tip="Delete entry">${icon("trash")}</button></td></tr>`).join("")
    : `<tr><td colspan="6"><div class="empty compact bare"><div class="empty-art">${icon(all.length ? "search" : "clock")}</div><h3>${all.length ? "No matching analyses" : "No history yet"}</h3><p>${all.length ? "Try a different search or filter." : "Analyses you run are stored here, in this browser only."}</p></div></td></tr>`;
  $("#an-pager").innerHTML = pagerHTML(page, pages, rows.length, PER_PAGE);
}
