import { icon, hydrateIcons } from "./icons.js";

export const LABELS = ["positive", "negative", "neutral"];
export const COLORS = {
  positive: "var(--pos)", negative: "var(--neg)", neutral: "var(--neu)",
};
export const SOFT = {
  positive: "var(--pos-soft)", negative: "var(--neg-soft)", neutral: "var(--neu-soft)",
};
export const FACE = { positive: "smile", negative: "frown", neutral: "meh" };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
export const fmt = (n) => new Intl.NumberFormat().format(n);
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------------------------------------------- toasts */
export function toast(title, { type = "success", body = "", ms = 3200 } = {}) {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  const ic = type === "error" ? "alert" : type === "info" ? "info" : "check";
  el.innerHTML = `<span class="ti">${icon(ic)}</span><div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ""}</div>`;
  wrap.appendChild(el);
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  setTimeout(kill, ms);
  el.addEventListener("click", kill);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
}

/* ----------------------------------------------------------------- modal */
export function confirmDialog({ title, body, ok = "Delete" }) {
  return new Promise((resolve) => {
    const m = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    $("#modal-ok").textContent = ok;
    m.hidden = false;
    $("#modal-ok").focus();
    const done = (v) => { m.hidden = true; cleanup(); resolve(v); };
    const onOk = () => done(true), onCancel = () => done(false);
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    const onBg = (e) => { if (e.target === m) done(false); };
    function cleanup() {
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      m.removeEventListener("click", onBg);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    m.addEventListener("click", onBg);
  });
}

/* -------------------------------------------------------------- tooltips */
// Any element with data-tip="..." gets a styled tooltip on hover/focus.
export function initTooltips() {
  const tip = $("#tooltip");
  let current = null;
  const show = (el) => {
    const text = el.dataset.tip; if (!text) return;
    current = el; tip.textContent = text; tip.hidden = false;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const below = el.dataset.tipPos === "bottom" || r.top < t.height + 16;
    let x = r.left + r.width / 2 - t.width / 2;
    x = Math.max(8, Math.min(x, innerWidth - t.width - 8));
    const y = below ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const hide = () => { current = null; tip.hidden = true; };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (el && el !== current) show(el); else if (!el && current) hide(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) show(el); });
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("click", () => current && hide());
}

/* ------------------------------------------------------------ downloads */
export function download(filename, content, type = "text/plain") {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCSV(headers, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    // Guard against CSV formula injection when opened in spreadsheet apps.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

export function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function badge(label) {
  return `<span class="badge ${label}">${cap(label)}</span>`;
}
export function confCell(label, c) {
  return `<div class="conf-cell"><div class="mini"><span style="width:${(c * 100).toFixed(1)}%;--c:${COLORS[label]}"></span></div><b>${pct(c)}</b></div>`;
}

/** Simple pager. Returns html for the pager bar. */
export function pagerHTML(page, pages, total, per) {
  if (total <= per) return total ? `<span>${fmt(total)} record${total === 1 ? "" : "s"}</span>` : "";
  const from = (page - 1) * per + 1, to = Math.min(total, page * per);
  return `<span>Showing <b>${fmt(from)}–${fmt(to)}</b> of ${fmt(total)}</span>
    <div class="row-gap"><button class="btn btn-ghost btn-xs" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${page} / ${pages}</span>
    <button class="btn btn-ghost btn-xs" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button></div>`;
}

export { icon, hydrateIcons };
