"""Tests added in the QA pass: file robustness, previews, themes, warnings,
small-sample honesty, link safety and error handling. Network is mocked."""

import io

import pytest
from fastapi.testclient import TestClient

import sentiment.monitor as monitor
from sentiment.api import app
from sentiment.model import language_warning, model
from sentiment.sources import safe_url
from sentiment.tabular import TableError, read_csv_bytes
from sentiment.themes import distinctive_terms

pytestmark = pytest.mark.skipif(not model.ready, reason="train the model first (scripts/train.py)")
client = TestClient(app, raise_server_exceptions=False)


def upload(path, data: bytes, name="f.csv", **form):
    return client.post(path, files={"file": (name, io.BytesIO(data), "text/csv")}, data=form)


# ------------------------------------------------------------- CSV reading
@pytest.mark.parametrize("raw,cols", [
    ("text\nhello there\n".encode("utf-16"), ["text"]),
    (b"id;text\n1;great\n2;bad\n", ["id", "text"]),
    (b"id\ttext\n1\tgreat\n", ["id", "text"]),
    ("text\ncaf\xe9 tr\xe8s bon\n".encode("latin-1"), ["text"]),
    (b"\xef\xbb\xbftext\nwith bom\n", ["text"]),
])
def test_read_csv_formats(raw, cols):
    df = read_csv_bytes(raw)
    assert list(df.columns) == cols and len(df) >= 1


def test_read_csv_never_returns_nan_and_rejects_junk():
    df = read_csv_bytes(b"text\n\n,\ngood\n")
    assert all(isinstance(v, str) for v in df["text"])
    with pytest.raises(TableError, match="empty"):
        read_csv_bytes(b"   ")
    with pytest.raises(TableError, match="unclosed quote"):
        read_csv_bytes(b'text\n"never closed,good\nbad\n')


def test_batch_extra_comma_row_does_not_crash():
    r = upload("/api/batch", b"text\n\n,\ngood\n")
    assert r.status_code == 200 and r.json()["summary"]["analyzed"] == 1


# ----------------------------------------------------------------- preview
def test_batch_preview_detects_column_and_counts():
    r = upload("/api/batch/preview", b"id,title,comment\n1,A,The app is broken\n2,B,\n3,C,Love it\n")
    body = r.json()
    assert r.status_code == 200 and body["detected_column"] == "comment"
    col = next(c for c in body["columns"] if c["name"] == "comment")
    assert col["valid"] == 2 and col["empty"] == 1 and col["sample"][0] == "The app is broken"
    assert next(c for c in body["columns"] if c["name"] == "id")["valid"] == 0


def test_batch_preview_errors():
    assert upload("/api/batch/preview", b"a,b\n1,2\n").status_code == 422
    assert upload("/api/batch/preview", b"x", name="f.pdf").status_code == 422


def test_batch_reports_truncation():
    raw = ("text\n" + "\n".join(f"row {i} is fine" for i in range(5100))).encode()
    s = upload("/api/batch", raw).json()["summary"]
    assert s["truncated"] and s["analyzed"] == 5000 and s["total_rows"] == 5100


def test_batch_themes_present_and_ignore_handles():
    rows = ["@acmeair flight delayed again, terrible service"] * 6 + ["@acmeair thanks, great crew"] * 6 + ["@acmeair my booking ref is 123"] * 3
    s = upload("/api/batch", ("text\n" + "\n".join(rows)).encode()).json()["summary"]
    neg = [t for t, _ in s["themes"]["negative"]]
    assert neg and not any("acmeair" in t for t in neg)
    assert any("delayed" in t or "terrible" in t for t in neg)


# ------------------------------------------------------------------ themes
def test_distinctive_terms_behaviour():
    group = ["slow delivery again", "slow delivery and rude staff", "delivery was slow"]
    rest = ["fast delivery, lovely staff", "delivery on time"]
    terms = dict(distinctive_terms(group, rest))
    assert "slow" in terms or "slow delivery" in terms
    assert "delivery" not in terms  # appears everywhere, not distinctive
    merged = dict(distinctive_terms(["thanks a lot", "thank you", "thanks team", "thank you so much"], ["ok"]))
    assert not ("thank" in merged and "thanks" in merged)
    assert distinctive_terms([], ["x"]) == []


# --------------------------------------------------------- analyze warnings
@pytest.mark.parametrize("text,warn", [
    ("El servicio fue terrible y muy lento", True),
    ("Le service est très lent et pas bon", True),
    ("यह सेवा बहुत अच्छी है", True),
    ("Great food but terrible service", False),
    ("Fantastic course instructor explains everything clearly", False),
])
def test_language_warning(text, warn):
    assert bool(language_warning(text)) is warn


def test_analyze_returns_warnings():
    assert client.post("/api/analyze", json={"text": "great"}).json()["warnings"]
    assert client.post("/api/analyze", json={"text": "The support team solved my problem quickly, thank you"}).json()["warnings"] == []


# ------------------------------------------------------- monitor honesty
def _fake_fetch(n, url="https://example.com/x"):
    ms = [{"id": f"bluesky:{i}", "source": "bluesky", "title": None, "text": f"Acme is terrible {i}", "url": url,
           "author": f"user{i}", "published_at": f"2026-11-{10 + i % 9:02d}T10:00:00Z", "engagement": i} for i in range(n)]
    status = [{"source": "bluesky", "name": "Bluesky", "ok": True, "count": n, "error": None, "cached": False}]
    return lambda q, s, limit: ([dict(m) for m in ms], [dict(x) for x in status])


def test_small_samples_only_get_a_caution(monkeypatch):
    monkeypatch.setattr(monitor, "fetch_mentions", _fake_fetch(5))
    s = client.post("/api/monitor", json={"query": "Acme"}).json()["summary"]
    assert s["low_sample"] is True
    assert len(s["insights"]) == 1 and "not reliable" in s["insights"][0]["text"]


def test_insights_carry_evidence_and_period(monkeypatch):
    monkeypatch.setattr(monitor, "fetch_mentions", _fake_fetch(30))
    s = client.post("/api/monitor", json={"query": "Acme"}).json()["summary"]
    assert not s["low_sample"]
    assert all("evidence" in i for i in s["insights"])
    assert s["period"]["from"] < s["period"]["to"]


def test_unsafe_links_are_removed(monkeypatch):
    monkeypatch.setattr(monitor, "fetch_mentions", _fake_fetch(3, url="javascript:alert(1)"))
    mentions = client.post("/api/monitor", json={"query": "Acme"}).json()["mentions"]
    assert all(m["url"] is None for m in mentions)
    assert safe_url("https://ok.example/a") == "https://ok.example/a"
    assert safe_url("JAVASCRIPT:alert(1)") is None and safe_url(None) is None


# ---------------------------------------------------- errors & transport
def test_unexpected_errors_are_json_without_stack_traces(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("secret internal detail")
    monkeypatch.setattr(model, "predict_many", boom)
    r = client.post("/api/analyze", json={"text": "hello world"})
    assert r.status_code == 500
    assert r.json()["code"] == "internal_error" and "secret" not in r.text and "Traceback" not in r.text


def test_large_responses_are_compressed():
    r = client.get("/static/css/styles.css", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"


def test_reviews_without_text_are_rejected():
    r = client.post("/api/reviews/analyze", json={"reviews": [{"title": "", "pros": "", "cons": "", "text": ""}]})
    assert r.status_code == 422


def test_single_column_file_keeps_unquoted_commas():
    df = read_csv_bytes(b"text\nslow delivery, rude staff\nfast, friendly and cheap\n")
    assert df["text"].tolist() == ["slow delivery, rude staff", "fast, friendly and cheap"]
