"""Train and evaluate the SentimentAI classifier on two labelled datasets.

Datasets (see scripts/download_data.py)
--------
* Twitter US Airline Sentiment - customer-service tweets. No official split, so
  we use a stratified 70/15/15 train/validation/test split (seed 42).
* TweetEval sentiment - general-topic tweets with official train/val/test splits.

Pipeline
--------
1. Clean text with sentiment.preprocess.clean_text, drop empty/duplicate rows and
   texts with conflicting labels.
2. Train candidates on the combined training data; compare them by macro F1 on
   the combined validation data.
3. Refit the best logistic-regression candidate on train + validation and
   evaluate ONCE on each held-out test set (and on both combined).
4. Save the model to models/sentiment_model.joblib and every metric to
   models/metrics.json. The web app reads metrics from that file only.

Usage:  python scripts/train.py
"""

from __future__ import annotations

import json
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import ComplementNB
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.svm import LinearSVC

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sentiment.preprocess import LABELS, TOKEN_PATTERN, clean_text  # noqa: E402

RAW = ROOT / "data" / "raw"
MODEL_DIR = ROOT / "models"
SEED = 42

DATASETS = {
    "airline": {
        "name": "Twitter US Airline Sentiment",
        "source": "Crowdflower / Kaggle (crowdflower/twitter-airline-sentiment)",
        "license": "CC BY-NC-SA 4.0",
        "domain": "Customer-service tweets about six US airlines (Feb 2015)",
        "split_strategy": "Stratified 70/15/15, random_state=42",
    },
    "tweeteval": {
        "name": "TweetEval — sentiment",
        "source": "Barbieri et al. 2020 / SemEval-2017 Task 4 (cardiffnlp/tweet_eval)",
        "license": "Research use (see dataset card)",
        "domain": "General-topic tweets: brands, products, people, events",
        "split_strategy": "Official train / validation / test splits",
    },
}


# ------------------------------------------------------------------ features
def word_vec() -> TfidfVectorizer:
    return TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_df=0.9, sublinear_tf=True,
                           token_pattern=TOKEN_PATTERN, max_features=150_000)


def char_vec() -> TfidfVectorizer:
    return TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=3, sublinear_tf=True,
                           max_features=100_000)


def features(with_chars: bool) -> FeatureUnion:
    parts = [("word", word_vec())]
    if with_chars:
        parts.append(("char", char_vec()))
    return FeatureUnion(parts)


def candidates() -> dict[str, Pipeline]:
    def lr(c: float) -> LogisticRegression:
        return LogisticRegression(C=c, max_iter=3000, class_weight="balanced", random_state=SEED)

    return {
        "Complement Naive Bayes (word TF-IDF)": Pipeline(
            [("features", features(False)), ("clf", ComplementNB(alpha=0.3))]),
        "Linear SVM (word + char TF-IDF)": Pipeline(
            [("features", features(True)), ("clf", LinearSVC(C=0.3, class_weight="balanced", random_state=SEED))]),
        "Logistic Regression C=2 (word TF-IDF)": Pipeline(
            [("features", features(False)), ("clf", lr(2.0))]),
        "Logistic Regression C=1 (word + char TF-IDF)": Pipeline(
            [("features", features(True)), ("clf", lr(1.0))]),
        "Logistic Regression C=2 (word + char TF-IDF)": Pipeline(
            [("features", features(True)), ("clf", lr(2.0))]),
    }


# ---------------------------------------------------------------------- data
def _prepare(df: pd.DataFrame) -> pd.DataFrame:
    df = df[["text", "label"]].copy()
    df["clean"] = df["text"].map(clean_text)
    df = df[(df["clean"].str.len() > 0) & df["label"].isin(LABELS)]
    df = df.drop_duplicates(subset=["clean", "label"])
    conflicting = df.groupby("clean")["label"].transform("nunique") > 1
    return df[~conflicting].reset_index(drop=True)


def _require(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {path.relative_to(ROOT)}. Run `python scripts/download_data.py` first (see README).")


def load() -> dict[str, dict]:
    out = {}
    _require(RAW / "Tweets.csv")
    raw = pd.read_csv(RAW / "Tweets.csv").rename(columns={"airline_sentiment": "label"})
    air = _prepare(raw)
    tr, tmp = train_test_split(air, test_size=0.30, stratify=air["label"], random_state=SEED)
    va, te = train_test_split(tmp, test_size=0.50, stratify=tmp["label"], random_state=SEED)
    out["airline"] = {"raw_rows": len(raw), "train": tr, "validation": va, "test": te}

    parts, raw_rows = {}, 0
    for split in ("train", "validation", "test"):
        _require(RAW / f"tweeteval_{split}.csv")
        df = pd.read_csv(RAW / f"tweeteval_{split}.csv")
        raw_rows += len(df)
        parts[split] = _prepare(df)
    # Make sure no test text leaks into training/validation.
    test_texts = set(parts["test"]["clean"])
    for split in ("train", "validation"):
        parts[split] = parts[split][~parts[split]["clean"].isin(test_texts)]
    out["tweeteval"] = {"raw_rows": raw_rows, **parts}
    return out


# ------------------------------------------------------------------- metrics
def evaluate(y_true, y_pred) -> dict:
    p, r, f, s = precision_recall_fscore_support(y_true, y_pred, labels=list(LABELS), zero_division=0)
    return {
        "accuracy": accuracy_score(y_true, y_pred),
        "macro_precision": float(np.mean(p)),
        "macro_recall": float(np.mean(r)),
        "macro_f1": f1_score(y_true, y_pred, average="macro"),
        "weighted_f1": f1_score(y_true, y_pred, average="weighted"),
        "per_class": {
            lbl: {"precision": float(p[i]), "recall": float(r[i]), "f1": float(f[i]), "support": int(s[i])}
            for i, lbl in enumerate(LABELS)
        },
        "confusion_matrix": confusion_matrix(y_true, y_pred, labels=list(LABELS)).tolist(),
        "n": int(len(y_true)),
    }


def main() -> None:
    t0 = time.perf_counter()
    data = load()
    cat = lambda split: pd.concat([d[split] for d in data.values()], ignore_index=True)  # noqa: E731
    train_df, val_df, test_df = cat("train"), cat("validation"), cat("test")
    for k, d in data.items():
        print(f"{k:<10} raw={d['raw_rows']:>6}  train={len(d['train']):>6}  val={len(d['validation']):>5}  test={len(d['test']):>6}")
    print(f"{'combined':<10} {'':>10}  train={len(train_df):>6}  val={len(val_df):>5}  test={len(test_df):>6}")

    comparison, best_name, best_f1 = [], None, -1.0
    for name, pipe in candidates().items():
        t = time.perf_counter()
        pipe.fit(train_df["clean"], train_df["label"])
        pred = pipe.predict(val_df["clean"])
        m_f1, acc = f1_score(val_df["label"], pred, average="macro"), accuracy_score(val_df["label"], pred)
        probabilistic = name.startswith("Logistic")
        comparison.append({"model": name, "val_accuracy": acc, "val_macro_f1": m_f1,
                           "fit_seconds": round(time.perf_counter() - t, 2), "probabilistic": probabilistic})
        print(f"  {name:<48} acc={acc:.4f} macroF1={m_f1:.4f} ({comparison[-1]['fit_seconds']}s)")
        # Only logistic regression is eligible for deployment: it produces real
        # class probabilities that the UI displays.
        if probabilistic and m_f1 > best_f1:
            best_name, best_f1 = name, m_f1
    print(f"Selected: {best_name}")

    final = candidates()[best_name]
    trainval = pd.concat([train_df, val_df], ignore_index=True)
    t = time.perf_counter()
    final.fit(trainval["clean"], trainval["label"])
    fit_seconds = time.perf_counter() - t

    test_metrics = evaluate(test_df["label"], final.predict(test_df["clean"]))
    by_dataset = {}
    for k, d in data.items():
        by_dataset[k] = evaluate(d["test"]["label"], final.predict(d["test"]["clean"]))
        print(f"\n== {k} test ==")
        print(classification_report(d["test"]["label"], final.predict(d["test"]["clean"]), digits=4))
    print(f"== combined test == acc={test_metrics['accuracy']:.4f} macroF1={test_metrics['macro_f1']:.4f}")

    vocab = {n: len(tf.vocabulary_) for n, tf in final.named_steps["features"].transformer_list}
    all_rows = pd.concat([cat("train"), cat("validation"), cat("test")])
    metrics = {
        "model": {
            "name": "SentimentAI TF-IDF + Logistic Regression",
            "selected_candidate": best_name,
            "algorithm": "Multinomial Logistic Regression (class_weight=balanced)",
            "features": "TF-IDF word 1-2 grams" + (" + character 2-5 grams" if "char" in vocab else ""),
            "vocabulary_size": vocab,
            "total_features": int(sum(vocab.values())),
            "classes": list(LABELS),
        },
        "dataset": {
            "name": " + ".join(v["name"] for v in DATASETS.values()),
            "raw_rows": int(sum(d["raw_rows"] for d in data.values())),
            "rows_after_cleaning": int(len(all_rows)),
            "class_distribution": {k: int(v) for k, v in all_rows["label"].value_counts().reindex(LABELS).items()},
            "split": {"train": len(train_df), "validation": len(val_df), "test": len(test_df)},
            "components": {
                k: {**DATASETS[k], "raw_rows": int(d["raw_rows"]),
                    "split": {s: len(d[s]) for s in ("train", "validation", "test")},
                    "class_distribution": {lbl: int((pd.concat([d["train"], d["validation"], d["test"]])["label"] == lbl).sum()) for lbl in LABELS}}
                for k, d in data.items()
            },
        },
        "test": test_metrics,
        "test_by_dataset": by_dataset,
        "model_selection": comparison,
        "training": {
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "final_fit_seconds": round(fit_seconds, 2),
            "total_seconds": round(time.perf_counter() - t0, 2),
            "final_fit_rows": len(trainval),
            "sklearn_version": sklearn.__version__,
            "python_version": platform.python_version(),
            "random_seed": SEED,
        },
    }

    MODEL_DIR.mkdir(exist_ok=True)
    joblib.dump(final, MODEL_DIR / "sentiment_model.joblib", compress=3)
    (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"Saved model and metrics to {MODEL_DIR.relative_to(ROOT)}/ in {metrics['training']['total_seconds']}s")


if __name__ == "__main__":
    main()
