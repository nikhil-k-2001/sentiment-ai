// The single-text analyzer: composer + full analysis report.
// One instance is created and moved between the Dashboard and Analyzer views.
import { api } from "./api.js";
import { animateIn, gauge } from "./charts.js";
import { FEATURED, randomSample } from "./samples.js";
import { history } from "./store.js";
import {
  $, COLORS, FACE, LABELS, SOFT, cap, copyText, download, esc, hydrateIcons, icon, pct, stamp, toast,
} from "./utils.js";

const MAX = 5000;
const WORD_RE = /(?<![@\w#])[A-Za-z][A-Za-z']*[A-Za-z]|(?<![@\w#])[A-Za-z]/g;

let node, input, runBtn, countEl, errEl, resultEl;
let busy = false;
let current = null;          // entry currently shown in the report
let modelReady = true;
const changeListeners = new Set();

export const analyzer = {
  get node() { return node; },
  get currentId() { return current?.id; },
  onChange(fn) { changeListeners.add(fn); },
  setModelReady(ok) { modelReady = ok; updateCount(); },
  show(entry) { current = entry; input.value = entry.text; updateCount(); renderReport(entry); notify(); },
  focus() { input.focus(); },
  analyze(text) { setText(text.slice(0, MAX)); run(); },
};

export function mountAnalyzer() {
  node = $("#analyzer-template").content.firstElementChild.cloneNode(true);
  input = $("#az-input", node); runBtn = $("#az-run", node); countEl = $("#az-count", node);
  errEl = $("#az-error", node); resultEl = $("#az-result", node);
  $("#kbd-mod", node).textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  $("#az-samples", node).innerHTML = FEATURED.map((s, i) => `<button class="chip" data-sample="${i}" data-tip="${esc(s.text.slice(0, 90))}…">${esc(s.name)}</button>`).join("");
  hydrateIcons(node);

  node.addEventListener("click", (e) => {
    const s = e.target.closest("[data-sample]");
    if (s) { setText(FEATURED[+s.dataset.sample].text); }
  });
  $("#az-random", node).addEventListener("click", () => { setText(randomSample()); toast("Sample inserted", { type: "info", body: "Press Analyze to classify it.", ms: 1800 }); });
  $("#az-clear", node).addEventListener("click", () => {
    input.value = ""; current = null; updateCount(); hideError(); renderEmpty(); notify(); input.focus();
  });
  input.addEventListener("input", () => { updateCount(); hideError(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
  });
  runBtn.addEventListener("click", run);
  resultEl.addEventListener("click", onReportAction);

  updateCount();
  renderEmpty();
  return node;
}

function notify() { changeListeners.forEach((fn) => fn(current)); }

function setText(t) { input.value = t; updateCount(); hideError(); input.focus(); }

function updateCount() {
  const n = input.value.length;
  countEl.textContent = `${n.toLocaleString()} / ${MAX.toLocaleString()}`;
  countEl.className = `count${n > MAX ? " over" : n > MAX * 0.9 ? " warn" : ""}`;
  const empty = !input.value.trim();
  runBtn.disabled = busy || !modelReady || empty || n > MAX;
  runBtn.dataset.tip = !modelReady ? "Train the model first — see the banner above"
    : empty ? "Enter some text first" : n > MAX ? `Shorten the text to ${MAX.toLocaleString()} characters` : "";
  if (n > MAX) countEl.textContent += ` — ${(n - MAX).toLocaleString()} over the limit`;
}

function showError(msg) { errEl.textContent = msg; errEl.hidden = false; }
function hideError() { errEl.hidden = true; }

function validate(text) {
  if (!text.trim()) return "Please enter some text to analyse.";
  if (text.length > MAX) return `Text is too long (${text.length.toLocaleString()} characters). The limit is ${MAX.toLocaleString()}.`;
  if (!/[A-Za-zÀ-ɏ]/.test(text)) return "The text needs at least some words for the model to analyse.";
  return null;
}

async function run() {
  if (busy) return;
  const text = input.value;
  const problem = validate(text);
  if (problem) { showError(problem); input.focus(); return; }
  hideError();
  busy = true; updateCount();
  runBtn.innerHTML = `<span class="spinner"></span><span>Analyzing…</span>`;
  renderLoading();
  try {
    const [res] = await Promise.all([api.analyze(text.trim()), new Promise((r) => setTimeout(r, 450))]);
    current = history.addSingle(res);
    renderReport(current);
    notify();
    toast("Analysis complete", { body: `${cap(res.label)} · ${pct(res.confidence)} confidence` });
  } catch (err) {
    current ? renderReport(current) : renderEmpty();
    showError(err.message);
    toast("Analysis failed", { type: "error", body: err.message });
  } finally {
    busy = false;
    runBtn.innerHTML = `${icon("sparkles")}<span>Analyze sentiment</span>`;
    updateCount();
  }
}

/* ------------------------------------------------------------- rendering */
function renderEmpty() {
  resultEl.innerHTML = `<div class="card empty">
    <div class="empty-art">${icon("report")}</div>
    <h3>Your analysis report will appear here</h3>
    <p>Type or paste text above, or pick a sample, then press <b>Analyze sentiment</b>. You'll get the predicted class, confidence, class probabilities and the words that drove the decision.</p></div>`;
}

function renderLoading() {
  resultEl.innerHTML = `<div class="card report"><div class="report-head"><div class="thinking"><span class="dots"><span></span><span></span><span></span></span>Running TF-IDF features through the classifier…</div></div>
    <div class="loading-report"><div class="l"><div class="skeleton" style="width:90px;height:12px"></div><div class="skeleton" style="width:150px;height:150px;border-radius:50%"></div><div class="skeleton" style="width:120px;height:26px"></div></div>
    <div class="r">${[80, 100, 60, 100, 92, 70].map((w, i) => `<div class="skeleton" style="width:${w}%;height:${i === 3 ? 70 : 12}px"></div>`).join("")}</div></div></div>`;
}

function strength(c) { return c >= 0.75 ? "High confidence" : c >= 0.55 ? "Moderate confidence" : "Low confidence"; }

export function highlight(text, keywords) {
  const map = new Map((keywords || []).map((k) => [k.word.toLowerCase(), k]));
  if (!map.size) return esc(text);
  const maxImpact = Math.max(...[...map.values()].map((k) => k.impact));
  let out = "", last = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const k = map.get(m[0].toLowerCase());
    if (!k) continue;
    out += esc(text.slice(last, m.index));
    const w = (0.35 + 0.65 * (k.impact / maxImpact)).toFixed(2);
    const shift = k.probability_shift != null ? ` Without it, P(${k.sentiment}) drops ${Math.abs(k.probability_shift * 100).toFixed(1)} pts.` : "";
    out += `<mark class="kw ${k.sentiment}" style="--w:${w}" data-tip="Pushes toward ${k.sentiment} (+${k.impact.toFixed(2)} log-odds).${shift}">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function renderReport(e) {
  const tone = COLORS[e.label];
  const probs = [...LABELS].sort((a, b) => e.probabilities[b] - e.probabilities[a]);
  const kws = e.keywords || [];
  const maxImpact = Math.max(0.0001, ...kws.map((k) => k.impact));
  const when = new Date(e.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  resultEl.innerHTML = `<article class="card report" style="--tone:${tone};--tone-soft:${SOFT[e.label]}">
    <header class="report-head">
      <div><h3>${icon("report")}Analysis report</h3><div class="report-meta">${esc(when)}${e.latency_ms != null ? ` · ${e.latency_ms} ms inference` : ""} · ${e.text.length.toLocaleString()} characters</div></div>
      <div class="row-gap">
        <button class="btn btn-ghost btn-sm" data-act="copy" data-tip="Copy result as text">${icon("copy")}Copy</button>
        <button class="btn btn-secondary btn-sm" data-act="download" data-tip="Download a Markdown report">${icon("download")}Report</button>
      </div>
    </header>
    <div class="report-body">
      <section class="verdict">
        <span class="verdict-kicker">Predicted sentiment</span>
        <div class="verdict-label">${icon(FACE[e.label], "face")}${cap(e.label)}</div>
        <div data-tip="Confidence is the model's estimated probability for this class. It shows how sure the model is, not a guarantee that it's right.">${gauge(e.confidence, tone)}</div>
        <span class="strength">${strength(e.confidence)}</span>
        ${e.warnings?.length ? `<div class="az-warn" role="note">${e.warnings.map((w) => `<p>${icon("alert")}<span>${esc(w)}</span></p>`).join("")}</div>` : ""}
      </section>
      <section class="report-main">
        <div>
          <div class="sub-title">Class probabilities <i data-icon="info" data-tip="Softmax probabilities from the logistic regression model. They always sum to 100%."></i></div>
          ${probs.map((l, i) => `<div class="prob-row${i === 0 ? " top" : ""}" style="--c:${COLORS[l]}"><span class="lbl">${l}</span>
            <div class="prob-track"><div class="prob-fill" data-width="${(e.probabilities[l] * 100).toFixed(2)}%"></div></div>
            <span class="pct">${pct(e.probabilities[l], 1)}</span></div>`).join("")}
        </div>
        ${e.source === "batch" ? "" : `<div>
          <div class="sub-title">Analysed text <i data-icon="info" data-tip="Highlighted words measurably changed the prediction: we remove each word, re-run the model, and measure the shift. Hover a word for details."></i></div>
          <div class="text-panel">${highlight(e.text, kws)}${e.truncated ? "…" : ""}</div>
          ${kws.length ? `<div class="legend"><span style="--c:var(--pos)">Positive signal</span><span style="--c:var(--neg)">Negative signal</span><span style="--c:var(--neu)">Neutral signal</span></div>` : ""}
        </div>
        <div>
          <div class="sub-title">Key drivers</div>
          ${kws.length ? `<div class="drivers">${kws.slice(0, 8).map((k) => `<div class="driver" style="--c:${COLORS[k.sentiment]}" data-tip="+${k.impact.toFixed(2)} log-odds toward ${k.sentiment}">
              <span class="badge ${k.sentiment}" style="padding:0 6px;height:20px"></span><b>${esc(k.word)}</b>
              <span class="mini"><span style="width:${(k.impact / maxImpact) * 100}%"></span></span><small>${k.impact.toFixed(2)}</small></div>`).join("")}</div>`
            : `<p class="no-drivers">No single word moved the prediction noticeably — the result comes from the text as a whole.</p>`}
        </div>`}
        <div class="summary-box">${icon("sparkles")}<div><b>Summary.</b> ${esc(e.summary || "Saved from a batch run — re-analyse this text individually to see a detailed explanation.")}</div></div>
      </section>
    </div></article>`;
  hydrateIcons(resultEl);
  animateIn(resultEl);
}

/* ---------------------------------------------------------------- export */
function reportText(e) {
  return [
    `SentimentAI analysis`,
    `Sentiment: ${cap(e.label)} (${pct(e.confidence, 1)} confidence)`,
    `Probabilities: ${LABELS.map((l) => `${cap(l)} ${pct(e.probabilities[l], 1)}`).join(" · ")}`,
    e.keywords?.length ? `Key words: ${e.keywords.slice(0, 6).map((k) => `${k.word} (${k.sentiment})`).join(", ")}` : null,
    `Text: "${e.text}"`,
    e.summary ? `Summary: ${e.summary}` : null,
  ].filter(Boolean).join("\n");
}

function reportMarkdown(e, model) {
  const when = new Date(e.ts).toISOString();
  return `# SentimentAI — Sentiment Analysis Report

| Field | Value |
|---|---|
| Predicted sentiment | **${cap(e.label)}** |
| Confidence | ${pct(e.confidence, 2)} |
| Analysed at | ${when} |
| Model | ${model || "SentimentAI TF-IDF + Logistic Regression"} |

## Class probabilities

| Class | Probability |
|---|---|
${LABELS.map((l) => `| ${cap(l)} | ${pct(e.probabilities[l], 2)} |`).join("\n")}

## Analysed text

> ${e.text.replace(/\n/g, "\n> ")}

## Key drivers

${e.keywords?.length ? `Words whose removal changes the prediction the most (occlusion analysis):

| Word | Pushes toward | Impact (log-odds) |
|---|---|---|
${e.keywords.map((k) => `| ${k.word} | ${k.sentiment} | +${k.impact.toFixed(3)} |`).join("\n")}` : "_No individual word had a measurable effect._"}

## Summary

${e.summary || "Saved from a batch run."}

---
_This is a model-based prediction, not a guaranteed understanding of the author's intent._
`;
}

async function onReportAction(ev) {
  const b = ev.target.closest("[data-act]"); if (!b || !current) return;
  if (b.dataset.act === "copy") {
    (await copyText(reportText(current))) ? toast("Copied to clipboard") : toast("Couldn't copy", { type: "error" });
  } else if (b.dataset.act === "download") {
    download(`sentiment-report-${stamp()}.md`, reportMarkdown(current, window.__modelName), "text/markdown");
    toast("Report downloaded", { body: "Saved as a Markdown file." });
  }
}
