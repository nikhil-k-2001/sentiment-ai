"""Imported review tests (Glassdoor / AmbitionBox / pasted text)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sentiment.api import app
from sentiment.model import model
from sentiment.reviews import _themes, parse_rating, parse_text, rating_bucket

pytestmark = pytest.mark.skipif(not model.ready, reason="train the model first (scripts/train.py)")
client = TestClient(app)
SAMPLES = Path(__file__).resolve().parents[1] / "web" / "samples"


@pytest.mark.parametrize("raw,expected", [
    ("4", 4.0), ("4.5", 4.5), ("3/5", 3.0), ("8/10", 4.0), ("★★★", 3.0), ("4.0 ★", 4.0),
    ("", None), ("nan", None), ("great", None), ("0", None), ("7", None), ("9/5", None), ("4 out of 5", 4.0), ("80/100", 4.0),
])
def test_parse_rating(raw, expected):
    assert parse_rating(raw) == expected


def test_rating_bucket():
    assert [rating_bucket(r) for r in (1, 2, 3, 4, 5, None)] == ["negative", "negative", "neutral", "positive", "positive", None]


@pytest.mark.parametrize("name,platform,expect", [
    ("sample_glassdoor_acme.csv", "glassdoor", {"pros": "pros", "cons": "cons", "rating": "rating", "role": "job_title", "title": "title"}),
    ("sample_ambitionbox_acme.csv", "ambitionbox", {"pros": "likes", "cons": "dislikes", "rating": "rating", "role": "designation"}),
])
def test_csv_column_detection(name, platform, expect):
    with open(SAMPLES / name, "rb") as fh:
        r = client.post("/api/reviews/parse", data={"platform": platform}, files={"file": (name, fh, "text/csv")})
    body = r.json()
    assert r.status_code == 200
    for field, col in expect.items():
        assert body["mapping"][field] == col
    assert all(rv["platform"] == platform for rv in body["reviews"])
    assert all(rv["date"] for rv in body["reviews"])


def test_paste_parsing():
    text = "Title: Good place\nRating: 4\nPros: Friendly team\nand good mentors\nCons: Low pay\n\nLikes: Flexible\nDislikes: Politics\n★★"
    reviews, skipped = parse_text(text)
    assert skipped == 0 and len(reviews) == 2
    assert reviews[0]["pros"] == "Friendly team and good mentors" and reviews[0]["rating"] == 4.0
    assert reviews[1]["cons"] == "Politics" and reviews[1]["rating"] == 2.0


def test_parse_errors():
    no_text = b"a,b\n1,2\n"
    assert client.post("/api/reviews/parse", data={"platform": "glassdoor"}, files={"file": ("x.csv", no_text, "text/csv")}).status_code == 422
    assert client.post("/api/reviews/parse", data={"platform": "twitter", "text": "Pros: x"}).status_code == 422
    assert client.post("/api/reviews/parse", data={"platform": "other"}).status_code == 422
    assert client.post("/api/reviews/parse", data={"platform": "other", "text": "123\n\n456"}).status_code == 422


def test_analyze_summary_consistency():
    with open(SAMPLES / "sample_glassdoor_acme.csv", "rb") as fh:
        reviews = client.post("/api/reviews/parse", data={"platform": "glassdoor"}, files={"file": ("g.csv", fh, "text/csv")}).json()["reviews"]
    for i, r in enumerate(reviews):
        r["id"], r["import_id"] = f"r{i}", "imp1"
    body = client.post("/api/reviews/analyze", json={"reviews": reviews}).json()
    s = body["summary"]
    assert s["total"] == len(reviews) == sum(s["counts"].values())
    assert sum(s["rating_distribution"].values()) == s["rated"] == len(reviews)
    assert sum(v for row in s["rating_matrix"].values() for v in row.values()) == s["rated"]
    agree = sum(s["rating_matrix"][k][k] for k in s["rating_matrix"])
    assert s["rating_agreement"] == round(agree / s["rated"], 4)
    assert s["themes"]["source"] == "pros_cons" and s["themes"]["positive"] and s["themes"]["negative"]
    assert all(r["import_id"] == "imp1" and r["id"].startswith("r") for r in body["reviews"])
    assert all("pros_label" in r and "cons_label" in r for r in body["reviews"])


def test_analyze_validation():
    assert client.post("/api/reviews/analyze", json={"reviews": []}).status_code == 422
    assert client.post("/api/reviews/analyze", json={"reviews": [{"pros": "ok", "rating": 9}]}).status_code == 422


def test_themes_keep_work_life_balance_together():
    themes = dict(_themes(["Good work life balance", "work-life balance is great", "Work Life Balance and pay"]))
    assert themes.get("work-life balance") == 3
