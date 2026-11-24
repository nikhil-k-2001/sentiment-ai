"""API + model tests. Run with:  pytest -q"""

import io

import pytest
from fastapi.testclient import TestClient

from sentiment.api import app
from sentiment.model import model
from sentiment.preprocess import clean_text

pytestmark = pytest.mark.skipif(not model.ready, reason="train the model first (scripts/train.py)")
client = TestClient(app)


def test_clean_text_normalises():
    assert clean_text("@united I CAN'T believe it!!! http://t.co/x :)") == "i can not believe it! url emopos"
    assert clean_text(None) == ""


def test_health_and_model_info():
    assert client.get("/api/health").json() == {"status": "ok", "model_ready": True}
    info = client.get("/api/model").json()
    assert set(info["model"]["classes"]) == {"positive", "negative", "neutral"}
    assert 0.5 < info["test"]["accuracy"] <= 1
    assert len(info["test"]["confusion_matrix"]) == 3


@pytest.mark.parametrize("text,label", [
    ("Thank you so much, the crew was amazing and the flight was great!", "positive"),
    ("Worst airline ever. Lost my bag and the staff were rude.", "negative"),
    ("What time does the flight to Boston depart tomorrow?", "neutral"),
])
def test_clear_cases(text, label):
    r = client.post("/api/analyze", json={"text": text}).json()
    assert r["label"] == label
    assert abs(sum(r["probabilities"].values()) - 1) < 1e-6
    assert r["confidence"] == max(r["probabilities"].values())
    assert r["summary"]


def test_keywords_reflect_model():
    r = client.post("/api/analyze", json={"text": "The service was terrible"}).json()
    words = {k["word"]: k for k in r["keywords"]}
    assert "terrible" in words and words["terrible"]["sentiment"] == "negative"


@pytest.mark.parametrize("payload", [{"text": ""}, {"text": "    "}, {"text": "1234 !!"}, {"text": "a" * 5001}, {}])
def test_invalid_input_is_rejected(payload):
    assert client.post("/api/analyze", json=payload).status_code == 422


def test_unicode_and_odd_input_does_not_crash():
    for t in ["🙂🙂 great", "Ça va très bien, merci!", "<script>alert(1)</script> bad", "x" * 4999]:
        assert client.post("/api/analyze", json={"text": t}).status_code == 200


def test_batch_csv_roundtrip():
    csv = "id,review\n1,I love it\n2,This is awful\n3,\n4,When does it ship?\n"
    r = client.post("/api/batch", files={"file": ("r.csv", io.BytesIO(csv.encode()), "text/csv")})
    body = r.json()
    assert r.status_code == 200
    assert body["column_used"] == "review"
    assert body["summary"]["analyzed"] == 3 and body["summary"]["skipped"] == 1
    assert sum(body["summary"]["counts"].values()) == 3


def test_batch_column_override_and_errors():
    csv = "a,b\nhello there friend,great product\n"
    r = client.post("/api/batch", files={"file": ("x.csv", io.BytesIO(csv.encode()), "text/csv")}, data={"column": "b"})
    assert r.json()["column_used"] == "b"
    assert client.post("/api/batch", files={"file": ("x.csv", io.BytesIO(csv.encode()), "text/csv")}, data={"column": "zzz"}).status_code == 422
    assert client.post("/api/batch", files={"file": ("x.pdf", io.BytesIO(b"%PDF"), "application/pdf")}).status_code == 422
    assert client.post("/api/batch", files={"file": ("e.csv", io.BytesIO(b""), "text/csv")}).status_code == 422


def test_frontend_served():
    assert client.get("/").status_code == 200
    assert client.get("/static/js/app.js").status_code == 200
