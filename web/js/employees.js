// Employee Insights page: pick or add a company, then import and explore its
// employee reviews. The review tooling itself lives in reviews.js.
import { brands } from "./brands.js";
import { initReviews, loadSamples, renderReviewsTab, resetReviewFeed } from "./reviews.js";
import { $, esc, fmt, icon, toast } from "./utils.js";

export function initEmployees({ analyze }) {
  initReviews($("#mon-reviews"), { analyze });
  $("#emp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#emp-name").value.trim().replace(/\s+/g, " ");
    if (name.length < 2 || !/[A-Za-z]/.test(name)) { toast("Enter a company name", { type: "error", body: "At least 2 characters, e.g. “Infosys”." }); $("#emp-name").focus(); return; }
    brands.ensure(name);
    $("#emp-name").value = "";
    resetReviewFeed();
    render();
  });
  $("#emp-companies").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-brand]");
    if (chip) { resetReviewFeed(); brands.setActive(chip.dataset.brand); render(); }
  });
  $("#emp-sample").addEventListener("click", trySample);
}

export async function trySample() {
  const btn = $("#emp-sample");
  if (btn) btn.disabled = true;
  try {
    await loadSamples();
    resetReviewFeed();
    render();
    toast("Sample reviews loaded", { body: "40 synthetic Glassdoor & AmbitionBox reviews for a fictional company." });
  } catch (err) {
    toast("Couldn't load samples", { type: "error", body: err.message });
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function render() {
  const all = brands.all(), b = brands.active();
  $("#emp-companies").innerHTML = all.length ? all.map((x) => {
    const n = x.reviews?.items?.length || 0, avg = x.reviews?.summary?.avg_rating;
    return `<div class="brand-chip ${b && x.key === b.key ? "active" : ""}" data-brand="${x.key}" role="button" tabindex="0" aria-pressed="${!!(b && x.key === b.key)}">
      <span class="bc-net">${n ? (avg != null ? `${avg.toFixed(1)}★` : fmt(n)) : "–"}</span><span>${esc(x.query)}</span></div>`;
  }).join("") : `<span class="muted-sm">none yet</span>`;
  $("#emp-empty").hidden = !!b;
  $("#mon-reviews").hidden = !b;
  if (b) renderReviewsTab(b);
}

export { icon };
