"""Brand-monitor tests. Network access is mocked, so these run offline."""

import httpx
import pytest
from fastapi.testclient import TestClient

import sentiment.monitor as monitor
from sentiment import sources
from sentiment.api import app
from sentiment.model import model

pytestmark = pytest.mark.skipif(not model.ready, reason="train the model first (scripts/train.py)")
client = TestClient(app)


def _mention(i, text, source="bluesky", author=None, engagement=0):
    return {"id": f"{source}:{i}", "source": source, "title": None, "text": text, "url": f"https://example.com/{i}",
            "author": author or f"user{i}", "published_at": f"2026-01-0{1 + i % 9}T10:00:00Z", "engagement": engagement}


FAKE = [
    _mention(1, "I love Acme, the new update is fantastic and support was amazing!"),
    _mention(2, "Acme support is terrible, worst experience ever, still waiting for a refund."),
    _mention(3, "Acme announced a new office in Berlin.", source="news"),
    _mention(4, "Thanks Acme, great job on the app, really happy with it.", source="hn", engagement=12),
    # One account spamming: only MAX_PER_AUTHOR of these should be kept.
    *[_mention(10 + i, f"Acme promo post number {i}", source="mastodon", author="spambot") for i in range(5)],
]


@pytest.fixture
def fake_fetch(monkeypatch):
    status = [{"source": s, "name": sources.SOURCES[s]["name"], "ok": True, "count": 0, "error": None, "cached": False}
              for s in ("bluesky", "news", "hn", "mastodon")]
    monkeypatch.setattr(monitor, "fetch_mentions", lambda q, s, limit: ([dict(m) for m in FAKE], [dict(x) for x in status]))


def test_monitor_summary_is_consistent(fake_fetch):
    r = client.post("/api/monitor", json={"query": "Acme"})
    assert r.status_code == 200
    body = r.json()
    s = body["summary"]
    assert s["filtered_repetitive"] == 5 - monitor.MAX_PER_AUTHOR
    assert s["total"] == len(FAKE) - s["filtered_repetitive"] == len(body["mentions"])
    assert sum(s["counts"].values()) == s["total"]
    assert s["net_score"] == round((s["counts"]["positive"] - s["counts"]["negative"]) / s["total"] * 100)
    assert sum(v["total"] for v in s["by_source"].values()) == s["total"]
    labels = {m["id"]: m["label"] for m in body["mentions"]}
    assert labels["bluesky:1"] == "positive" and labels["bluesky:2"] == "negative"
    assert all(abs(sum(m["probabilities"].values()) - 1) < 1e-3 for m in body["mentions"])
    assert s["insights"] and all(i["text"] for i in s["insights"])


def test_keywords_exclude_query_and_stopwords():
    ms = [{"text": "Acme refund delayed again, refund please", "label": "negative"},
          {"text": "Acme refund still missing", "label": "negative"},
          {"text": "Acme is lovely", "label": "positive"}]
    kw = monitor._keywords(ms, "Acme")
    neg = dict(kw["negative"])
    assert "refund" in neg and "acme" not in neg and "still" not in neg


@pytest.mark.parametrize("payload", [{"query": "x"}, {"query": "1234"}, {"query": "a" * 61},
                                     {"query": "Acme", "sources": ["twitter"]}, {"query": "Acme", "limit": 500}])
def test_monitor_validation(payload):
    assert client.post("/api/monitor", json=payload).status_code == 422


def test_all_sources_down_returns_502(monkeypatch):
    down = [{"source": "hn", "name": "Hacker News", "ok": False, "count": 0, "error": "timed out", "cached": False}]
    monkeypatch.setattr(monitor, "fetch_mentions", lambda q, s, limit: ([], [dict(x) for x in down]))
    r = client.post("/api/monitor", json={"query": "Acme", "sources": ["hn"]})
    assert r.status_code == 502 and "timed out" in r.json()["detail"]


def test_sources_endpoint():
    keys = {s["key"] for s in client.get("/api/sources").json()}
    assert keys == set(sources.SOURCES)


# ------------------------------------------------------------ source parsers
def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_hn_parser_strips_html_and_filters_irrelevant():
    payload = {"hits": [
        {"objectID": "1", "_tags": ["comment"], "comment_text": "<p>I &amp; my team love <i>Acme</i></p>", "author": "a", "created_at_i": 1700000000},
        {"objectID": "2", "_tags": ["comment"], "comment_text": "Unrelated text", "author": "b", "created_at_i": 1700000000},
        {"objectID": "3", "_tags": ["story"], "title": "Acme raises $10M", "points": 50, "num_comments": 7, "author": "c", "created_at_i": 1700000000},
    ]}
    out = sources.fetch_hn(_client(lambda req: httpx.Response(200, json=payload)), "acme", 50)
    assert [m["id"] for m in out] == ["hn:1", "hn:3"]
    assert out[0]["text"] == "I & my team love Acme"
    assert out[1]["engagement"] == 57 and out[1]["url"].endswith("id=3")


def test_news_parser_removes_publisher_suffix():
    rss = b"""<?xml version="1.0"?><rss><channel>
      <item><title>Acme beats estimates - Reuters</title><link>https://n/1</link><guid>g1</guid>
        <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
      <item><title>Something else - AP</title><link>https://n/2</link><guid>g2</guid><source>AP</source></item>
    </channel></rss>"""
    out = sources.fetch_news(_client(lambda req: httpx.Response(200, content=rss)), "Acme", 50)
    assert len(out) == 1 and out[0]["text"] == "Acme beats estimates" and out[0]["author"] == "Reuters"
    assert out[0]["published_at"].startswith("2026-11-23")


def test_rate_limit_is_reported():
    with pytest.raises(sources.SourceError, match="rate limited"):
        sources.fetch_hn(_client(lambda req: httpx.Response(429)), "acme", 10)
