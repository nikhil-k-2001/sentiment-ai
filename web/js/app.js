// Application shell: routing, theme, model status and wiring between views.
import { api } from "./api.js";
import { analyzer, mountAnalyzer } from "./analyzer.js";
import { initAnalytics, renderAnalytics, renderDashboard, renderHistoryPanel } from "./analytics.js";
import { initBatch, loadSample as loadBatchSample, setBatchEnabled } from "./batch.js";
import { brands } from "./brands.js";
import { initCompare, runPreset, setCompareReady } from "./compare.js";
import { initEmployees, render as renderEmployees, trySample as tryEmployeeSample } from "./employees.js";
import { initMonitor, render as renderMonitor, run as runMonitor, setMonitorReady } from "./monitor.js";
import { renderModel } from "./modelinfo.js";
import { initOverview, renderOverview } from "./overview.js";
import { history } from "./store.js";
import { $, $$, hydrateIcons, initTooltips, toast } from "./utils.js";

const ROUTES = {
  dashboard: "Overview", monitor: "Brand Monitoring", compare: "Compare Brands", batch: "Customer Feedback",
  employees: "Employee Insights", analyze: "Text Analyzer", analytics: "History & Usage", model: "About & Methodology",
};
let route = "dashboard";
let metrics = null, metricsError = null;

/* ------------------------------------------------------------------ theme */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("sentimentai.theme", t); } catch { /* ignore */ }
}
$("#theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(next);
  $("#theme-btn").setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
});

/* --------------------------------------------------------------- sidebar */
const sidebar = $("#sidebar"), scrim = $("#scrim");
const closeNav = () => { sidebar.classList.remove("open"); scrim.hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); };
$("#menu-btn").addEventListener("click", () => {
  sidebar.classList.add("open"); scrim.hidden = false; $("#menu-btn").setAttribute("aria-expanded", "true");
  sidebar.querySelector(".nav-link")?.focus();
});
scrim.addEventListener("click", closeNav);
addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebar.classList.contains("open")) { closeNav(); $("#menu-btn").focus(); } });

// Clickable non-button elements (chips, table rows) behave like buttons on the keyboard.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target;
  if (el.matches?.('[role="button"][tabindex], .brand-chip[tabindex]') && el.tagName !== "BUTTON") { e.preventDefault(); el.click(); }
});

/* ---------------------------------------------------------------- router */
function go() {
  const name = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0];
  route = ROUTES[name] ? name : "dashboard";
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== route));
  $$(".nav-link[data-route]").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
    if (a.dataset.route === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("#crumb-page").textContent = ROUTES[route];
  document.title = `${ROUTES[route]} · SentimentAI`;
  const slot = $(`.slot[data-slot="${route}"]`);
  if (slot && analyzer.node.parentElement !== slot) slot.appendChild(analyzer.node);
  closeNav();
  renderRoute();
  window.scrollTo({ top: 0 });
  // Move focus to the page heading for screen-reader and keyboard users.
  const h = $(`.view[data-view="${route}"] h1`);
  if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}

function renderRoute() {
  if (route === "dashboard") { renderOverview(); renderDashboard(); }
  if (route === "analyze") renderHistoryPanel(analyzer.currentId);
  if (route === "analytics") renderAnalytics();
  if (route === "model") renderModel(metrics, metricsError);
  if (route === "monitor") renderMonitor();
  if (route === "employees") renderEmployees();
}

function openEntry(id) {
  const e = history.get(id);
  if (!e) return;
  analyzer.show(e);
  if (route !== "analyze") location.hash = "#/analyze";
  else requestAnimationFrame(() => analyzer.node.querySelector("#az-result")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

const analyzeText = (text) => { location.hash = "#/analyze"; analyzer.analyze(text); };

/* ----------------------------------------------------------- model status */
async function checkModel() {
  try {
    const h = await api.health();
    if (!h.model_ready) {
      $("#setup-banner").hidden = false;
      metricsError = "The server is running but no trained model was found in models/.";
      setReady(false);
      return;
    }
    metrics = await api.model();
    window.__modelName = metrics.model.name;
    setReady(true);
  } catch (err) {
    metricsError = err.message;
    setReady(false);
    toast("Can't reach the server", { type: "error", body: err.message, ms: 6000 });
  }
  if (route === "model") renderModel(metrics, metricsError);
}

function setReady(ok) { analyzer.setModelReady(ok); setBatchEnabled(ok); setMonitorReady(ok); setCompareReady(ok); }

/* ------------------------------------------------------------------ boot */
hydrateIcons();
initTooltips();
mountAnalyzer();
initBatch();
initAnalytics({ onOpen: openEntry });
initMonitor({ analyze: analyzeText });
initEmployees({ analyze: analyzeText });
initCompare({ onTrack: (q) => { const b = brands.get(q.toLowerCase()); if (b) brands.setActive(b.key); location.hash = "#/monitor"; if (!b) runMonitor(q); } });
initOverview({
  text: analyzeText,
  monitor: () => { location.hash = "#/monitor"; runMonitor("Spotify"); },
  batch: () => { location.hash = "#/batch"; loadBatchSample(); },
  compare: () => { location.hash = "#/compare"; runPreset(1); },
  employees: () => { location.hash = "#/employees"; tryEmployeeSample(); },
});
brands.subscribe(() => {
  if (route === "monitor") renderMonitor();
  if (route === "employees") renderEmployees();
  if (route === "dashboard") renderOverview();
});
history.subscribe(() => renderRoute());
analyzer.onChange(() => route === "analyze" && renderHistoryPanel(analyzer.currentId));
addEventListener("hashchange", go);
addEventListener("storage", (e) => { if (e.key?.startsWith("sentimentai.")) location.reload(); });
go();
checkModel();
