// "Employee reviews" tab of the Brand Monitor: import Glassdoor / AmbitionBox /
// other reviews (CSV or pasted text), analyse them, and show what people like
// and dislike. Nothing is scraped — users import reviews they collected.
import { api } from "./api.js";
import { brands } from "./brands.js";
import { periodBars, stackedRows } from "./charts.js";
import {
  $, COLORS, LABELS, SOFT, badge, cap, confirmDialog, debounce, download, esc, fmt, icon, pagerHTML, pct, stamp, timeAgo, toCSV, toast,
} from "./utils.js";

export const PLATFORM_META = {
  glassdoor: { name: "Glassdoor", color: "#0caa41" },
  ambitionbox: { name: "AmbitionBox", color: "#1e4fd6" },
  other: { name: "Other reviews", color: "#8b5cf6" },
};
const MAX_PER_BRAND = 1500;
const ORDER = ["positive", "neutral", "negative"];
const PER_PAGE = 15;
const PASTE_HINT = `Title: Great place to learn
Rating: 4
Pros: Supportive manager and flexible hours
Cons: Salary hikes are low

Likes: Good work-life balance
Dislikes: Too many meetings
Rating: 3`;

let ui = { platform: "glassdoor", mode: "file", file: null, paste: "", open: null, busy: false };
let feed = { filter: "all", platform: "all", rating: "all", sort: "newest", q: "", page: 1 };
let onAnalyze = () => {};
let root = null;

const uid = () => Math.random().toString(36).slice(2, 10);
const stars = (r) => (r == null ? "" : `<span class="stars" aria-label="${r} out of 5 stars" data-tip="${r} / 5">${"★".repeat(Math.round(r))}<span class="off">${"★".repeat(5 - Math.round(r))}</span></span>`);

export function initReviews(container, { analyze }) {
  root = container;
  onAnalyze = analyze;
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", (e) => { if (e.target.id === "rv-paste") ui.paste = e.target.value; });
  root.addEventListener("input", debounce((e) => {
    if (e.target.id === "rv-search") { feed.q = e.target.value.trim().toLowerCase(); feed.page = 1; renderFeed(); }
  }, 150));
  ["dragenter", "dragover"].forEach((t) => root.addEventListener(t, (e) => {
    const dz = e.target.closest?.("#rv-drop"); if (!dz) return; e.preventDefault(); dz.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((t) => root.addEventListener(t, (e) => {
    const dz = e.target.closest?.("#rv-drop"); if (!dz) return; e.preventDefault(); dz.classList.remove("drag");
    if (t === "drop" && e.dataTransfer?.files?.[0]) pickFile(e.dataTransfer.files[0]);
  }));
}

export function resetReviewFeed() { feed = { filter: "all", platform: "all", rating: "all", sort: "newest", q: "", page: 1 }; ui.open = null; }

/* --------------------------------------------------------------- import */
function pickFile(f) {
  if (!/\.(csv|txt)$/i.test(f.name)) return toast("Unsupported file", { type: "error", body: "Please choose a .csv file." });
  if (f.size > 4 * 1024 * 1024) return toast("File too large", { type: "error", body: "The limit is 4 MB." });
  ui.file = f;
  const dz = $("#rv-drop", root);
  if (dz) { dz.querySelector("strong").innerHTML = `${icon("file")} ${esc(f.name)}`; dz.querySelector("small").textContent = `${(f.size / 1024).toFixed(1)} KB · ready to import`; }
}

async function doImport(brand) {
  if (ui.busy) return;
  const text = $("#rv-paste", root)?.value || "";
  if (ui.mode === "file" && !ui.file) return toast("Choose a CSV file first", { type: "error", body: "Or switch to “Paste text”." });
  if (ui.mode === "paste" && !text.trim()) return toast("Paste some reviews first", { type: "error" });
  ui.busy = true;
  setBusy(true, "Reading reviews…");
  try {
    const parsed = await api.reviewsParse(ui.platform, ui.mode === "file" ? { file: ui.file } : { text });
    const importId = uid();
    const fresh = parsed.reviews.map((r) => ({ ...r, id: uid(), import_id: importId }));
    const existing = brand.reviews?.items || [];
    const sig = (r) => [r.platform, r.title, r.text, r.pros, r.cons].join("\u0001").toLowerCase();
    const seen = new Set(existing.map(sig));
    const unique = fresh.filter((r) => !seen.has(sig(r)) && seen.add(sig(r)));
    if (!unique.length) { toast("Nothing new to import", { type: "info", body: "These reviews are already imported for this brand." }); return; }
    let all = [...existing, ...unique];
    const dropped = Math.max(0, all.length - MAX_PER_BRAND);
    if (dropped) all = all.slice(dropped);
    setBusy(true, `Analysing ${fmt(all.length)} reviews…`);
    const analysed = await api.reviewsAnalyze(all);
    const imports = [...(brand.reviews?.imports || []), {
      id: importId, platform: ui.platform, name: ui.mode === "file" ? ui.file.name : "Pasted text", ts: Date.now(), count: unique.length,
    }].filter((imp) => analysed.reviews.some((r) => r.import_id === imp.id));
    brands.setReviews(brand.key, { imports, items: analysed.reviews, summary: analysed.summary });
    ui.file = null; ui.paste = ""; ui.open = false; resetFeedKeepOpen();
    const notes = [];
    if (fresh.length - unique.length) notes.push(`${fresh.length - unique.length} duplicates skipped`);
    if (parsed.skipped) notes.push(`${parsed.skipped} empty rows skipped`);
    if (dropped) notes.push(`oldest ${dropped} removed (limit ${fmt(MAX_PER_BRAND)})`);
    if (parsed.mapping) notes.push(`columns: ${Object.entries(parsed.mapping).filter(([k]) => ["pros", "cons", "text", "rating"].includes(k)).map(([k, v]) => `${k}→“${v}”`).join(", ")}`);
    toast(`Imported ${fmt(unique.length)} ${ui.platform === "other" ? "" : PLATFORM_META[ui.platform].name + " "}review${unique.length === 1 ? "" : "s"}`, { body: notes.join(" · "), ms: 5500 });
  } catch (err) {
    toast("Import failed", { type: "error", body: err.message, ms: 6000 });
    setBusy(false);
  } finally {
    ui.busy = false;
  }
}

function resetFeedKeepOpen() { feed = { filter: "all", platform: "all", rating: "all", sort: "newest", q: "", page: 1 }; }

function setBusy(on, label = "") {
  const btn = $("#rv-import", root); if (!btn) return;
  btn.disabled = on;
  btn.innerHTML = on ? `<span class="spinner"></span><span>${esc(label)}</span>` : `${icon("upload")}<span>Import & analyse</span>`;
}

async function removeImport(brand, id) {
  const imp = brand.reviews.imports.find((i) => i.id === id); if (!imp) return;
  const ok = await confirmDialog({ title: `Remove “${imp.name}”?`, body: `Its ${imp.count} reviews will be removed from ${brand.query} and the rest re-analysed.`, ok: "Remove" });
  if (!ok) return;
  const rest = brand.reviews.items.filter((r) => r.import_id !== id);
  if (!rest.length) { brands.setReviews(brand.key, null); toast("Import removed"); return; }
  try {
    const analysed = await api.reviewsAnalyze(rest);
    brands.setReviews(brand.key, { imports: brand.reviews.imports.filter((i) => i.id !== id), items: analysed.reviews, summary: analysed.summary });
    toast("Import removed", { body: `${fmt(rest.length)} reviews remain.` });
  } catch (err) { toast("Couldn't re-analyse", { type: "error", body: err.message }); }
}

/** Load both bundled sample files into a demo brand. */
export async function loadSamples() {
  const b = brands.ensure("Acme Technologies (sample)");
  if (b.reviews?.items?.length) { toast("Sample data already loaded", { type: "info" }); return b; }
  const files = [["glassdoor", "sample_glassdoor_acme.csv"], ["ambitionbox", "sample_ambitionbox_acme.csv"]];
  let items = [], imports = [];
  for (const [platform, name] of files) {
    const blob = await (await fetch(`/static/samples/${name}`)).blob();
    const parsed = await api.reviewsParse(platform, { file: new File([blob], name, { type: "text/csv" }) });
    const id = uid();
    items = items.concat(parsed.reviews.map((r) => ({ ...r, id: uid(), import_id: id })));
    imports.push({ id, platform, name, ts: Date.now(), count: parsed.reviews.length });
  }
  const analysed = await api.reviewsAnalyze(items);
  brands.setReviews(b.key, { imports, items: analysed.reviews, summary: analysed.summary });
  return b;
}

/* --------------------------------------------------------------- render */
export function renderReviewsTab(brand) {
  const rv = brand.reviews;
  const has = !!rv?.items?.length;
  if (ui.open === null) ui.open = !has;
  root.innerHTML = `
    <div class="card rv-import ${ui.open ? "" : "collapsed"}">
      <div class="card-head"><h3>${icon("upload")} Import reviews</h3>
        ${has ? `<button class="btn btn-ghost btn-xs" data-rv="toggle">${ui.open ? "Hide" : "Import more"}</button>` : ""}</div>
      ${ui.open ? `
      <p class="rv-note">${icon("shield")}<span>SentimentAI does not scrape review sites — Glassdoor and AmbitionBox terms forbid automated collection. Import reviews you have collected yourself as a CSV, or paste them below.</span></p>
      <div class="rv-row">
        <div class="seg" role="radiogroup" aria-label="Review platform">${Object.entries(PLATFORM_META).map(([k, m]) =>
          `<button class="seg-btn ${ui.platform === k ? "on" : ""}" data-platform="${k}" role="radio" aria-checked="${ui.platform === k}" style="--sc:${m.color}"><span class="src-dot"></span>${m.name}</button>`).join("")}</div>
        <div class="seg" role="radiogroup" aria-label="Import method">
          <button class="seg-btn ${ui.mode === "file" ? "on" : ""}" data-mode="file">${icon("file")}Upload CSV</button>
          <button class="seg-btn ${ui.mode === "paste" ? "on" : ""}" data-mode="paste">${icon("edit")}Paste text</button></div>
      </div>
      ${ui.mode === "file" ? `
      <label class="dropzone compact" id="rv-drop" for="rv-file"><input type="file" id="rv-file" accept=".csv,text/csv" hidden />
        <strong>${ui.file ? `${icon("file")} ${esc(ui.file.name)}` : "Drop a CSV here, or <u>browse</u>"}</strong>
        <small>${ui.file ? "ready to import" : "Columns are detected automatically: Pros/Likes, Cons/Dislikes, Review, Rating, Date, Job title…"}</small></label>`
      : `<textarea id="rv-paste" class="rv-paste" rows="8" placeholder="${esc(PASTE_HINT)}">${esc(ui.paste)}</textarea>
        <p class="muted-sm">One review per block, separated by a blank line. Recognised labels: Pros / Likes, Cons / Dislikes, Rating, Title, Role, Date. Other lines become review text.</p>`}
      <div class="rv-actions">
        <div class="row-gap"><span class="muted-sm">Samples (synthetic):</span>
          <a class="link-sm" href="/static/samples/sample_glassdoor_acme.csv" download>Glassdoor format</a>
          <a class="link-sm" href="/static/samples/sample_ambitionbox_acme.csv" download>AmbitionBox format</a></div>
        <button class="btn btn-primary" id="rv-import">${icon("upload")}<span>Import & analyse</span></button>
      </div>` : ""}
      ${has ? `<div class="rv-imports">${rv.imports.map((imp) => `<span class="imp-chip" style="--sc:${PLATFORM_META[imp.platform].color}"><span class="src-dot"></span><b>${PLATFORM_META[imp.platform].name}</b> ${esc(imp.name)} · ${fmt(imp.count)}
        <button class="bc-x" data-remove-import="${imp.id}" aria-label="Remove import" data-tip="Remove these reviews">${icon("x")}</button></span>`).join("")}</div>` : ""}
    </div>
    ${has ? resultsHTML(brand) : `<div class="card empty"><div class="empty-art">${icon("users")}</div><h3>No reviews imported for ${esc(brand.query)}</h3>
      <p>Import employee reviews from Glassdoor or AmbitionBox (or customer reviews from anywhere) to see what people like and dislike, how they rate the company, and how well the model agrees with their star ratings.</p></div>`}`;
  if (has) drawCharts(brand);
}

function insights(brand) {
  const s = brand.reviews.summary, out = [];
  if (s.avg_rating != null) {
    const low = (s.rating_distribution["1"] + s.rating_distribution["2"]) / (s.rated || 1);
    out.push({ type: s.avg_rating >= 3.5 ? "positive" : s.avg_rating < 3 ? "negative" : "info", text: `Average rating is ${s.avg_rating.toFixed(2)}★ across ${fmt(s.rated)} rated reviews; ${pct(low)} are 1–2★.` });
  }
  const tp = s.themes.positive[0], tn = s.themes.negative[0];
  const src = s.themes.source === "pros_cons";
  if (tp) out.push({ type: "positive", text: `Most praised: “${tp[0]}” — mentioned in ${tp[1]} ${src ? "pros / likes" : "positive reviews"}.` });
  if (tn) out.push({ type: "negative", text: `Top complaint: “${tn[0]}” — mentioned in ${tn[1]} ${src ? "cons / dislikes" : "negative reviews"}.` });
  const pf = Object.entries(s.by_platform).filter(([, v]) => v.avg_rating != null && v.total >= 5);
  if (pf.length >= 2) {
    const [a, b] = [...pf].sort((x, y) => y[1].avg_rating - x[1].avg_rating);
    out.push({ type: "info", text: `${a[1].name} reviewers rate higher than ${b[1].name} (${a[1].avg_rating.toFixed(2)}★ vs ${b[1].avg_rating.toFixed(2)}★).` });
  }
  if (s.rating_agreement != null) out.push({ type: "info", text: `The model’s sentiment matches the reviewer’s own star rating in ${pct(s.rating_agreement)} of ${fmt(s.rated)} rated reviews.` });
  return out;
}

function resultsHTML(brand) {
  const s = brand.reviews.summary, n = s.total || 1;
  const typeIcon = { alert: "bell", negative: "frown", positive: "smile", info: "info" };
  const kpi = (k, v, sub, ic, style = "", tip = "") => `<div class="card stat" style="${style}" ${tip ? `data-tip="${esc(tip)}"` : ""}><div class="stat-top"><span>${k}</span><span class="stat-ico">${icon(ic)}</span></div><div class="stat-val">${v}</div><div class="stat-sub">${sub}</div></div>`;
  const themeCard = (l, title) => `<div class="card"><div class="card-head"><h3>${title}</h3><span class="muted-sm">${s.themes.source === "pros_cons" ? (l === "positive" ? "from pros / likes" : "from cons / dislikes") : `from ${l} reviews`}</span></div>
    ${s.themes[l].length ? `<div class="wordcloud">${s.themes[l].map(([w, c], i) => `<button class="word ${l}" style="--s:${(1 - i / (s.themes[l].length * 1.4)).toFixed(2)}" data-rv-word="${esc(w)}" data-tip="In ${c} reviews — click to filter">${esc(w)}<small>${c}</small></button>`).join("")}</div>`
      : `<p class="no-drivers">Not enough text to find recurring themes.</p>`}</div>`;
  const m = s.rating_matrix;
  return `
    <div class="card insights"><div class="card-head"><h3>${icon("bell")} Review insights</h3><span class="muted-sm">rule-based, from the numbers below</span></div>
      <ul>${insights(brand).map((a) => `<li class="ins ${a.type}"><span class="ins-ico">${icon(typeIcon[a.type])}</span><span>${esc(a.text)}</span></li>`).join("")}</ul></div>

    <div class="stat-grid five">
      ${kpi("Reviews", fmt(s.total), `${Object.keys(s.by_platform).length} platform${Object.keys(s.by_platform).length === 1 ? "" : "s"}`, "users")}
      ${kpi("Avg. rating", s.avg_rating != null ? `${s.avg_rating.toFixed(2)}<small class="star-suffix">★</small>` : "–", s.rated ? `${fmt(s.rated)} rated reviews` : "no ratings in data", "star")}
      ${kpi("Net sentiment", `<span class="${s.net_score > 0 ? "t-pos" : s.net_score < 0 ? "t-neg" : ""}">${s.net_score > 0 ? "+" : ""}${s.net_score}</span>`, "% positive − % negative", "scale", "", "Model sentiment of each whole review (title + pros + cons + text).")}
      ${["positive", "negative"].map((l) => kpi(cap(l), pct(s.counts[l] / n), `${fmt(s.counts[l])} reviews`, l === "positive" ? "smile" : "frown", `--c:${COLORS[l]};--soft:${SOFT[l]}`)).join("")}
    </div>

    <div class="grid-1-1">${themeCard("positive", "What people like")}${themeCard("negative", "What people dislike")}</div>

    <div class="grid-1-2">
      <div class="card"><div class="card-head"><h3>Rating distribution</h3><span class="muted-sm">${s.rated ? `${fmt(s.rated)} rated` : "no ratings"}</span></div><div id="rv-ratings"></div></div>
      <div class="card"><div class="card-head"><h3>Reviews over time</h3><span class="muted-sm" id="rv-trend-sub"></span></div><div id="rv-trend"></div></div>
    </div>

    <div class="grid-1-2">
      <div class="card"><div class="card-head"><h3>By platform</h3></div><div id="rv-platforms"></div></div>
      <div class="card"><div class="card-head"><h3>Model check</h3><span class="muted-sm" data-tip="Star ratings are the reviewers' own verdict, so they're a real-world test of the model on review text.">vs reviewers’ own ratings ${icon("info")}</span></div>
        ${s.rated ? `<div class="check-grid">
          <div class="check-big"><strong>${pct(s.rating_agreement)}</strong><span>agreement with star rating<br><small>1–2★ = negative · 3★ = neutral · 4–5★ = positive</small></span></div>
          <div class="mini-matrix"><div></div>${ORDER.map((l) => `<div class="mh">pred. ${l.slice(0, 3)}</div>`).join("")}
            ${ORDER.map((rb) => { const row = m[rb], tot = ORDER.reduce((a, l) => a + row[l], 0) || 1; return `<div class="mh rh">${rb === "negative" ? "1–2★" : rb === "neutral" ? "3★" : "4–5★"}</div>${ORDER.map((pl) => `<div class="mc ${rb === pl ? "diag" : ""}" style="--a:${(row[pl] / tot * 0.85).toFixed(2)}" data-tip="${rb === "negative" ? "1–2★" : rb === "neutral" ? "3★" : "4–5★"} reviews predicted ${pl}: ${row[pl]}">${row[pl]}</div>`).join("")}`; }).join("")}
          </div></div>` : `<p class="no-drivers">No star ratings in the imported data, so agreement can’t be measured.</p>`}
        <div class="check-row">
          ${s.pros_positive_share != null ? `<div><b>${pct(s.pros_positive_share)}</b> of ${fmt(s.pros_count)} pros / likes classified positive</div>` : ""}
          ${s.cons_negative_share != null ? `<div><b>${pct(s.cons_negative_share)}</b> of ${fmt(s.cons_count)} cons / dislikes classified negative</div>` : ""}
        </div>
      </div>
    </div>

    <div class="card" id="rv-feed-card">
      <div class="card-head"><h3>Reviews</h3><div class="row-gap"><span class="muted-sm" id="rv-count"></span><button class="btn btn-ghost btn-xs" data-rv="export">${icon("download")}Export CSV</button></div></div>
      <div class="table-toolbar">
        <div class="search-wrap">${icon("search")}<input id="rv-search" type="search" placeholder="Search reviews, roles…" aria-label="Search reviews" value="${esc(feed.q)}" /></div>
        <div class="chips" id="rv-filter"></div>
        <div class="row-gap feed-selects">
          <select id="rv-platform" aria-label="Platform"><option value="all">All platforms</option>${Object.keys(s.by_platform).map((k) => `<option value="${k}" ${feed.platform === k ? "selected" : ""}>${PLATFORM_META[k]?.name || k}</option>`).join("")}</select>
          <select id="rv-rating" aria-label="Rating"><option value="all">All ratings</option>${[5, 4, 3, 2, 1].map((r) => `<option value="${r}" ${feed.rating === String(r) ? "selected" : ""}>${r}★</option>`).join("")}</select>
          <select id="rv-sort" aria-label="Sort">${[["newest", "Newest"], ["lowest", "Lowest rating"], ["highest", "Highest rating"], ["negative", "Most negative"]].map(([v, t]) => `<option value="${v}" ${feed.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
        </div>
      </div>
      <div id="rv-list" class="feed"></div>
      <div class="pager" id="rv-pager"></div>
    </div>`;
}

function drawCharts(brand) {
  const s = brand.reviews.summary;
  const max = Math.max(1, ...Object.values(s.rating_distribution));
  $("#rv-ratings", root).innerHTML = s.rated ? `<div class="rbars">${[5, 4, 3, 2, 1].map((r) => {
    const v = s.rating_distribution[r], c = r >= 4 ? COLORS.positive : r === 3 ? COLORS.neutral : COLORS.negative;
    return `<div class="rbar"><span class="rlabel">${r}★</span><div class="prob-track"><div class="prob-fill" style="--c:${c};width:${(v / max) * 100}%"></div></div><b>${v}</b></div>`;
  }).join("")}</div>` : `<p class="no-drivers">The imported data has no rating column.</p>`;
  const dated = brand.reviews.items.filter((r) => r.date).map((r) => ({ ts: Date.parse(r.date), label: r.label }));
  if (dated.length >= 2) $("#rv-trend-sub", root).textContent = periodBars($("#rv-trend", root), dated);
  else $("#rv-trend", root).innerHTML = `<p class="no-drivers">Add a date column to see reviews over time.</p>`;
  stackedRows($("#rv-platforms", root), Object.entries(s.by_platform).map(([k, v]) => ({
    label: v.name, color: PLATFORM_META[k]?.color, counts: v.counts,
    sub: `${v.total} · ${v.avg_rating != null ? `${v.avg_rating.toFixed(2)}★ · ` : ""}net <b class="${v.net_score > 0 ? "t-pos" : v.net_score < 0 ? "t-neg" : ""}">${v.net_score > 0 ? "+" : ""}${v.net_score}</b>`,
  })));
  renderFeed();
}

function rows() {
  const b = brands.active(); if (!b?.reviews) return [];
  const q = feed.q;
  const list = b.reviews.items.filter((r) =>
    (feed.filter === "all" || r.label === feed.filter) && (feed.platform === "all" || r.platform === feed.platform)
    && (feed.rating === "all" || (r.rating != null && Math.round(r.rating) === +feed.rating))
    && (!q || [r.title, r.text, r.pros, r.cons, r.role, r.location].some((x) => (x || "").toLowerCase().includes(q))));
  const by = {
    newest: (a, c) => (Date.parse(c.date) || 0) - (Date.parse(a.date) || 0),
    lowest: (a, c) => (a.rating ?? 9) - (c.rating ?? 9),
    highest: (a, c) => (c.rating ?? -1) - (a.rating ?? -1),
    negative: (a, c) => c.probabilities.negative - a.probabilities.negative,
  }[feed.sort];
  return [...list].sort(by);
}

function renderFeed() {
  const b = brands.active(); if (!b?.reviews || !$("#rv-list", root)) return;
  const all = b.reviews.items;
  const counts = { all: all.length }; LABELS.forEach((l) => (counts[l] = all.filter((r) => r.label === l).length));
  $("#rv-filter", root).innerHTML = ["all", ...LABELS].map((k) => `<button class="chip ${feed.filter === k ? "active" : ""}" data-rv-filter="${k}">${k === "all" ? "All" : cap(k)}<span class="chip-count">${counts[k]}</span></button>`).join("");
  const list = rows();
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE)); feed.page = Math.min(feed.page, pages);
  $("#rv-count", root).textContent = `${fmt(list.length)} shown`;
  $("#rv-list", root).innerHTML = list.length ? list.slice((feed.page - 1) * PER_PAGE, feed.page * PER_PAGE).map(reviewCard).join("")
    : `<div class="empty compact bare"><div class="empty-art">${icon("search")}</div><h3>No matching reviews</h3><p>Try another filter or search term.</p></div>`;
  $("#rv-pager", root).innerHTML = pagerHTML(feed.page, pages, list.length, PER_PAGE);
}

function reviewCard(r) {
  const meta = PLATFORM_META[r.platform] || PLATFORM_META.other;
  const who = [r.role, r.location, r.status].filter(Boolean).map(esc).join(" · ");
  const part = (kind, txt, lbl) => txt ? `<div class="rv-part ${kind}"><span class="rv-tag">${kind === "pros" ? "Pros" : "Cons"}</span><p>${esc(txt)}</p>${lbl ? `<span class="badge ${lbl} mini" data-tip="Model's reading of the ${kind} text">${cap(lbl)}</span>` : ""}</div>` : "";
  return `<article class="mention review" style="--sc:${meta.color}">
    <div class="mention-top"><span class="src-pill"><span class="src-dot"></span>${meta.name}</span>${stars(r.rating)}
      ${who ? `<span class="mention-author">${who}</span>` : ""}${r.date ? `<span class="dotsep">·</span><span class="muted-sm">${timeAgo(Date.parse(r.date))}</span>` : ""}
      <span class="mention-badge">${badge(r.label)}<small data-tip="Neg ${pct(r.probabilities.negative)} · Neu ${pct(r.probabilities.neutral)} · Pos ${pct(r.probabilities.positive)}">${pct(r.confidence)}</small>
        ${r.rating_label && r.rating_label !== r.label ? `<span class="mismatch" data-tip="The model's sentiment differs from the star rating (${r.rating}★)">${icon("alert")}</span>` : ""}</span></div>
    ${r.title ? `<h4 class="rv-title">${esc(r.title)}</h4>` : ""}
    ${r.text ? `<p class="mention-text">${esc(r.text)}</p>` : ""}
    ${part("pros", r.pros, r.pros_label)}${part("cons", r.cons, r.cons_label)}
    <div class="mention-actions"><button class="btn btn-ghost btn-xs" data-rv-explain="${r.id}" data-tip="Open in the Analyzer to see which words drove the prediction">${icon("sparkles")}Explain prediction</button></div>
  </article>`;
}

function exportCSV(b) {
  const list = rows();
  const csv = toCSV(["platform", "date", "role", "location", "rating", "title", "text", "pros", "cons", "sentiment", "confidence", "pros_sentiment", "cons_sentiment", "rating_sentiment"],
    list.map((r) => [PLATFORM_META[r.platform]?.name || r.platform, r.date, r.role, r.location, r.rating, r.title, r.text, r.pros, r.cons, r.label, r.confidence, r.pros_label, r.cons_label, r.rating_label]));
  download(`${b.query.replace(/\W+/g, "-").toLowerCase()}-reviews-${stamp()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
  toast("Reviews exported", { body: `${fmt(list.length)} rows.` });
}

/* --------------------------------------------------------------- events */
function onClick(e) {
  const b = brands.active(); if (!b) return;
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t("[data-platform]"))) { ui.platform = el.dataset.platform; return renderReviewsTab(b); }
  if ((el = t("[data-mode]"))) { ui.mode = el.dataset.mode; return renderReviewsTab(b); }
  if ((el = t("[data-rv='toggle']"))) { ui.open = !ui.open; return renderReviewsTab(b); }
  if (t("#rv-import")) return doImport(b);
  if ((el = t("[data-remove-import]"))) return removeImport(b, el.dataset.removeImport);
  if (t("[data-rv='export']")) return exportCSV(b);
  if ((el = t("[data-rv-filter]"))) { feed.filter = el.dataset.rvFilter; feed.page = 1; return renderFeed(); }
  if ((el = t("[data-rv-word]"))) {
    feed = { ...feed, q: el.dataset.rvWord, filter: "all", page: 1 };
    $("#rv-search", root).value = el.dataset.rvWord; renderFeed();
    return $("#rv-feed-card", root).scrollIntoView({ behavior: "smooth" });
  }
  if ((el = t("[data-page]")) && el.closest("#rv-pager") && !el.disabled) { feed.page = +el.dataset.page; renderFeed(); return $("#rv-feed-card", root).scrollIntoView({ behavior: "smooth" }); }
  if ((el = t("[data-rv-explain]"))) {
    const r = b.reviews.items.find((x) => x.id === el.dataset.rvExplain);
    if (r) onAnalyze([r.title, r.text, r.pros && `Pros: ${r.pros}`, r.cons && `Cons: ${r.cons}`].filter(Boolean).join(". "));
  }
}

function onChange(e) {
  if (e.target.id === "rv-file" && e.target.files[0]) pickFile(e.target.files[0]);
  if (e.target.id === "rv-platform") { feed.platform = e.target.value; feed.page = 1; renderFeed(); }
  if (e.target.id === "rv-rating") { feed.rating = e.target.value; feed.page = 1; renderFeed(); }
  if (e.target.id === "rv-sort") { feed.sort = e.target.value; feed.page = 1; renderFeed(); }
}
