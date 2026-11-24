// Application shell: routing, theme, model status and wiring between views.
import { api } from "./api.js";
import { analyzer, mountAnalyzer } from "./analyzer.js";
import { initAnalytics, renderAnalytics, renderDashboard, renderHistoryPanel } from "./analytics.js";
import { initBatch, setBatchEnabled } from "./batch.js";
import { brands } from "./brands.js";
import { initCompare, setCompareReady } from "./compare.js";
import { CONFIG } from "./config.js";
import { initMonitor, render as renderMonitor, setMonitorReady } from "./monitor.js";
import { renderModel } from "./modelinfo.js";
import { history } from "./store.js";
import { $, $$, hydrateIcons, initTooltips, pct, toast } from "./utils.js";

const ROUTES = {
  dashboard: "Dashboard", analyze: "Sentiment Analyzer", batch: "Batch Analysis", analytics: "Analytics",
  monitor: "Brand Monitor", compare: "Compare Brands", model: "Model Information",
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
});

/* --------------------------------------------------------------- sidebar */
const sidebar = $("#sidebar"), scrim = $("#scrim");
const closeNav = () => { sidebar.classList.remove("open"); scrim.hidden = true; };
$("#menu-btn").addEventListener("click", () => { sidebar.classList.add("open"); scrim.hidden = false; });
scrim.addEventListener("click", closeNav);
$("#github-link").href = CONFIG.GITHUB_URL;

/* ---------------------------------------------------------------- router */
function go() {
  const name = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0];
  route = ROUTES[name] ? name : "dashboard";
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== route));
  $$(".nav-link[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  $("#crumb-page").textContent = ROUTES[route];
  document.title = `${ROUTES[route]} · SentimentAI`;
  const slot = $(`.slot[data-slot="${route}"]`);
  if (slot && analyzer.node.parentElement !== slot) slot.appendChild(analyzer.node);
  closeNav();
  renderRoute();
  window.scrollTo({ top: 0 });
}

function renderRoute() {
  if (route === "dashboard") renderDashboard();
  if (route === "analyze") renderHistoryPanel(analyzer.currentId);
  if (route === "analytics") renderAnalytics();
  if (route === "model") renderModel(metrics, metricsError);
  if (route === "monitor") renderMonitor();
}

function openEntry(id) {
  const e = history.get(id);
  if (!e) return;
  analyzer.show(e);
  if (route !== "analyze" && route !== "dashboard") location.hash = "#/analyze";
  else requestAnimationFrame(() => analyzer.node.querySelector("#az-result")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

/* ----------------------------------------------------------- model status */
async function checkModel() {
  const pill = $("#model-pill");
  try {
    const h = await api.health();
    if (!h.model_ready) {
      pill.dataset.state = "missing";
      $("#model-pill-title").textContent = "Model not trained";
      $("#model-pill-sub").textContent = "Run scripts/train.py";
      $("#setup-banner").hidden = false;
      metricsError = "The server is running but no trained model was found in models/.";
      setReady(false);
      return;
    }
    metrics = await api.model();
    window.__modelName = metrics.model.name;
    pill.dataset.state = "ready";
    $("#model-pill-title").textContent = "Model ready";
    $("#model-pill-sub").textContent = `${pct(metrics.test.accuracy, 1)} test accuracy`;
    $("#hero-eyebrow span").textContent = `TF-IDF + Logistic Regression · ${pct(metrics.test.accuracy, 1)} test accuracy`;
    setReady(true);
  } catch (err) {
    pill.dataset.state = "offline";
    $("#model-pill-title").textContent = "Server offline";
    $("#model-pill-sub").textContent = "Start it with run.sh";
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
initMonitor({ analyze: (text) => { location.hash = "#/analyze"; analyzer.analyze(text); } });
initCompare({ onTrack: (q) => { const b = brands.get(q.toLowerCase()); if (b) brands.setActive(b.key); location.hash = "#/monitor"; if (!b) import("./monitor.js").then((m) => m.run(q)); } });
brands.subscribe(() => route === "monitor" && renderMonitor());
history.subscribe(() => renderRoute());
analyzer.onChange(() => route === "analyze" && renderHistoryPanel(analyzer.currentId));
addEventListener("hashchange", go);
addEventListener("storage", (e) => { if (e.key?.startsWith("sentimentai.history")) location.reload(); });
go();
checkModel();
