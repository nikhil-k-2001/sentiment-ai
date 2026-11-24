// Dependency-free SVG charts. All colours come from CSS variables so charts
// follow the light/dark theme automatically.
import { COLORS, LABELS, cap, esc, fmt, pct } from "./utils.js";

/* ---------------------------------------------------------------- gauge */
export function gauge(value, tone) {
  const r = 70, c = 2 * Math.PI * r;
  return `<div class="gauge" style="--tone:${tone}">
    <svg viewBox="0 0 168 168"><circle class="track" cx="84" cy="84" r="${r}" fill="none" stroke-width="12"/>
      <circle class="value" cx="84" cy="84" r="${r}" fill="none" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - value)}"/></svg>
    <div class="gauge-center"><strong data-count="${value}">0%</strong><small>Confidence</small></div></div>`;
}

/** Kick off entrance animations (gauge sweep, count-up, bar widths) in root. */
export function animateIn(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll("[data-target]").forEach((el) => (el.style.strokeDashoffset = el.dataset.target));
    root.querySelectorAll("[data-width]").forEach((el) => (el.style.width = el.dataset.width));
    root.querySelectorAll("[data-count]").forEach((el) => {
      const end = parseFloat(el.dataset.count), t0 = performance.now(), dur = 1000;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        el.textContent = pct(end * e); if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }));
}

/* ---------------------------------------------------------------- donut */
export function donut(el, counts, { center = "Analysed" } = {}) {
  const total = LABELS.reduce((s, l) => s + (counts[l] || 0), 0);
  const r = 70, c = 2 * Math.PI * r;
  let offset = 0;
  const segs = total ? LABELS.map((l) => {
    const v = counts[l] || 0; if (!v) return "";
    const len = (v / total) * c, gap = total === v ? 0 : 2.5;
    const s = `<circle class="seg" cx="90" cy="90" r="${r}" fill="none" stroke="${COLORS[l]}" stroke-width="16"
      stroke-dasharray="0 ${c}" data-dash="${Math.max(len - gap, 0.1)} ${c}" stroke-dashoffset="${-offset}"
      data-tip="${cap(l)}: ${fmt(v)} (${pct(v / total, 1)})"></circle>`;
    offset += len; return s;
  }).join("") : "";
  el.innerHTML = `<div class="donut-wrap">
    <div class="donut"><svg viewBox="0 0 180 180"><circle cx="90" cy="90" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="16"/>${segs}</svg>
      <div class="donut-center"><strong>${fmt(total)}</strong><small>${esc(center)}</small></div></div>
    <div class="donut-legend">${LABELS.map((l) => `<div><span class="sw" style="background:${COLORS[l]}"></span><span>${cap(l)}</span>
      <span class="n">${fmt(counts[l] || 0)}</span><span class="p">${total ? pct((counts[l] || 0) / total) : "–"}</span></div>`).join("")}</div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() =>
    el.querySelectorAll("circle.seg").forEach((s) => (s.style.strokeDasharray = s.dataset.dash))));
}

/* ------------------------------------------------------------ trend line */
function buckets(entries) {
  const now = Date.now();
  const oldest = Math.min(...entries.map((e) => e.ts));
  const hourly = now - oldest < 36 * 3600e3;
  const size = hourly ? 3600e3 : 86400e3;
  const floor = (t) => {
    const d = new Date(t);
    if (hourly) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const end = floor(now);
  const n = Math.min(hourly ? 24 : 30, Math.max(6, Math.round((end - floor(oldest)) / size) + 1));
  const list = Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * size, positive: 0, negative: 0, neutral: 0 }));
  const start = list[0].t;
  for (const e of entries) {
    const idx = Math.round((floor(e.ts) - start) / size);
    if (idx >= 0 && idx < n) list[idx][e.label]++;
  }
  const label = (t) => hourly
    ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric" })
    : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { list, hourly, label };
}

function smooth(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

export function trend(el, entries) {
  const { list, hourly, label } = buckets(entries);
  const W = Math.max(300, el.clientWidth || 640), H = 230, L = 34, R = 10, T = 10, B = 28;
  const max = Math.max(1, ...list.flatMap((b) => LABELS.map((l) => b[l])));
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const x = (i) => L + (i * (W - L - R)) / (list.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / niceMax);
  const ticks = [0, .25, .5, .75, 1].map((k) => Math.round(niceMax * k)).filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(list.length / Math.max(3, Math.floor(W / 80)));
  const lines = LABELS.map((l) => {
    const pts = list.map((b, i) => [x(i), y(b[l])]);
    const path = smooth(pts);
    return `<path d="${path} L${x(list.length - 1)},${y(0)} L${x(0)},${y(0)}Z" fill="url(#g-${l})" opacity=".55"/>
      <path d="${path}" fill="none" stroke="${COLORS[l]}" stroke-width="2.2" stroke-linecap="round" class="trend-line"/>`;
  }).join("");
  el.innerHTML = `<div class="chart-legend">${LABELS.map((l) => `<span style="--c:${COLORS[l]}">${cap(l)}</span>`).join("")}</div>
  <div class="chart"><svg viewBox="0 0 ${W} ${H}" style="aspect-ratio:${W}/${H}">
    <defs>${LABELS.map((l) => `<linearGradient id="g-${l}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${COLORS[l]}" stop-opacity=".28"/><stop offset="1" stop-color="${COLORS[l]}" stop-opacity="0"/></linearGradient>`).join("")}</defs>
    ${ticks.map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
    ${list.map((b, i) => (i % every === 0 || i === list.length - 1) ? `<text class="axis-text" x="${x(i)}" y="${H - 8}" text-anchor="middle">${label(b.t)}</text>` : "").join("")}
    ${lines}
    <line class="guide" x1="0" x2="0" y1="${T}" y2="${H - B}" opacity="0"/>
    ${LABELS.map((l) => `<circle class="dot-${l}" r="4" fill="var(--surface)" stroke="${COLORS[l]}" stroke-width="2" opacity="0"/>`).join("")}
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
  </svg><div class="chart-tip" style="opacity:0"></div></div>`;

  const svg = el.querySelector("svg"), tip = el.querySelector(".chart-tip"), guide = el.querySelector(".guide");
  const move = (evt) => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(list.length - 1, Math.round(((px - L) / (W - L - R)) * (list.length - 1))));
    const b = list[i];
    guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i)); guide.setAttribute("opacity", 1);
    LABELS.forEach((l) => { const d = el.querySelector(`.dot-${l}`); d.setAttribute("cx", x(i)); d.setAttribute("cy", y(b[l])); d.setAttribute("opacity", 1); });
    const when = hourly ? new Date(b.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }) : label(b.t);
    tip.innerHTML = `<b>${esc(when)}</b>${LABELS.map((l) => `<div style="--c:${COLORS[l]}">${cap(l)}: ${b[l]}</div>`).join("")}`;
    tip.style.left = `${(x(i) / W) * r.width}px`; tip.style.top = `${(Math.min(...LABELS.map((l) => y(b[l]))) / H) * r.height}px`;
    tip.style.opacity = 1;
  };
  const leave = () => { tip.style.opacity = 0; guide.setAttribute("opacity", 0); el.querySelectorAll("circle[class^=dot-]").forEach((d) => d.setAttribute("opacity", 0)); };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", leave);
  return hourly ? "Hourly · last 24 hours" : `Daily · last ${list.length} days`;
}

/* --------------------------------------------------------- horizontal bars */
export function hbars(el, rows) {
  // rows: [{label, value (0..1), sub, color}]
  el.innerHTML = `<div class="hbars">${rows.map((r) => `
    <div class="prob-row" style="--c:${r.color}"><span class="lbl">${esc(r.label)}</span>
      <div class="prob-track" data-tip="${esc(r.sub)}"><div class="prob-fill" data-width="${(r.value * 100).toFixed(1)}%"></div></div>
      <span class="pct">${r.value ? pct(r.value) : "–"}</span></div>`).join("")}</div>`;
  animateIn(el);
}

/* -------------------------------------------------------------- histogram */
export function histogram(el, entries) {
  // Confidence of a 3-class prediction is always >= 33.3%.
  const edges = [0.333, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
  const names = ["33–50%", "50–60%", "60–70%", "70–80%", "80–90%", "90–100%"];
  const short = (el.clientWidth || 640) < 420;
  const bins = names.map(() => ({ positive: 0, negative: 0, neutral: 0 }));
  for (const e of entries) {
    const i = edges.findIndex((v, k) => k < edges.length - 1 && e.confidence >= v && e.confidence < edges[k + 1]);
    if (i >= 0) bins[i][e.label]++;
  }
  const W = Math.max(300, el.clientWidth || 640), H = 210, L = 30, B = 26, T = 8;
  const totals = bins.map((b) => b.positive + b.negative + b.neutral);
  const max = Math.max(1, ...totals);
  const bw = (W - L) / bins.length;
  const bars = bins.map((b, i) => {
    let y0 = H - B;
    return LABELS.map((l) => {
      const h = (b[l] / max) * (H - B - T); if (!h) return "";
      y0 -= h;
      return `<rect x="${L + i * bw + bw * 0.18}" y="${y0}" width="${bw * 0.64}" height="${h}" rx="3" fill="${COLORS[l]}"
        data-tip="${names[i]} · ${cap(l)}: ${b[l]}"/>`;
    }).join("") + `<text class="axis-text" x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${short ? names[i].replace("%", "").replace(/–\d+/, "+") : names[i]}</text>`;
  }).join("");
  el.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" style="aspect-ratio:${W}/${H}">
    <line class="grid-line" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/>
    <text class="axis-text" x="${L - 8}" y="${T + 8}" text-anchor="end">${max}</text>
    <text class="axis-text" x="${L - 8}" y="${H - B}" text-anchor="end">0</text>${bars}</svg></div>`;
}

/* ----------------------------------------------------- generic donut (any items) */
export function donutItems(el, items, { center = "", sub = "" } = {}) {
  // items: [{label, value, color, display?}]
  const total = items.reduce((s, i) => s + i.value, 0);
  const r = 70, c = 2 * Math.PI * r;
  let offset = 0;
  const segs = total ? items.map((it) => {
    if (!it.value) return "";
    const len = (it.value / total) * c, gap = items.filter((x) => x.value).length > 1 ? 2.5 : 0;
    const s = `<circle class="seg" cx="90" cy="90" r="${r}" fill="none" stroke="${it.color}" stroke-width="16"
      stroke-dasharray="0 ${c}" data-dash="${Math.max(len - gap, 0.1)} ${c}" stroke-dashoffset="${-offset}"
      data-tip="${esc(it.label)}: ${esc(it.display ?? fmt(it.value))} (${pct(it.value / total, 1)})"></circle>`;
    offset += len; return s;
  }).join("") : "";
  el.innerHTML = `<div class="donut-wrap">
    <div class="donut"><svg viewBox="0 0 180 180"><circle cx="90" cy="90" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="16"/>${segs}</svg>
      <div class="donut-center"><strong>${esc(center)}</strong><small>${esc(sub)}</small></div></div>
    <div class="donut-legend">${items.map((it) => `<div><span class="sw" style="background:${it.color}"></span><span>${esc(it.label)}</span>
      <span class="n">${esc(it.display ?? fmt(it.value))}</span><span class="p">${total ? pct(it.value / total) : "–"}</span></div>`).join("")}</div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() =>
    el.querySelectorAll("circle.seg").forEach((s) => (s.style.strokeDasharray = s.dataset.dash))));
}

/* ------------------------------------------- stacked sentiment bars per row */
export function stackedRows(el, rows) {
  // rows: [{label, sub, counts:{positive,negative,neutral}, color?}]
  const order = ["positive", "neutral", "negative"];
  el.innerHTML = `<div class="srows">${rows.map((r) => {
    const n = order.reduce((s, l) => s + (r.counts[l] || 0), 0) || 1;
    return `<div class="srow"><div class="srow-head"><span class="srow-label">${r.color ? `<span class="sw" style="background:${r.color}"></span>` : ""}${esc(r.label)}</span><span class="srow-sub">${r.sub || ""}</span></div>
      <div class="sbar">${order.map((l) => r.counts[l] ? `<span style="--w:${(r.counts[l] / n) * 100}%;background:${COLORS[l]}" data-tip="${cap(l)}: ${r.counts[l]} (${pct(r.counts[l] / n)})"></span>` : "").join("")}</div></div>`;
  }).join("")}</div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".sbar span").forEach((s) => s.classList.add("in"))));
}

/* ---------------------------------------- diverging net-sentiment bars */
export function netBars(el, rows) {
  // rows: [{label, value (-100..100), color}]
  el.innerHTML = `<div class="netbars">${rows.map((r) => `<div class="netrow">
    <span class="netlabel"><span class="sw" style="background:${r.color}"></span>${esc(r.label)}</span>
    <div class="nettrack"><span class="netmid"></span><span class="netfill ${r.value >= 0 ? "pos" : "neg"}" style="--w:${Math.min(50, Math.abs(r.value) / 2)}%"></span></div>
    <b class="netval ${r.value > 0 ? "t-pos" : r.value < 0 ? "t-neg" : ""}">${r.value > 0 ? "+" : ""}${r.value}</b></div>`).join("")}
    <div class="netrow netaxis-row"><span></span><div class="netaxis"><span>−100</span><span>0</span><span>+100</span></div><span></span></div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".netfill").forEach((s) => s.classList.add("in"))));
}

/* ------------------------------------- stacked bars per week / month */
export function periodBars(el, entries) {
  // entries: [{ts (ms), label}] -> stacked sentiment bars per week or month.
  const ts = entries.map((e) => e.ts).filter(Number.isFinite);
  const span = Math.max(...ts) - Math.min(...ts);
  const monthly = span > 120 * 86400e3;
  const keyOf = (t) => {
    const d = new Date(t);
    if (monthly) return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const day = (d.getDay() + 6) % 7; // Monday-based weeks
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
  };
  const buckets = new Map();
  for (const e of entries) {
    if (!Number.isFinite(e.ts)) continue;
    const k = keyOf(e.ts);
    if (!buckets.has(k)) buckets.set(k, { t: k, positive: 0, negative: 0, neutral: 0 });
    buckets.get(k)[e.label]++;
  }
  // Fill gaps so time reads left-to-right evenly.
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const list = [];
  for (let t = keys[0]; t <= keys.at(-1);) {
    list.push(buckets.get(t) || { t, positive: 0, negative: 0, neutral: 0 });
    const d = new Date(t);
    t = monthly ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    if (list.length > 60) break;
  }
  const W = Math.max(300, el.clientWidth || 640), H = 210, L = 30, B = 26, T = 8;
  const max = Math.max(1, ...list.map((b) => b.positive + b.negative + b.neutral));
  const bw = (W - L) / list.length;
  const fmtT = (t) => new Date(t).toLocaleDateString(undefined, monthly ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" });
  const every = Math.ceil(list.length / Math.max(3, Math.floor(W / 70)));
  const order = ["positive", "neutral", "negative"];
  const bars = list.map((b, i) => {
    let y0 = H - B;
    return order.map((l) => {
      const h = (b[l] / max) * (H - B - T); if (!h) return "";
      y0 -= h;
      return `<rect x="${L + i * bw + bw * 0.18}" y="${y0}" width="${Math.max(2, bw * 0.64)}" height="${h}" rx="3" fill="${COLORS[l]}"
        data-tip="${monthly ? "Month" : "Week"} of ${fmtT(b.t)} · ${cap(l)}: ${b[l]}"/>`;
    }).join("") + (i % every === 0 ? `<text class="axis-text" x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${fmtT(b.t)}</text>` : "");
  }).join("");
  el.innerHTML = `<div class="chart-legend">${order.map((l) => `<span style="--c:${COLORS[l]}">${cap(l)}</span>`).join("")}</div>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" style="aspect-ratio:${W}/${H}">
    <line class="grid-line" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/>
    <text class="axis-text" x="${L - 8}" y="${T + 8}" text-anchor="end">${max}</text>
    <text class="axis-text" x="${L - 8}" y="${H - B}" text-anchor="end">0</text>${bars}</svg></div>`;
  return monthly ? "Monthly" : "Weekly";
}
