// Batch CSV analysis view.
import { api } from "./api.js";
import { history } from "./store.js";
import {
  $, COLORS, LABELS, SOFT, badge, cap, confCell, debounce, download, esc, fmt, icon, pagerHTML, pct, stamp, toCSV, toast,
} from "./utils.js";

const PER_PAGE = 50;
let file = null;
let result = null;
let filter = "all", query = "", page = 1;
let busy = false;

export function initBatch() {
  const dz = $("#dropzone"), fi = $("#file-input");
  fi.addEventListener("change", () => fi.files[0] && pick(fi.files[0]));
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) pick(f); });

  $("#file-remove").addEventListener("click", (e) => { e.preventDefault(); reset(); });
  $("#batch-run").addEventListener("click", () => run());
  $("#column-select").addEventListener("change", () => result && run($("#column-select").value));
  $("#batch-search").addEventListener("input", debounce((e) => { query = e.target.value.trim().toLowerCase(); page = 1; renderTable(); }, 150));
  $("#batch-filter").addEventListener("click", (e) => {
    const c = e.target.closest("[data-filter]"); if (!c) return;
    filter = c.dataset.filter; page = 1; renderFilters(); renderTable();
  });
  $("#batch-pager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]"); if (!b || b.disabled) return;
    page = +b.dataset.page; renderTable(); $("#batch-table").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#batch-download").addEventListener("click", exportCSV);
}

export function setBatchEnabled(ok) { $("#batch-run").disabled = !ok || busy; }

function pick(f) {
  if (!/\.(csv|txt)$/i.test(f.name)) { toast("Unsupported file", { type: "error", body: "Please choose a .csv file." }); return; }
  if (f.size > 4 * 1024 * 1024) { toast("File too large", { type: "error", body: "The limit is 4 MB." }); return; }
  if (f.size === 0) { toast("Empty file", { type: "error", body: "The selected file has no content." }); return; }
  file = f; result = null;
  $("#file-name").textContent = f.name;
  $("#file-meta").textContent = `${(f.size / 1024).toFixed(1)} KB · ready to analyse`;
  $("#upload-bar").hidden = false;
  $("#column-field").hidden = true;
  $("#dz-title").innerHTML = `Drop another file to replace <u>${esc(f.name)}</u>`;
  $("#file-input").value = "";
}

function reset() {
  file = null; result = null;
  $("#upload-bar").hidden = true;
  $("#batch-results").hidden = true;
  $("#batch-empty").hidden = false;
  $("#dz-title").innerHTML = "Drop a CSV file here, or <u>browse</u>";
}

async function run(column) {
  if (!file || busy) return;
  busy = true;
  const btn = $("#batch-run");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>Analyzing…</span>`;
  $("#file-meta").textContent = "Uploading and classifying…";
  try {
    result = await api.batch(file, column);
    const s = result.summary;
    $("#file-meta").textContent = `${fmt(s.analyzed)} analysed · column “${result.column_used}”`;
    const sel = $("#column-select");
    sel.innerHTML = result.columns.map((c) => `<option ${c === result.column_used ? "selected" : ""}>${esc(c)}</option>`).join("");
    $("#column-field").hidden = result.columns.length < 2;
    filter = "all"; query = ""; page = 1; $("#batch-search").value = "";
    render();
    if ($("#batch-save").checked && result.rows.length) history.addBatch(result.rows, result.filename);
    const notes = [];
    if (s.skipped) notes.push(`${fmt(s.skipped)} empty/non-text rows skipped`);
    if (s.truncated) notes.push(`only the first ${fmt(s.max_rows)} rows were analysed`);
    toast(`Analysed ${fmt(s.analyzed)} records`, { body: notes.join(" · ") || `Using column “${result.column_used}”.`, ms: 4200 });
  } catch (err) {
    $("#file-meta").textContent = "Analysis failed — check the file and try again";
    toast("Batch analysis failed", { type: "error", body: err.message, ms: 5000 });
  } finally {
    busy = false;
    btn.disabled = false; btn.innerHTML = `${icon("sparkles")}<span>Analyze all</span>`;
  }
}

function render() {
  const s = result.summary, n = s.analyzed || 1;
  $("#batch-empty").hidden = true;
  $("#batch-results").hidden = false;
  const cards = [
    { k: "Records analysed", v: fmt(s.analyzed), sub: s.skipped ? `${fmt(s.skipped)} skipped` : `avg. confidence ${s.avg_confidence != null ? pct(s.avg_confidence) : "–"}`, ic: "layers" },
    ...LABELS.map((l) => ({ k: cap(l), v: fmt(s.counts[l]), sub: `${pct(s.counts[l] / n, 1)} of records`, ic: { positive: "smile", negative: "frown", neutral: "meh" }[l], c: COLORS[l], soft: SOFT[l], w: s.counts[l] / n })),
  ];
  $("#batch-stats").innerHTML = cards.map((c) => `<div class="card stat" style="${c.c ? `--c:${c.c};--soft:${c.soft}` : ""}">
    <div class="stat-top"><span>${c.k}</span><span class="stat-ico">${icon(c.ic)}</span></div>
    <div class="stat-val">${c.v}</div><div class="stat-sub">${c.sub}</div>${c.w != null ? `<span class="stat-bar" style="width:${c.w * 100}%"></span>` : ""}</div>`).join("");
  $("#batch-dist").innerHTML = LABELS.map((l) => `<span style="width:${(s.counts[l] / n) * 100}%;background:${COLORS[l]}" data-tip="${cap(l)}: ${fmt(s.counts[l])} (${pct(s.counts[l] / n, 1)})"></span>`).join("");
  renderFilters();
  renderTable();
}

function renderFilters() {
  const c = result.summary.counts, all = result.rows.length;
  $("#batch-filter").innerHTML = [["all", "All", all], ...LABELS.map((l) => [l, cap(l), c[l]])]
    .map(([k, name, n]) => `<button class="chip ${filter === k ? "active" : ""}" data-filter="${k}" role="tab" aria-selected="${filter === k}">${name}<span class="chip-count">${fmt(n)}</span></button>`).join("");
}

function filtered() {
  return result.rows.filter((r) => (filter === "all" || r.label === filter) && (!query || r.text.toLowerCase().includes(query)));
}

function renderTable() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  page = Math.min(page, pages);
  const slice = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $("#batch-table tbody").innerHTML = slice.length ? slice.map((r) => `<tr>
      <td class="num">${r.row}</td>
      <td class="txt"><span title="${esc(r.text)}">${esc(r.text)}</span></td>
      <td>${badge(r.label)}</td>
      <td class="conf-td" data-tip="Neg ${pct(r.probabilities.negative)} · Neu ${pct(r.probabilities.neutral)} · Pos ${pct(r.probabilities.positive)}">${confCell(r.label, r.confidence)}</td></tr>`).join("")
    : `<tr><td colspan="4"><div class="empty compact bare"><div class="empty-art">${icon("search")}</div><h3>No matching records</h3><p>Try a different search term or filter.</p></div></td></tr>`;
  $("#batch-pager").innerHTML = pagerHTML(page, pages, rows.length, PER_PAGE);
}

function exportCSV() {
  if (!result) return;
  const rows = filtered();
  if (!rows.length) { toast("Nothing to export", { type: "error", body: "No records match the current filter." }); return; }
  const csv = toCSV(
    ["row", "text", "sentiment", "confidence", "p_negative", "p_neutral", "p_positive"],
    rows.map((r) => [r.row, r.text, r.label, r.confidence.toFixed(4), r.probabilities.negative.toFixed(4), r.probabilities.neutral.toFixed(4), r.probabilities.positive.toFixed(4)]),
  );
  const base = (result.filename || "batch").replace(/\.[^.]+$/, "");
  download(`${base}-sentiment-${stamp()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  toast("CSV downloaded", { body: `${fmt(rows.length)} records${filter !== "all" || query ? " (filtered)" : ""}.` });
}
