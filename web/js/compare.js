// Competitor comparison: share of voice and sentiment for up to three brands.
import { api } from "./api.js";
import { BRAND_COLORS, SOURCE_META, brands } from "./brands.js";
import { donutItems, netBars, stackedRows } from "./charts.js";
import { $, esc, fmt, icon, pct, toast } from "./utils.js";

const PRESETS = [["Netflix", "Disney+", "Hulu"], ["Spotify", "Apple Music"], ["Tesla", "Rivian", "Lucid"], ["ChatGPT", "Claude", "Gemini"]];
let busy = false;
let last = null;
let ready = true;

export function setCompareReady(ok) { ready = ok; $("#cmp-run").disabled = !ok || busy; }

export function initCompare({ onTrack }) {
  $("#cmp-presets").innerHTML = PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${p.map(esc).join(" vs ")}</button>`).join("");
  $("#cmp-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]"); if (!b) return;
    const p = PRESETS[+b.dataset.preset];
    ["#cmp-a", "#cmp-b", "#cmp-c"].forEach((id, i) => ($(id).value = p[i] || ""));
    run();
  });
  $("#cmp-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  $("#cmp-results").addEventListener("click", (e) => {
    const t = e.target.closest("[data-track]"); if (!t || !last) return;
    const r = last.find((x) => x.query === t.dataset.track);
    if (r) onTrack(r.query);
  });
}

async function run() {
  if (busy) return;
  const names = ["#cmp-a", "#cmp-b", "#cmp-c"].map((id) => $(id).value.trim().replace(/\s+/g, " ")).filter(Boolean);
  const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
  if (unique.length < 2) { toast("Enter at least two brands", { type: "error", body: "e.g. Spotify and Apple Music." }); $(names.length ? "#cmp-b" : "#cmp-a").focus(); return; }
  if (!ready) { toast("Model not ready", { type: "error" }); return; }
  busy = true;
  const btn = $("#cmp-run");
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span><span>Comparing…</span>`;
  $("#cmp-empty").hidden = true;
  $("#cmp-results").hidden = false;
  $("#cmp-results").innerHTML = `<div class="card listen-card"><div class="listen-radar">${icon("radar")}</div><h3>Listening for ${unique.map((u) => `“${esc(u)}”`).join(", ")}…</h3>
    <p class="muted-sm">Fetching mentions for each brand from ${Object.keys(SOURCE_META).length} sources in parallel.</p></div>`;
  try {
    const results = await Promise.allSettled(unique.map((q) => api.monitor(q, Object.keys(SOURCE_META), 50)));
    const ok = results.map((r, i) => (r.status === "fulfilled" ? { ...r.value, color: BRAND_COLORS[i] } : null)).filter(Boolean);
    const failed = results.map((r, i) => (r.status === "rejected" ? `${unique[i]}: ${r.reason.message}` : null)).filter(Boolean);
    if (failed.length) toast("Some brands failed", { type: "error", body: failed.join(" · "), ms: 6000 });
    if (ok.length < 2) throw new Error("Need results for at least two brands to compare.");
    last = ok;
    render(ok);
    toast("Comparison ready", { body: ok.map((r) => `${r.query} ${r.summary.total}`).join(" · ") + " mentions" });
  } catch (err) {
    $("#cmp-results").hidden = true; $("#cmp-empty").hidden = false;
    toast("Comparison failed", { type: "error", body: err.message, ms: 6000 });
  } finally {
    busy = false;
    btn.disabled = !ready; btn.innerHTML = `${icon("scale")}<span>Compare</span>`;
  }
}

function render(rs) {
  const sov = rs.map((r) => ({ label: r.query, value: r.summary.mentions_per_day || 0, color: r.color, display: `${fmt(Math.round(r.summary.mentions_per_day || 0))}/day` }));
  const totalRate = sov.reduce((s, x) => s + x.value, 0) || 1;
  const leader = [...rs].sort((a, b) => b.summary.mentions_per_day - a.summary.mentions_per_day)[0];
  const best = [...rs].sort((a, b) => b.summary.net_score - a.summary.net_score)[0];
  const worst = [...rs].sort((a, b) => a.summary.net_score - b.summary.net_score)[0];
  const insights = [
    `${leader.query} leads share of voice with ${pct((leader.summary.mentions_per_day || 0) / totalRate)} of estimated daily mentions.`,
    `${best.query} has the best net sentiment (${best.summary.net_score > 0 ? "+" : ""}${best.summary.net_score})${best !== worst ? `; ${worst.query} has the lowest (${worst.summary.net_score > 0 ? "+" : ""}${worst.summary.net_score}).` : "."}`,
  ];
  const topNeg = rs.filter((r) => r.summary.keywords.negative.length);
  if (topNeg.length) insights.push(topNeg.map((r) => `“${r.summary.keywords.negative[0][0]}” stands out in ${r.query}’s negative mentions`).join("; ") + ".");

  $("#cmp-results").innerHTML = `
    <div class="card insights"><div class="card-head"><h3>${icon("trending")} Headline</h3><span class="muted-sm">from ${fmt(rs.reduce((s, r) => s + r.summary.total, 0))} live mentions</span></div>
      <ul>${insights.map((t) => `<li class="ins info"><span class="ins-ico">${icon("info")}</span><span>${esc(t)}</span></li>`).join("")}</ul></div>
    <div class="grid-1-2">
      <div class="card"><div class="card-head"><h3>Share of voice</h3><span class="muted-sm" data-tip="Estimated mentions per day, summed over sources. Each source's rate = mentions fetched ÷ time span they cover.">est. mentions / day ${icon("info")}</span></div><div id="cmp-sov"></div></div>
      <div class="card"><div class="card-head"><h3>Net sentiment</h3><span class="muted-sm">% positive − % negative</span></div><div id="cmp-net"></div>
        <div class="sub-title" style="margin-top:22px">Sentiment mix</div><div id="cmp-mix"></div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Side by side</h3></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Brand</th><th>Mentions</th><th>Per day</th><th>Positive</th><th>Negative</th><th>Neutral</th><th>Net</th><th>Top negative word</th><th></th></tr></thead><tbody>
      ${rs.map((r) => { const s = r.summary, n = s.total || 1; return `<tr>
        <td><span class="brand-cell"><span class="sw" style="background:${r.color}"></span><b>${esc(r.query)}</b></span></td>
        <td class="tabular">${fmt(s.total)}</td><td class="tabular">${fmt(Math.round(s.mentions_per_day || 0))}</td>
        <td class="tabular t-pos">${pct(s.counts.positive / n)}</td><td class="tabular t-neg">${pct(s.counts.negative / n)}</td><td class="tabular">${pct(s.counts.neutral / n)}</td>
        <td class="tabular"><b class="${s.net_score > 0 ? "t-pos" : s.net_score < 0 ? "t-neg" : ""}">${s.net_score > 0 ? "+" : ""}${s.net_score}</b></td>
        <td>${s.keywords.negative[0] ? `<span class="badge negative">${esc(s.keywords.negative[0][0])}</span>` : "–"}</td>
        <td><button class="btn btn-ghost btn-xs" data-track="${esc(r.query)}" data-tip="Open in Brand Monitor">${icon("radar")}Monitor</button></td></tr>`; }).join("")}
      </tbody></table></div></div>`;

  donutItems($("#cmp-sov"), sov, { center: `${fmt(Math.round(totalRate))}`, sub: "mentions / day" });
  netBars($("#cmp-net"), rs.map((r) => ({ label: r.query, value: r.summary.net_score, color: r.color })));
  stackedRows($("#cmp-mix"), rs.map((r) => ({ label: r.query, color: r.color, counts: r.summary.counts, sub: `${fmt(r.summary.total)} mentions` })));
}

export { brands };
