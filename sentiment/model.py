"""Model loading, prediction and explanation."""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np

from .preprocess import LABELS, clean_text

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "models" / "sentiment_model.joblib"
METRICS_PATH = ROOT / "models" / "metrics.json"

MAX_TEXT_CHARS = 5000
MAX_EXPLAIN_WORDS = 250
# A word is reported as a keyword only if removing it shifts the log-odds of
# some class by at least this much. Log-odds (rather than raw probability) keep
# the explanation meaningful when a prediction is already near 100%.
KEYWORD_THRESHOLD = 0.12
# Function words are still seen by the model; we just don't highlight them.
STOPWORDS = frozenset(
    "a an the and or but if of to in on at for with by from as is are was were be been "
    "being am i me my we our you your he she it its they them their this that these those "
    "there here so than then too very just also do does did has have had will would can "
    "could should about into over up out what which who whom when where why how all any "
    "each some such only own same s t".split()
)

_WORD = re.compile(r"(?<![@\w#])[A-Za-z][A-Za-z']*[A-Za-z]|(?<![@\w#])[A-Za-z]")


class ModelNotReadyError(RuntimeError):
    """Raised when the trained model files are missing."""


@dataclass
class Prediction:
    label: str
    confidence: float
    probabilities: dict[str, float]


class SentimentModel:
    def __init__(self, model_path: Path = MODEL_PATH, metrics_path: Path = METRICS_PATH):
        self.model_path = model_path
        self.metrics_path = metrics_path
        self._pipeline = None
        self._metrics: dict | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ load
    @property
    def ready(self) -> bool:
        return self.model_path.exists() and self.metrics_path.exists()

    def _load(self):
        if self._pipeline is None:
            with self._lock:
                if self._pipeline is None:
                    if not self.ready:
                        raise ModelNotReadyError(
                            "No trained model found. Run `python scripts/download_data.py` "
                            "and `python scripts/train.py`, then restart the server."
                        )
                    pipe = joblib.load(self.model_path)
                    self._class_index = [list(pipe.classes_).index(c) for c in LABELS]
                    self._metrics = json.loads(self.metrics_path.read_text())
                    self._pipeline = pipe
        return self._pipeline

    @property
    def metrics(self) -> dict:
        self._load()
        return self._metrics  # type: ignore[return-value]

    # --------------------------------------------------------------- predict
    def _proba(self, cleaned: list[str]) -> np.ndarray:
        """Return probabilities with columns ordered as LABELS."""
        pipe = self._load()
        return pipe.predict_proba(cleaned)[:, self._class_index]

    def predict_many(self, texts: list[str]) -> list[Prediction]:
        cleaned = [clean_text(t) for t in texts]
        probs = self._proba(cleaned) if cleaned else np.empty((0, 3))
        out = []
        for row in probs:
            i = int(np.argmax(row))
            out.append(Prediction(
                label=LABELS[i],
                confidence=float(row[i]),
                probabilities={lbl: float(row[j]) for j, lbl in enumerate(LABELS)},
            ))
        return out

    # --------------------------------------------------------------- explain
    def explain(self, text: str, base: Prediction) -> list[dict]:
        """Occlusion-based word importance.

        For each distinct word we remove every occurrence from the text, re-run
        the model, and measure how much each class probability changes.
        `impact` is the change in log-odds of `sentiment` caused by the word;
        `probability_shift` is the same change expressed in probability.
        This works for any model and reflects exactly what the model computes.
        """
        seen: dict[str, None] = {}
        for m in _WORD.finditer(text):
            key = m.group(0).lower()
            if key not in seen:
                seen[key] = None
            if len(seen) >= MAX_EXPLAIN_WORDS:
                break
        words = [w for w in seen if w not in STOPWORDS]
        if not words:
            return []

        variants = []
        for w in words:
            pattern = re.compile(rf"(?<![@\w#]){re.escape(w)}(?!\w)", re.IGNORECASE)
            variants.append(clean_text(pattern.sub(" ", text)))
        probs = np.clip(self._proba(variants), 1e-6, 1 - 1e-6)
        base_vec = np.clip(np.array([base.probabilities[l] for l in LABELS]), 1e-6, 1 - 1e-6)
        logit = lambda p: np.log(p / (1 - p))  # noqa: E731
        # Positive value = the word pushes the model toward that class.
        log_odds = logit(base_vec)[None, :] - logit(probs)
        prob_deltas = base_vec[None, :] - probs

        keywords = []
        for w, lo, pd_ in zip(words, log_odds, prob_deltas):
            j = int(np.argmax(lo))
            if lo[j] < KEYWORD_THRESHOLD:
                continue
            keywords.append({
                "word": w,
                "sentiment": LABELS[j],
                "impact": round(float(lo[j]), 4),
                "probability_shift": round(float(pd_[j]), 4),
                "supports_prediction": LABELS[j] == base.label,
            })
        keywords.sort(key=lambda k: k["impact"], reverse=True)
        return keywords[:20]


def summarise(pred: Prediction, keywords: list[dict], text: str) -> str:
    """Plain-English, template-based explanation of a prediction."""
    ranked = sorted(pred.probabilities.items(), key=lambda kv: kv[1], reverse=True)
    (top, p1), (second, p2) = ranked[0], ranked[1]
    margin = p1 - p2
    if p1 >= 0.75:
        strength = "high"
    elif p1 >= 0.55:
        strength = "moderate"
    else:
        strength = "low"

    parts = [
        f"The model classifies this text as {top} with {strength} confidence "
        f"({p1:.0%})."
    ]
    if margin < 0.15:
        parts.append(
            f"The {second} probability ({p2:.0%}) is close behind, so the text may be "
            "mixed or ambiguous."
        )
    else:
        parts.append(f"The next most likely class is {second} at {p2:.0%}.")

    support = [k["word"] for k in keywords if k["supports_prediction"]][:4]
    against = [k for k in keywords if not k["supports_prediction"]][:2]
    if support:
        quoted = ", ".join(f"“{w}”" for w in support)
        parts.append(f"Words that contributed most to this prediction: {quoted}.")
    if against:
        quoted = ", ".join(f"“{k['word']}” ({k['sentiment']})" for k in against)
        parts.append(f"Some words pulled in another direction: {quoted}.")
    if len(text.split()) <= 3:
        parts.append("Very short inputs give the model little context, so treat this result with caution.")
    parts.append(
        "This is a statistical prediction from a model trained on labelled tweets, "
        "not a guaranteed reading of the author’s intent; sarcasm and domain-specific "
        "language can be misclassified."
    )
    return " ".join(parts)


model = SentimentModel()
