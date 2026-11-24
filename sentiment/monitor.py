"""Brand monitoring: fetch live mentions, score them, and summarise.

All numbers come from the fetched mentions and the trained model. The
"insights" are simple, transparent rules over those numbers (no generated
text), so every sentence can be traced back to the data shown in the UI.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone

from .model import model
from .themes import distinctive_terms
from .preprocess import LABELS
from .sources import SOURCES, fetch_mentions, safe_url

MAX_TEXT = 2000
# Spam control: one account posting dozens of near-identical messages (bots,
# auto-posters) would otherwise dominate the statistics.
MAX_PER_AUTHOR = 3
# Below these sample sizes, percentages swing wildly, so we say so instead of
# presenting a confident-sounding insight.
MIN_TOTAL_FOR_INSIGHTS = 15
MIN_SOURCE_SAMPLE = 10
MIN_WINDOW_SAMPLE = 10
_PROFANE = frozenset("fuck fucking fucked shit shitty bullshit bitch asshole cunt dick crap damn".split())


def _parse_ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _keywords(mentions: list[dict], query: str, n: int = 12) -> dict[str, list[tuple[str, int]]]:
    """Words/phrases over-represented in positive vs negative mentions (see themes.py)."""
    skip = {w.lower() for w in re.findall(r"\w+", query)}
    out = {}
    for label in ("positive", "negative"):
        group = [m["text"] for m in mentions if m["label"] == label]
        rest = [m["text"] for m in mentions if m["label"] != label]
        out[label] = distinctive_terms(group, rest, n=n, skip=skip)
    return out


def _period(stamps: list[float]) -> dict:
    iso = lambda t: datetime.fromtimestamp(t, tz=timezone.utc).isoformat(timespec="seconds")  # noqa: E731
    return {"from": iso(min(stamps)), "to": iso(max(stamps))} if stamps else {"from": None, "to": None}


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _insights(mentions: list[dict], by_source: dict, keywords: dict, now: float) -> list[dict]:
    """Rule-based findings. Each carries the evidence (n) and an optional feed
    filter so the UI can link straight to the mentions behind it."""
    out: list[dict] = []
    n = len(mentions)
    counts = Counter(m["label"] for m in mentions)
    if n < MIN_TOTAL_FOR_INSIGHTS:
        out.append({"type": "alert", "text": f"Only {n} mention{'s' if n != 1 else ''} found. Percentages from so few "
                    "posts are not reliable — read the individual mentions instead of relying on the scores.",
                    "evidence": f"{n} mentions", "filter": {}})
        return out

    net = (counts["positive"] - counts["negative"]) / n * 100
    if net >= 15:
        out.append({"type": "positive", "text": f"Positive mentions outnumber negative ones ({counts['positive']} vs {counts['negative']}), net sentiment {net:+.0f}.",
                    "evidence": f"{n} mentions", "filter": {"label": "positive"}})
    elif net <= -15:
        out.append({"type": "negative", "text": f"Negative mentions outnumber positive ones ({counts['negative']} vs {counts['positive']}), net sentiment {net:+.0f}.",
                    "evidence": f"{n} mentions", "filter": {"label": "negative"}})
    else:
        out.append({"type": "info", "text": f"Sentiment is balanced: {counts['positive']} positive vs {counts['negative']} negative (net {net:+.0f}); {_pct(counts['neutral'] / n)} of mentions are neutral.",
                    "evidence": f"{n} mentions", "filter": {}})

    # Shift in the last 24 hours vs. everything older.
    recent = [m for m in mentions if m["ts"] and now - m["ts"] <= 86400]
    older = [m for m in mentions if m["ts"] and now - m["ts"] > 86400]
    if len(recent) >= MIN_WINDOW_SAMPLE and len(older) >= MIN_WINDOW_SAMPLE:
        r = sum(m["label"] == "negative" for m in recent) / len(recent)
        o = sum(m["label"] == "negative" for m in older) / len(older)
        ev = f"{len(recent)} recent vs {len(older)} older mentions"
        if r - o >= 0.10:
            out.append({"type": "alert", "text": f"Negative share rose to {_pct(r)} in the last 24 hours (from {_pct(o)} before). Review the latest negative mentions to see what changed.",
                        "evidence": ev, "filter": {"label": "negative", "sort": "newest"}})
        elif o - r >= 0.10:
            out.append({"type": "positive", "text": f"Negative share fell to {_pct(r)} in the last 24 hours (from {_pct(o)} before).",
                        "evidence": ev, "filter": {"sort": "newest"}})

    eligible = {k: v for k, v in by_source.items() if v["total"] >= MIN_SOURCE_SAMPLE}
    if len(eligible) >= 2:
        worst = max(eligible, key=lambda k: eligible[k]["counts"]["negative"] / eligible[k]["total"])
        best = max(eligible, key=lambda k: eligible[k]["counts"]["positive"] / eligible[k]["total"])
        w = eligible[worst]
        out.append({"type": "negative", "text": f"{SOURCES[worst]['name']} is the most critical source: {_pct(w['counts']['negative'] / w['total'])} of its {w['total']} mentions are negative.",
                    "evidence": f"{w['total']} mentions", "filter": {"source": worst, "label": "negative"}})
        if best != worst:
            b = eligible[best]
            out.append({"type": "positive", "text": f"{SOURCES[best]['name']} is the most positive source: {_pct(b['counts']['positive'] / b['total'])} of its {b['total']} mentions are positive.",
                        "evidence": f"{b['total']} mentions", "filter": {"source": best, "label": "positive"}})

    if keywords["negative"]:
        w, c = keywords["negative"][0]
        shown = w[0] + "*" * (len(w) - 2) + w[-1] if w in _PROFANE else w
        out.append({"type": "info", "text": f"\u201c{shown}\u201d stands out in negative mentions: it appears in {c} of {counts['negative']}, far more often than in other mentions.",
                    "evidence": f"{c} of {counts['negative']} negative mentions", "filter": {"label": "negative", "q": w}})
    if keywords["positive"]:
        w, c = keywords["positive"][0]
        out.append({"type": "positive", "text": f"Positive mentions often mention \u201c{w}\u201d ({c} of {counts['positive']}).",
                    "evidence": f"{c} of {counts['positive']} positive mentions", "filter": {"label": "positive", "q": w}})

    neg = [m for m in mentions if m["label"] == "negative" and m["engagement"] > 0]
    if neg:
        top = max(neg, key=lambda m: m["engagement"])
        if top["engagement"] >= 5:
            out.append({"type": "alert", "text": f"The most-engaged negative mention ({SOURCES[top['source']]['name']}, {top['engagement']} interactions) is reaching people and may be worth a response.",
                        "evidence": f"{top['engagement']} interactions", "mention_id": top["id"]})
    return out


def analyse_brand(query: str, sources: list[str], limit: int) -> dict:
    fetched, status = fetch_mentions(query, sources, limit)
    now = datetime.now(timezone.utc).timestamp()

    # Keep at most MAX_PER_AUTHOR mentions per account per source (newest first).
    fetched.sort(key=lambda m: _parse_ts(m.get("published_at")) or 0, reverse=True)
    per_author: Counter = Counter()
    raw, filtered = [], Counter()
    for m in fetched:
        key = (m["source"], (m.get("author") or "").lower())
        if m["source"] != "news" and key[1]:
            per_author[key] += 1
            if per_author[key] > MAX_PER_AUTHOR:
                filtered[m["source"]] += 1
                continue
        raw.append(m)
    for st in status:
        st["filtered"] = filtered.get(st["source"], 0)

    preds = model.predict_many([m["text"][:MAX_TEXT] for m in raw]) if raw else []
    mentions = []
    for m, p in zip(raw, preds):
        mentions.append({**m, "url": safe_url(m.get("url")), "ts": _parse_ts(m.get("published_at")), "label": p.label,
                         "confidence": round(p.confidence, 4),
                         "probabilities": {k: round(v, 4) for k, v in p.probabilities.items()}})
    mentions.sort(key=lambda m: m["ts"] or 0, reverse=True)

    n = len(mentions)
    counts = {lbl: sum(m["label"] == lbl for m in mentions) for lbl in LABELS}

    by_source = {}
    per_day_total = 0.0
    for s in sources:
        ms = [m for m in mentions if m["source"] == s]
        if not ms:
            continue
        c = {lbl: sum(m["label"] == lbl for m in ms) for lbl in LABELS}
        stamps = [m["ts"] for m in ms if m["ts"]]
        # Mention rate: how many mentions per day the source produced over the
        # window covered by the items we fetched (newest-first feeds).
        span_days = max((now - min(stamps)) / 86400, 1 / 24) if stamps else None
        per_day = len(ms) / span_days if span_days else None
        per_day_total += per_day or 0
        by_source[s] = {"name": SOURCES[s]["name"], "total": len(ms), "counts": c,
                        "net_score": round((c["positive"] - c["negative"]) / len(ms) * 100),
                        "per_day": round(per_day, 1) if per_day else None,
                        "engagement": sum(m["engagement"] for m in ms)}

    keywords = _keywords(mentions, query)
    summary = {
        "total": n,
        "counts": counts,
        "net_score": round((counts["positive"] - counts["negative"]) / n * 100) if n else 0,
        "avg_confidence": round(sum(m["confidence"] for m in mentions) / n, 4) if n else None,
        "engagement": sum(m["engagement"] for m in mentions),
        "filtered_repetitive": sum(filtered.values()),
        "low_sample": n < MIN_TOTAL_FOR_INSIGHTS,
        "period": _period([m["ts"] for m in mentions if m["ts"]]),
        "mentions_per_day": round(per_day_total, 1),
        "by_source": by_source,
        "keywords": keywords,
        "insights": _insights(mentions, by_source, keywords, now) if n else [],
    }
    return {
        "query": query,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": status,
        "mentions": mentions,
        "summary": summary,
    }
