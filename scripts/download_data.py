"""Download the training datasets into data/raw/.

1. Twitter US Airline Sentiment (Crowdflower, CC BY-NC-SA 4.0)
   -> data/raw/Tweets.csv
   Customer-service tweets about six US airlines. Fetched from a public Hugging
   Face mirror so no Kaggle account is needed. Manual alternative: download
   Tweets.csv from https://www.kaggle.com/datasets/crowdflower/twitter-airline-sentiment

2. TweetEval - sentiment (Barbieri et al., 2020; SemEval-2017 Task 4)
   -> data/raw/tweeteval_{train,validation,test}.csv
   ~60k general-topic tweets (brands, celebrities, politics, products) with
   the same three classes. Adds the broad vocabulary needed for monitoring any
   brand. Source: https://huggingface.co/datasets/cardiffnlp/tweet_eval

Usage: python scripts/download_data.py
"""

from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
UA = {"User-Agent": "SentimentAI/1.0 (dataset download)"}

AIRLINE_URL = "https://huggingface.co/datasets/osanseviero/twitter-airline-sentiment/resolve/main/Tweets.csv"
TWEETEVAL_URL = "https://huggingface.co/api/datasets/cardiffnlp/tweet_eval/parquet/sentiment/{split}/0.parquet"
TWEETEVAL_LABELS = {0: "negative", 1: "neutral", 2: "positive"}


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def airline() -> None:
    dest = RAW / "Tweets.csv"
    if dest.exists():
        print(f"  ✓ {dest.relative_to(ROOT)} already present")
        return
    data = _fetch(AIRLINE_URL)
    header = data.split(b"\n", 1)[0].decode("utf-8", "replace")
    if "airline_sentiment" not in header or "text" not in header:
        raise ValueError("downloaded airline file is missing expected columns")
    dest.write_bytes(data)
    print(f"  ✓ saved {dest.relative_to(ROOT)} ({len(data) / 1e6:.1f} MB)")


def tweeteval() -> None:
    for split in ("train", "validation", "test"):
        dest = RAW / f"tweeteval_{split}.csv"
        if dest.exists():
            print(f"  ✓ {dest.relative_to(ROOT)} already present")
            continue
        df = pd.read_parquet(io.BytesIO(_fetch(TWEETEVAL_URL.format(split=split))))
        df = pd.DataFrame({"text": df["text"], "label": df["label"].map(TWEETEVAL_LABELS)})
        if df["label"].isna().any():
            raise ValueError("unexpected TweetEval label values")
        df.to_csv(dest, index=False)
        print(f"  ✓ saved {dest.relative_to(ROOT)} ({len(df):,} rows)")


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    ok = True
    for name, fn in (("Twitter US Airline Sentiment", airline), ("TweetEval sentiment", tweeteval)):
        print(f"▸ {name}")
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - report any failure to the user
            ok = False
            print(f"  ✗ download failed: {exc}", file=sys.stderr)
    if not ok:
        print("\nSee the docstring at the top of this file for manual download links.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
