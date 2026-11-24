// Overview: the first screen. Explains what SentimentAI does through the
// questions it answers, offers a sample for every workflow, and summarises
// the brands the user already tracks.
import { brands } from "./brands.js";
import { $, esc, fmt, icon, timeAgo } from "./utils.js";

const WORKFLOWS = [
  { id: "monitor", icon: "radar", title: "Monitor a brand", q: "How do people feel about us right now, and what are they complaining about?", who: "Marketing · Founders",
    go: "#/monitor", cta: "Start monitoring", sample: "Try with Spotify" },
  { id: "batch", icon: "layers", title: "Analyse customer feedback", q: "What are the biggest problems in our reviews, surveys or support tickets?", who: "Product · Support",
    go: "#/batch", cta: "Upload a CSV", sample: "Try sample feedback" },
  { id: "compare", icon: "scale", title: "Compare competitors", q: "Who gets talked about most, and who is viewed most positively?", who: "Founders · Strategy",
    go: "#/compare", cta: "Compare brands", sample: "Try Spotify vs Apple Music" },
  { id: "employees", icon: "users", title: "Understand employee reviews", q: "What do employees value, and what keeps coming up in complaints?", who: "HR · People teams",
    go: "#/employees", cta: "Import reviews", sample: "Try sample reviews" },
];

let actions = {};

export function initOverview(handlers) {
  actions = handlers;
  $("#workflows").innerHTML = WORKFLOWS.map((w) => `
    <article class="card workflow">
      <div class="wf-top"><span class="wf-icon">${icon(w.icon)}</span><span class="wf-who">${w.who}</span></div>
      <h3>${w.title}</h3>
      <p>${w.q}</p>
      <div class="wf-actions"><a class="btn btn-primary btn-sm" href="${w.go}">${w.cta}${icon("arrow")}</a>
        <button class="btn btn-ghost btn-sm" data-sample="${w.id}">${w.sample}</button></div>
    </article>`).join("");
  $("#workflows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sample]");
    if (b) actions[b.dataset.sample]?.();
  });
  $("#quick-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("#quick-input").value.trim();
    if (!t) { $("#quick-input").focus(); return; }
    actions.text?.(t);
    $("#quick-input").value = "";
  });
  $("#dash-brands").addEventListener("click", (e) => {
    const row = e.target.closest("[data-brand]");
    if (!row) return;
    brands.setActive(row.dataset.brand);
    location.hash = row.dataset.target;
  });
  $("#dash-brands").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-brand]")) { e.preventDefault(); e.target.closest("[data-brand]").click(); }
  });
}

export function renderOverview() {
  const list = brands.all();
  $("#dash-brands-wrap").hidden = !list.length;
  if (!list.length) return;
  $("#dash-brands tbody").innerHTML = list.map((b) => {
    const last = b.runs.at(-1), prev = b.runs.at(-2);
    const delta = last && prev && last.total >= 20 && prev.total >= 20 ? last.net - prev.net : null;
    const rating = b.reviews?.summary?.avg_rating;
    const target = last ? "#/monitor" : "#/employees";
    return `<tr class="row-btn" data-brand="${b.key}" data-target="${target}" tabindex="0" aria-label="Open ${esc(b.query)}">
      <td><b>${esc(b.query)}</b></td>
      <td class="tabular">${last ? fmt(last.total) : "<span class='muted-sm'>not checked</span>"}</td>
      <td class="tabular">${last ? `<b class="${last.net > 0 ? "t-pos" : last.net < 0 ? "t-neg" : ""}">${last.net > 0 ? "+" : ""}${last.net}</b>` : "–"}</td>
      <td class="tabular">${delta == null ? `<span class="muted-sm">${prev ? "too few mentions" : "first check"}</span>` : `<span class="${delta > 0 ? "t-pos" : delta < 0 ? "t-neg" : ""}">${delta > 0 ? "▲ +" : delta < 0 ? "▼ " : "± "}${delta}</span>`}</td>
      <td class="tabular">${rating != null ? `${rating.toFixed(2)}★ <span class="muted-sm">(${b.reviews.summary.rated})</span>` : "–"}</td>
      <td class="when">${last ? timeAgo(last.ts) : "–"}</td></tr>`;
  }).join("");
}
