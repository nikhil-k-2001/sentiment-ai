// Customer Feedback (batch CSV) workflow:
// upload → preview & confirm column → analyse → key findings → every row.
import { api } from "./api.js";
import { MODEL_METHOD, chips, downloadReport, fmtDate, quotes, sentimentBar } from "./report.js";
import { history } from "./store.js";
import {
  $, COLORS, LABELS, SOFT, badge, cap, confCell, debounce, download, esc, fmt, hydrateIcons, icon, pagerHTML, pct, stamp, toCSV, toast,
} from "./utils.js";

const PER_PAGE = 50;
const MAX_BYTES = 4 * 1024 * 1024;
let file = null;
let preview = null;
let column = null;
let result = null;
let analysedAt = null;
let filter = "all", query = "", page = 1;
let busy = false;
let ready = true;

export function initBatch() {
  const dz = $("#dropzone"), fi = $("#file-input");
  fi.addEventListener("change", () => fi.files[0] && pick(fi.files[0]));
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) pick(f); });
  $("#batch-sample").addEventListener("click", loadSample);

  $("#batch-preview").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='run']")) run();
    if (e.target.closest("[data-act='reset']")) reset();
    if (e.target.closest("[data-act='retry']")) file && pick(file);
  });
  $("#batch-preview").addEventListener("change", (e) => {
    if (e.target.id === "pv-column") { column = e.target.value; renderPreview(); }
  });
  $("#batch-head").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "new") reset();
    if (act === "report") exportReport();
  });
  $("#batch-findings").addEventListener("click", (e) => {
    const t = e.target.closest("[data-term]");
    if (t) { query = t.dataset.term.toLowerCase(); filter = t.dataset.label; page = 1; $("#batch-search").value = t.dataset.term; renderFilters(); renderTable(); $("#batch-table-card").scrollIntoView({ behavior: "smooth" }); }
  });
  $("#batch-search").addEventListener("input", debounce((e) => { query = e.target.value.trim().toLowerCase(); page = 1; renderTable(); }, 150));
  $("#batch-filter").addEventListener("click", (e) => {
    const c = e.target.closest("[data-filter]"); if (!c) return;
    filter = c.dataset.filter; page = 1; renderFilters(); renderTable();
  });
  $("#batch-pager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]"); if (!b || b.disabled) return;
    page = +b.dataset.page; renderTable(); $("#batch-table-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#batch-download").addEventListener("click", exportCSV);
}

export function setBatchEnabled(ok) { ready = ok; const b = $("#batch-preview [data-act='run']"); if (b) b.disabled = !ok || busy; }

export async function loadSample() {
  try {
    const blob = await (await fetch("/static/samples/sample_reviews.csv")).blob();
    pick(new File([blob], "sample_reviews.csv", { type: "text/csv" }));
  } catch { toast("Couldn't load the sample file", { type: "error" }); }
}

/* ---------------------------------------------------------- step 1: pick */
async function pick(f) {
  if (!/\.(csv|tsv|txt)$/i.test(f.name)) { toast("Unsupported file", { type: "error", body: "Please choose a .csv file. In Excel or Sheets: File → Download / Save as → CSV." }); return; }
  if (f.size > MAX_BYTES) { toast("File too large", { type: "error", body: `This file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 4 MB. Split it into smaller files.` }); return; }
  if (f.size === 0) { toast("Empty file", { type: "error", body: "The selected file has no content." }); return; }
  file = f; preview = null; column = null;
  $("#file-input").value = "";
  $("#upload-card").hidden = true;
  $("#batch-empty").hidden = true;
  $("#batch-results").hidden = true;
  const pv = $("#batch-preview");
  pv.hidden = false;
  pv.innerHTML = `<div class="thinking"><span class="spinner"></span>Reading <b>${esc(f.name)}</b> and looking for the feedback column…</div>`;
  try {
    preview = await api.batchPreview(f);
    column = preview.detected_column;
    renderPreview();
  } catch (err) {
    pv.innerHTML = `<div class="err-state">${icon("alert")}<div><h3>We couldn't read this file</h3><p>${esc(err.message)}</p>
      <div class="row-gap"><button class="btn btn-secondary btn-sm" data-act="retry">${icon("refresh")}Try again</button><button class="btn btn-ghost btn-sm" data-act="reset">Choose another file</button></div></div></div>`;
  }
}

/* ------------------------------------------------------- step 2: preview */
function renderPreview() {
  const pv = $("#batch-preview");
  const cols = preview.columns.filter((c) => c.valid > 0);
  const cur = preview.columns.find((c) => c.name === column) || cols[0];
  const willAnalyse = Math.min(cur.valid, preview.max_rows);
  pv.innerHTML = `
    <div class="card-head"><h3>${icon("file")} ${esc(preview.filename)}</h3><button class="btn btn-ghost btn-xs" data-act="reset">${icon("x")}Choose another file</button></div>
    <div class="pv-grid">
      <div>
        <label class="pv-label" for="pv-column">Which column contains the feedback?</label>
        <select id="pv-column" class="pv-select">${cols.map((c) => `<option value="${esc(c.name)}" ${c.name === cur.name ? "selected" : ""}>${esc(c.name)} — ${fmt(c.valid)} rows with text${c.name === preview.detected_column ? " (detected)" : ""}</option>`).join("")}</select>
        <ul class="pv-facts">
          <li>${icon("check")}<span><b>${fmt(willAnalyse)}</b> rows will be analysed</span></li>
          ${cur.empty ? `<li>${icon("info")}<span>${fmt(cur.empty)} empty or non-text rows will be skipped</span></li>` : ""}
          ${preview.truncated ? `<li class="warn">${icon("alert")}<span>The file has ${fmt(preview.total_rows)} rows; only the first ${fmt(preview.max_rows)} are analysed</span></li>` : ""}
        </ul>
      </div>
      <div>
        <span class="pv-label">Preview of “${esc(cur.name)}”</span>
        <ul class="pv-sample">${cur.sample.map((t) => `<li>${esc(t)}</li>`).join("") || "<li class='muted-sm'>No text in this column</li>"}</ul>
      </div>
    </div>
    <div class="pv-actions">
      <label class="check" data-tip="Adds every row to History & Usage in this browser"><input type="checkbox" id="batch-save" checked /><span>Save results to history</span></label>
      <button class="btn btn-primary" data-act="run" ${!ready || !willAnalyse ? "disabled" : ""}>${icon("sparkles")}<span>Analyse ${fmt(willAnalyse)} rows</span></button>
    </div>`;
}

/* ------------------------------------------------------- step 3: analyse */
async function run() {
  if (!file || busy) return;
  busy = true;
  const btn = $("#batch-preview [data-act='run']");
  const save = $("#batch-save")?.checked ?? true;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>Analysing…</span>`;
  try {
    result = await api.batch(file, column);
    analysedAt = Date.now();
    filter = "all"; query = ""; page = 1; $("#batch-search").value = "";
    $("#batch-preview").hidden = true;
    render();
    if (save && result.rows.length) history.addBatch(result.rows, result.filename);
    toast(`Analysed ${fmt(result.summary.analyzed)} rows`, { body: result.summary.skipped ? `${fmt(result.summary.skipped)} rows without text were skipped.` : `Using column “${result.column_used}”.` });
    $("#batch-results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    toast("Analysis failed", { type: "error", body: `${err.message} Your file is still selected — try again.`, ms: 6000 });
    btn.disabled = !ready; btn.innerHTML = `${icon("refresh")}<span>Try again</span>`;
  } finally {
    busy = false;
  }
}

function reset() {
  file = null; preview = null; result = null; column = null;
  $("#batch-preview").hidden = true;
  $("#batch-results").hidden = true;
  $("#upload-card").hidden = false;
  $("#batch-empty").hidden = false;
}

/* ------------------------------------------------------------- results */
function findings() {
  const s = result.summary, n = s.analyzed || 1, t = s.themes || {};
  const out = [];
  out.push({ type: s.counts.negative > s.counts.positive ? "negative" : "positive",
    text: `${pct(s.counts.positive / n)} of feedback is positive and ${pct(s.counts.negative / n)} negative (${fmt(s.analyzed)} rows).` });
  if (t.negative?.[0]) out.push({ type: "negative", text: `Most common complaint wording: “${t.negative[0][0]}” — in ${t.negative[0][1]} of ${fmt(s.counts.negative)} negative rows.`, term: t.negative[0][0], label: "negative" });
  if (t.positive?.[0]) out.push({ type: "positive", text: `Customers who are happy most often mention “${t.positive[0][0]}” — in ${t.positive[0][1]} of ${fmt(s.counts.positive)} positive rows.`, term: t.positive[0][0], label: "positive" });
  if (s.analyzed < 50) out.push({ type: "alert", text: `Only ${s.analyzed} rows — themes from a small file are indicative only. Read the rows below.` });
  return out;
}

function render() {
  const s = result.summary, n = s.analyzed || 1, t = s.themes || {};
  $("#batch-empty").hidden = true;
  $("#upload-card").hidden = true;
  $("#batch-results").hidden = false;
  $("#batch-head").innerHTML = `<div><h2>${esc(result.filename)}</h2><p class="muted-sm">Column “${esc(result.column_used)}” · ${fmt(s.analyzed)} rows analysed${s.skipped ? ` · ${fmt(s.skipped)} skipped` : ""}${s.truncated ? ` · first ${fmt(s.max_rows)} rows only` : ""} · ${fmtDate(analysedAt)}</p></div>
    <div class="row-gap"><button class="btn btn-ghost btn-sm" data-act="new">${icon("upload")}Analyse another file</button>
    <button class="btn btn-secondary btn-sm" data-act="report" data-tip="Download a shareable HTML report (prints to PDF)">${icon("report")}Download report</button></div>`;

  const typeIcon = { alert: "bell", negative: "frown", positive: "smile", info: "info" };
  const termChips = (list, label) => list?.length ? `<div class="wordcloud">${list.map(([w, c], i) => `<button class="word ${label}" style="--s:${(1 - i / (list.length * 1.4)).toFixed(2)}" data-term="${esc(w)}" data-label="${label}" data-tip="In ${c} ${label} rows — click to see them">${esc(w)}<small>${c}</small></button>`).join("")}</div>`
    : `<p class="no-drivers">No wording stands out in ${label} rows${(s.counts[label] || 0) < 10 ? " (too few rows)" : ""}.</p>`;
  $("#batch-findings").innerHTML = `<div class="card-head"><h3>${icon("bell")} Key findings</h3><span class="muted-sm">rule-based, from the rows below</span></div>
    <ul>${findings().map((f) => `<li class="ins ${f.type}"><span class="ins-ico">${icon(typeIcon[f.type])}</span><span>${esc(f.text)}${f.term ? ` <button class="link-btn" data-term="${esc(f.term)}" data-label="${f.label}">See rows →</button>` : ""}</span></li>`).join("")}</ul>
    <div class="grid-1-1 tight">
      <div><div class="sub-title">Top complaints <i data-icon="info" data-tip="Words and phrases far more common in negative rows than in the rest. Click one to read those rows."></i></div>${termChips(t.negative, "negative")}</div>
      <div><div class="sub-title">What customers like</div>${termChips(t.positive, "positive")}</div>
    </div>`;

  const cards = [
    { k: "Rows analysed", v: fmt(s.analyzed), sub: s.skipped ? `${fmt(s.skipped)} skipped (no text)` : `avg. confidence ${s.avg_confidence != null ? pct(s.avg_confidence) : "–"}`, ic: "layers" },
    ...LABELS.map((l) => ({ k: cap(l), v: pct(s.counts[l] / n), sub: `${fmt(s.counts[l])} rows`, ic: { positive: "smile", negative: "frown", neutral: "meh" }[l], c: COLORS[l], soft: SOFT[l], w: s.counts[l] / n })),
  ];
  $("#batch-stats").innerHTML = cards.map((c) => `<div class="card stat" style="${c.c ? `--c:${c.c};--soft:${c.soft}` : ""}">
    <div class="stat-top"><span>${c.k}</span><span class="stat-ico">${icon(c.ic)}</span></div>
    <div class="stat-val">${c.v}</div><div class="stat-sub">${c.sub}</div>${c.w != null ? `<span class="stat-bar" style="width:${c.w * 100}%"></span>` : ""}</div>`).join("");
  $("#batch-dist").innerHTML = LABELS.map((l) => `<span style="width:${(s.counts[l] / n) * 100}%;background:${COLORS[l]}" data-tip="${cap(l)}: ${fmt(s.counts[l])} (${pct(s.counts[l] / n, 1)})"></span>`).join("");
  hydrateIcons($("#batch-findings"));
  renderFilters();
  renderTable();
}

function renderFilters() {
  const c = result.summary.counts, all = result.rows.length;
  $("#batch-filter").innerHTML = [["all", "All", all], ...LABELS.map((l) => [l, cap(l), c[l]])]
    .map(([k, name, n]) => `<button class="chip ${filter === k ? "active" : ""}" data-filter="${k}" aria-pressed="${filter === k}">${name}<span class="chip-count">${fmt(n)}</span></button>`).join("");
}

function filtered() {
  return result.rows.filter((r) => (filter === "all" || r.label === filter) && (!query || r.text.toLowerCase().includes(query)));
}

function renderTable() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  page = Math.min(page, pages);
  $("#batch-count").textContent = `${fmt(rows.length)} of ${fmt(result.rows.length)} shown`;
  const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $("#batch-table tbody").innerHTML = slice.length ? slice.map((r) => `<tr>
      <td class="num">${r.row}</td>
      <td class="txt"><span title="${esc(r.text)}">${esc(r.text)}</span></td>
      <td>${badge(r.label)}</td>
      <td class="conf-td" data-tip="Neg ${pct(r.probabilities.negative)} · Neu ${pct(r.probabilities.neutral)} · Pos ${pct(r.probabilities.positive)}">${confCell(r.label, r.confidence)}</td></tr>`).join("")
    : `<tr><td colspan="4"><div class="empty compact bare"><div class="empty-art">${icon("search")}</div><h3>No matching rows</h3><p>Try a different search term or filter.</p></div></td></tr>`;
  $("#batch-pager").innerHTML = pagerHTML(page, pages, rows.length, PER_PAGE);
}

function exportCSV() {
  if (!result) return;
  const rows = filtered();
  if (!rows.length) { toast("Nothing to export", { type: "error", body: "No rows match the current filter." }); return; }
  const csv = toCSV(
    ["row", "text", "sentiment", "confidence", "p_negative", "p_neutral", "p_positive"],
    rows.map((r) => [r.row, r.text, r.label, r.confidence.toFixed(4), r.probabilities.negative.toFixed(4), r.probabilities.neutral.toFixed(4), r.probabilities.positive.toFixed(4)]),
  );
  const base = (result.filename || "feedback").replace(/\.[^.]+$/, "");
  download(`${base}-sentiment-${stamp()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  toast("CSV downloaded", { body: `${fmt(rows.length)} rows${filter !== "all" || query ? " (filtered)" : ""}.` });
}

function exportReport() {
  const s = result.summary, n = s.analyzed || 1, t = s.themes || {};
  const pick = (label, k) => result.rows.filter((r) => r.label === label).sort((a, b) => b.confidence - a.confidence).slice(0, k)
    .map((r) => ({ text: r.text, meta: `Row ${r.row} · ${cap(r.label)} · ${pct(r.confidence)} confidence` }));
  downloadReport(`${result.filename.replace(/\.[^.]+$/, "")} feedback`, {
    title: `Customer feedback: ${result.filename}`,
    subtitle: "What customers like and what they complain about",
    meta: [["Data source", `Uploaded file “${result.filename}”, column “${result.column_used}”`], ["Rows analysed", `${fmt(s.analyzed)}${s.skipped ? ` (${fmt(s.skipped)} without text skipped)` : ""}${s.truncated ? `, first ${fmt(s.max_rows)} rows only` : ""}`], ["Analysed", fmtDate(analysedAt)]],
    kpis: [{ label: "Rows analysed", value: fmt(s.analyzed) }, ...LABELS.map((l) => ({ label: cap(l), value: pct(s.counts[l] / n), sub: `${fmt(s.counts[l])} rows` }))],
    sections: [
      { title: "Overall sentiment", html: sentimentBar(s.counts) },
      { title: "Key findings", html: `<ul>${findings().map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>` },
      { title: "Top complaints", html: chips(t.negative, "neg") },
      { title: "What customers like", html: chips(t.positive, "pos") },
      { title: "Representative negative feedback", html: quotes(pick("negative", 5)) },
      { title: "Representative positive feedback", html: quotes(pick("positive", 3)) },
    ],
    methodology: [MODEL_METHOD, "Complaint and praise terms are words or two-word phrases that appear far more often in negative (or positive) rows than in the rest. They show recurring wording, not root causes — read the rows to understand context."],
    limitations: ["The model is English-only and can misread sarcasm and mixed opinions.", "Individual predictions can be wrong; rely on aggregates and read representative rows."],
  });
  toast("Report downloaded", { body: "Open it in a browser; print to save as PDF." });
}
