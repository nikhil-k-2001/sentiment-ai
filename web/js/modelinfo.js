// "About / Model Information" view — rendered entirely from models/metrics.json
// (served by GET /api/model). No numbers are hard-coded here.
import { $, COLORS, cap, esc, fmt, icon, pct } from "./utils.js";
import { animateIn } from "./charts.js";

let testSel = "combined";

export function renderModel(m, error) {
  const root = $("#model-root");
  if (!m) {
    root.innerHTML = `<div class="page-head"><div><h1>Model Information</h1><p>Details about the trained classifier.</p></div></div>
      <div class="card empty"><div class="empty-art">${icon("cpu")}</div><h3>No trained model available</h3>
      <p>${esc(error || "Train the model to see real evaluation metrics.")}</p>
      <p>Run <code>python scripts/download_data.py</code> and <code>python scripts/train.py</code>, then restart the server.</p></div>`;
    return;
  }
  const d = m.dataset, tr = m.training, classes = m.model.classes;
  const byDs = m.test_by_dataset || {};
  if (testSel !== "combined" && !byDs[testSel]) testSel = "combined";
  const t = testSel === "combined" ? m.test : byDs[testSel];
  const nTest = t.n || d.split.test;
  const comps = d.components || {};
  const testName = testSel === "combined" ? "all test sets combined" : (comps[testSel]?.name || testSel);
  const switcher = Object.keys(byDs).length ? `<div class="chips" id="test-switch" role="tablist" aria-label="Test set">
    ${[["combined", "Combined"], ...Object.keys(byDs).map((k) => [k, comps[k]?.name?.split(" —")[0] || k])].map(([k, n]) =>
      `<button class="chip ${testSel === k ? "active" : ""}" data-test="${k}" role="tab" aria-selected="${testSel === k}">${esc(n)}<span class="chip-count">${pct((k === "combined" ? m.test : byDs[k]).accuracy, 1)}</span></button>`).join("")}</div>` : "";
  const trained = new Date(tr.trained_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const metric = (k, v, s, tip) => `<div class="card metric"><div class="k">${k}<i data-icon="info" data-tip="${esc(tip)}"></i></div>
    <div class="v">${pct(v, 1)}</div><div class="s">${s}</div><div class="ring"><span data-width="${(v * 100).toFixed(1)}%" style="width:0"></span></div></div>`;

  const cm = t.confusion_matrix;
  const matrix = `<div class="matrix-wrap"><div class="axis-y">Actual</div><div>
    <div class="matrix"><div></div>${classes.map((c) => `<div class="h">${c}</div>`).join("")}
    ${cm.map((row, i) => {
      const rowSum = row.reduce((a, b) => a + b, 0) || 1;
      return `<div class="h rh">${classes[i]}</div>${row.map((v, j) => {
        const a = v / rowSum;
        return `<div class="cell ${a > 0.55 ? "hot" : ""}" style="--a:${(a * 0.9).toFixed(3)}" data-tip="Actual ${classes[i]}, predicted ${classes[j]}: ${fmt(v)} tweets (${pct(a, 1)} of actual ${classes[i]})">
          <strong>${fmt(v)}</strong><small>${pct(a, 1)}</small></div>`;
      }).join("")}`;
    }).join("")}</div><div class="axis-x">Predicted</div></div></div>`;

  const dist = d.class_distribution, distTotal = Object.values(dist).reduce((a, b) => a + b, 0);
  const vocab = m.model.vocabulary_size;

  root.innerHTML = `
  <div class="model-hero">
    <div><h1>Model Information</h1>
      <p>A classical NLP pipeline — TF-IDF features and multinomial logistic regression — trained on ~75k real labelled tweets from two datasets and evaluated on held-out test sets the model never saw during training or model selection.</p>
      <div class="tag-row"><span class="badge plain">${esc(m.model.name)}</span><span class="badge plain">scikit-learn ${esc(tr.sklearn_version)}</span><span class="badge plain">Trained ${esc(trained)}</span></div>
    </div>
  </div>

  <div class="notice">${icon("shield")}<span><b>Evaluation metrics</b> — computed by <code>scripts/train.py</code> on held-out test tweets the model never saw, and loaded from <code>models/metrics.json</code>. These are different from the usage stats on the Analytics page.</span></div>
  ${switcher ? `<div class="section-head" style="margin-top:0"><div><h2>Test results</h2><p>Showing ${esc(testName)} · ${fmt(nTest)} tweets. TweetEval is a deliberately hard, general-topic benchmark.</p></div>${switcher}</div>` : ""}

  <div class="metric-grid">
    ${metric("Accuracy", t.accuracy, `${fmt(Math.round(t.accuracy * nTest))} / ${fmt(nTest)} test tweets correct`, "Share of test tweets whose predicted class matches the human label.")}
    ${metric("Precision (macro)", t.macro_precision, "mean over 3 classes", "Of the texts predicted as a class, how many truly belong to it — averaged equally across classes.")}
    ${metric("Recall (macro)", t.macro_recall, "mean over 3 classes", "Of the texts truly in a class, how many the model found — averaged equally across classes.")}
    ${metric("F1-score (macro)", t.macro_f1, `weighted F1 ${pct(t.weighted_f1, 1)}`, "Harmonic mean of precision and recall, averaged equally across classes. Robust to class imbalance.")}
  </div>

  <div class="grid-1-1">
    <div class="card"><div class="card-head"><h3>Confusion matrix</h3><span class="muted-sm">test set · row-normalised</span></div>${matrix}</div>
    <div class="card"><div class="card-head"><h3>Per-class performance</h3><span class="muted-sm">test set</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1-score</th><th>Support</th></tr></thead><tbody>
      ${classes.map((c) => { const p = t.per_class[c]; return `<tr><td><span class="badge ${c}">${cap(c)}</span></td>
        <td class="tabular">${pct(p.precision, 1)}</td><td class="tabular">${pct(p.recall, 1)}</td><td class="tabular"><b>${pct(p.f1, 1)}</b></td><td class="tabular">${fmt(p.support)}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted-sm" style="margin-top:14px">Customer-service complaints (airline set) are the easiest to classify. General tweets are harder: neutral overlaps with mild opinions, and sarcasm or missing context trips up a bag-of-words model.</p>
    </div>
  </div>

  <div class="grid-1-1">
    <div class="card"><div class="card-head"><h3>Training data</h3><span class="muted-sm">${fmt(d.rows_after_cleaning)} labelled tweets</span></div>
      ${Object.keys(comps).length ? Object.values(comps).map((c) => `<div class="ds-block"><b>${esc(c.name)}</b><p>${esc(c.domain)}</p>
        <dl class="kv"><dt>Source</dt><dd>${esc(c.source)}</dd><dt>License</dt><dd>${esc(c.license)}</dd>
        <dt>Rows</dt><dd>${fmt(c.raw_rows)} raw · ${fmt(c.split.train)} train · ${fmt(c.split.validation)} val · ${fmt(c.split.test)} test</dd><dt>Split</dt><dd>${esc(c.split_strategy)}</dd></dl></div>`).join("")
      : `<dl class="kv"><dt>Name</dt><dd>${esc(d.name)}</dd><dt>Source</dt><dd>${esc(d.source || "")}</dd>
        <dt>Rows</dt><dd>${fmt(d.raw_rows)} raw · ${fmt(d.rows_after_cleaning)} after cleaning</dd><dt>Split</dt><dd>${fmt(d.split.train)} train · ${fmt(d.split.validation)} val · ${fmt(d.split.test)} test</dd></dl>`}
      <div class="sub-title" style="margin-top:18px">Class distribution</div>
      <div class="dist-bar" style="margin-bottom:10px">${classes.map((c) => `<span style="width:${(dist[c] / distTotal) * 100}%;background:${COLORS[c]}" data-tip="${cap(c)}: ${fmt(dist[c])}"></span>`).join("")}</div>
      <div class="legend">${classes.map((c) => `<span style="--c:${COLORS[c]}">${cap(c)} ${pct(dist[c] / distTotal)}</span>`).join("")}</div>
    </div>
    <div class="card"><div class="card-head"><h3>Training run</h3></div>
      <dl class="kv"><dt>Trained at</dt><dd>${esc(trained)}</dd><dt>Final fit</dt><dd>${fmt(tr.final_fit_rows)} rows in ${tr.final_fit_seconds}s</dd>
        <dt>Total pipeline</dt><dd>${tr.total_seconds}s</dd><dt>Random seed</dt><dd>${tr.random_seed}</dd>
        <dt>Python</dt><dd>${esc(tr.python_version)}</dd><dt>scikit-learn</dt><dd>${esc(tr.sklearn_version)}</dd>
        <dt>Classes</dt><dd>${classes.map((c) => `<span class="badge ${c}" style="margin:0 4px 4px 0">${cap(c)}</span>`).join("")}</dd></dl>
    </div>
  </div>

  <div style="margin-bottom:18px">
    <div class="card"><div class="card-head"><h3>Model selection</h3><span class="muted-sm">validation set · ${fmt(d.split.validation)} tweets</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Candidate</th><th>Accuracy</th><th>Macro F1</th><th>Fit time</th></tr></thead><tbody>
      ${m.model_selection.map((r) => `<tr class="${r.model === m.model.selected_candidate ? "selected-row" : ""}"><td>${esc(r.model)} ${r.model === m.model.selected_candidate ? '<span class="badge positive">Selected</span>' : ""}${!r.probabilistic ? ' <span class="badge plain" data-tip="Not eligible: no native probabilities / coefficients for explanations">baseline</span>' : ""}</td>
        <td class="tabular">${pct(r.val_accuracy, 1)}</td><td class="tabular">${pct(r.val_macro_f1, 1)}</td><td class="tabular">${r.fit_seconds}s</td></tr>`).join("")}
      </tbody></table></div>
      <p class="muted-sm" style="margin-top:14px">The best logistic-regression candidate by validation macro F1 is refit on train + validation, then scored once on the test set.</p>
    </div>
  </div>

  <div class="card" style="margin-bottom:18px"><div class="card-head"><h3>How a prediction is made</h3></div>
    <div class="steps">
      <div class="step"><b>Normalise</b><p>Lower-case, strip URLs and @mentions, expand contractions (“don't” → “do not”), map emoticons to tokens.</p></div>
      <div class="step"><b>Vectorise</b><p>${esc(m.model.features)} → ${fmt(m.model.total_features)} sparse features (${Object.entries(vocab).map(([k, v]) => `${k}: ${fmt(v)}`).join(", ")}).</p></div>
      <div class="step"><b>Classify</b><p>${esc(m.model.algorithm)} scores each class.</p></div>
      <div class="step"><b>Probabilities</b><p>Softmax turns the scores into probabilities that sum to 100%; the top class is the prediction.</p></div>
      <div class="step"><b>Explain</b><p>Each word is removed in turn and the text re-scored; words that shift the log-odds are highlighted.</p></div>
    </div>
  </div>

    <div class="card"><div class="card-head"><h3>Limitations</h3></div>
      <ul class="limits">
        <li>Trained on tweets (airline customer service + general topics). Long technical comments, news headlines and reviews are further from the training data and less accurate.</li>
        <li>A bag-of-words model has no real understanding of sarcasm (“great, another delay”) or long-range negation.</li>
        <li>Overall accuracy on general-topic tweets is ${byDs.tweeteval ? pct(byDs.tweeteval.accuracy) : "lower than on customer-service text"} — treat individual predictions as estimates and look at aggregates.</li>
        <li>English only. Very short inputs give low-confidence predictions.</li>
        <li>Predictions describe the text, not the author’s true intent.</li>
      </ul>
    </div>`;
  animateIn(root);
  $("#test-switch")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-test]"); if (!b) return;
    testSel = b.dataset.test; renderModel(m, error);
  });
}
