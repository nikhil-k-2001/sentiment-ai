// Shareable reports: a single self-contained HTML file (inline CSS, no
// scripts) that opens in any browser and prints cleanly to PDF.
import { download, esc, stamp } from "./utils.js";

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:Inter,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0e1124;background:#f6f7fb;line-height:1.55;font-size:14px}
.page{max-width:880px;margin:0 auto;padding:40px 32px 56px;background:#fff;min-height:100vh}
header{border-bottom:2px solid #5b4cf5;padding-bottom:18px;margin-bottom:24px}
.brand{font-weight:800;color:#5b4cf5;font-size:13px;letter-spacing:.02em}
h1{font-size:28px;margin:6px 0 4px;letter-spacing:-.02em}h2{font-size:17px;margin:30px 0 10px;letter-spacing:-.01em}
.sub{color:#5f6479}.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin-top:14px;font-size:13px}
.meta dt{color:#5f6479}.meta dd{margin:0;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{border:1px solid #e6e8f0;border-radius:12px;padding:12px 14px}.kpi .l{font-size:12px;color:#5f6479;font-weight:600}
.kpi .v{font-size:24px;font-weight:800;letter-spacing:-.02em}.kpi .s{font-size:12px;color:#5f6479}
ul{padding-left:20px;margin:6px 0}li{margin:4px 0}
.pos{color:#067a54}.neg{color:#c22d33}.neu{color:#8a5a00}
.bar{display:flex;height:10px;border-radius:99px;overflow:hidden;margin:8px 0 4px;background:#eef0f5}
.bar span{display:block;height:100%}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e8f0;vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:#5f6479;background:#f9fafc}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11.5px;font-weight:700}
.tag.positive{background:#e5f7f0;color:#067a54}.tag.negative{background:#fdecec;color:#c22d33}.tag.neutral{background:#fdf4e1;color:#8a5a00}
.quote{border-left:3px solid #d6d9e4;padding:6px 12px;margin:8px 0;color:#3b4058}
.quote small{display:block;color:#5f6479;margin-top:2px}
.chips span{display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border-radius:8px;font-weight:600;font-size:12.5px}
.chips.pos span{background:#e5f7f0;color:#067a54}.chips.neg span{background:#fdecec;color:#c22d33}
.note{background:#f4f3ff;border:1px solid #e4e1ff;border-radius:10px;padding:12px 14px;font-size:13px;color:#3b4058}
footer{margin-top:36px;padding-top:14px;border-top:1px solid #e6e8f0;font-size:12px;color:#5f6479}
@media print{body{background:#fff}.page{padding:0}h2{break-after:avoid}.quote,tr{break-inside:avoid}}
`;

export const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" }) : "–");

export function sentimentBar(counts) {
  const n = (counts.positive || 0) + (counts.neutral || 0) + (counts.negative || 0) || 1;
  const seg = (k, c) => (counts[k] ? `<span style="width:${(counts[k] / n) * 100}%;background:${c}"></span>` : "");
  return `<div class="bar">${seg("positive", "#0ea271")}${seg("neutral", "#e8a317")}${seg("negative", "#e5484d")}</div>
    <div class="sub" style="font-size:12.5px"><span class="pos">${Math.round((counts.positive || 0) / n * 100)}% positive</span> ·
    <span class="neu">${Math.round((counts.neutral || 0) / n * 100)}% neutral</span> · <span class="neg">${Math.round((counts.negative || 0) / n * 100)}% negative</span></div>`;
}

export function chips(terms, cls) {
  return terms?.length ? `<div class="chips ${cls}">${terms.map(([t, c]) => `<span>${esc(t)} · ${c}</span>`).join("")}</div>` : `<p class="sub">No recurring terms found.</p>`;
}

export function quotes(items) {
  return items.length ? items.map((q) => `<div class="quote">${esc(q.text.length > 320 ? q.text.slice(0, 317) + "…" : q.text)}<small>${q.meta}</small></div>`).join("") : `<p class="sub">None.</p>`;
}

/**
 * opts: { title, subtitle, meta: [[label, value]], kpis: [{label, value, sub}],
 *         sections: [{title, html}], methodology: [string], limitations: [string] }
 */
export function buildReport(opts) {
  const generated = new Date().toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · SentimentAI report</title><style>${CSS}</style></head><body><div class="page">
<header><div class="brand">SentimentAI · Report</div><h1>${esc(opts.title)}</h1><div class="sub">${esc(opts.subtitle || "")}</div>
<dl class="meta">${(opts.meta || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}<dt>Generated</dt><dd>${esc(generated)}</dd></dl></header>
${opts.kpis?.length ? `<div class="kpis">${opts.kpis.map((k) => `<div class="kpi"><div class="l">${esc(k.label)}</div><div class="v">${esc(k.value)}</div>${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ""}</div>`).join("")}</div>` : ""}
${(opts.sections || []).map((sec) => `<h2>${esc(sec.title)}</h2>${sec.html}`).join("\n")}
<h2>Methodology</h2><div class="note"><ul>${(opts.methodology || []).map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>
${opts.limitations?.length ? `<h2>Limitations</h2><ul>${opts.limitations.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
<footer>Generated by SentimentAI. Sentiment is predicted automatically by a TF-IDF + logistic-regression model and describes the text, not the author's intent. Automated insights are rule-based summaries of the numbers in this report.</footer>
</div></body></html>`;
}

export const MODEL_METHOD = "Each text is classified as positive, negative or neutral by SentimentAI's own model (TF-IDF features + logistic regression, trained on ~74k labelled tweets). Confidence is the model's estimated probability for its chosen class, not a guarantee.";

export function downloadReport(name, opts) {
  const slug = name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "report";
  download(`${slug}-report-${stamp()}.html`, buildReport(opts), "text/html;charset=utf-8");
}
