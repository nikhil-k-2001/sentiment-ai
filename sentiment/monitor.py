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
from .preprocess import LABELS
from .sources import SOURCES, fetch_mentions

MAX_TEXT = 2000
# Spam control: one account posting dozens of near-identical messages (bots,
# auto-posters) would otherwise dominate the statistics.
MAX_PER_AUTHOR = 3
_TOKEN = re.compile(r"[a-z][a-z']{2,}")
_STOP = frozenset("""
a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for
from further get got had hadn't has hasn't have haven't having he her here hers herself him himself his how i if
in into is isn't it it's its itself just let's like me more most much my myself no nor not now of off on once only
or other ought our ours ourselves out over own really same she should shouldn't so some such than that that's the
their theirs them themselves then there there's these they they're this those through to too under until up us
very was wasn't we were weren't what when where which while who whom why will with won't would wouldn't you your
yours yourself yourselves one two new via also still even back way well make made says said say going go see
know think want need people time year years day days today week thing things lot url http https www com amp
the's i'm i've you're we're it'll that'll there'll im ive dont cant
""".split())


_PROFANE = frozenset("fuck fucking fucked shit shitty bullshit bitch asshole cunt dick crap damn".split())


def _parse_ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _keywords(mentions: list[dict], query: str, n: int = 12) -> dict[str, list[tuple[str, int]]]:
    """Words that distinguish positive and negative mentions.

    For each word we compare the share of mentions of one sentiment that
    contain it with the share of all *other* mentions that contain it, and keep
    words that are clearly over-represented (so generic words such as the
    product category, common to every mention, drop out). Returned counts are
    the number of mentions of that sentiment containing the word.
    """
    skip = set(_STOP) | {w.lower() for w in re.findall(r"\w+", query)}
    docs = [({w.strip("'") for w in _TOKEN.findall(m["text"].lower())} - skip, m["label"]) for m in mentions]
    out = {}
    for label in ("positive", "negative"):
        inside = [w for w, lbl in docs if lbl == label]
        other = [w for w, lbl in docs if lbl != label]
        if not inside:
            out[label] = []
            continue
        df_in = Counter(w for ws in inside for w in ws)
        df_out = Counter(w for ws in other for w in ws)
        scored = []
        for w, c in df_in.items():
            if c < 2:
                continue
            lift = c / len(inside) - (df_out[w] / len(other) if other else 0)
            if lift > 0.02:
                scored.append((lift, w, c))
        scored.sort(reverse=True)
        out[label] = [(w, c) for _, w, c in scored[:n]]
    return out


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _insights(mentions: list[dict], by_source: dict, keywords: dict, now: float) -> list[dict]:
    out: list[dict] = []
    n = len(mentions)
    counts = Counter(m["label"] for m in mentions)
    net = (counts["positive"] - counts["negative"]) / n * 100
    if net >= 15:
        out.append({"type": "positive", "text": f"Positive mentions outnumber negative ones ({counts['positive']} vs {counts['negative']}), net sentiment {net:+.0f}."})
    elif net <= -15:
        out.append({"type": "negative", "text": f"Negative mentions outnumber positive ones ({counts['negative']} vs {counts['positive']}), net sentiment {net:+.0f}."})
    else:
        out.append({"type": "info", "text": f"Sentiment is balanced: {counts['positive']} positive vs {counts['negative']} negative, net {net:+.0f}. Most mentions ({_pct(counts['neutral'] / n)}) are neutral."})

    # Shift in the last 24 hours vs. everything older.
    recent = [m for m in mentions if m["ts"] and now - m["ts"] <= 86400]
    older = [m for m in mentions if m["ts"] and now - m["ts"] > 86400]
    if len(recent) >= 8 and len(older) >= 8:
        r = sum(m["label"] == "negative" for m in recent) / len(recent)
        o = sum(m["label"] == "negative" for m in older) / len(older)
        if r - o >= 0.10:
            out.append({"type": "alert", "text": f"Negative share rose to {_pct(r)} in the last 24 hours (from {_pct(o)} before). Something may be driving complaints."})
        elif o - r >= 0.10:
            out.append({"type": "positive", "text": f"Negative share fell to {_pct(r)} in the last 24 hours (from {_pct(o)} before)."})

    eligible = {k: v for k, v in by_source.items() if v["total"] >= 5}
    if len(eligible) >= 2:
        worst = max(eligible, key=lambda k: eligible[k]["counts"]["negative"] / eligible[k]["total"])
        best = max(eligible, key=lambda k: eligible[k]["counts"]["positive"] / eligible[k]["total"])
        w = eligible[worst]
        out.append({"type": "negative", "text": f"{SOURCES[worst]['name']} is the most critical source: {_pct(w['counts']['negative'] / w['total'])} of its {w['total']} mentions are negative."})
        if best != worst:
            b = eligible[best]
            out.append({"type": "positive", "text": f"{SOURCES[best]['name']} is the most positive source: {_pct(b['counts']['positive'] / b['total'])} of its {b['total']} mentions are positive."})

    if keywords["negative"]:
        w, c = keywords["negative"][0]
        if w in _PROFANE:
            w = w[0] + "*" * (len(w) - 2) + w[-1]
        out.append({"type": "info", "text": f"“{w}” stands out in negative mentions: it appears in {c} of them, far more often than in other mentions."})

    neg = [m for m in mentions if m["label"] == "negative" and m["engagement"] > 0]
    if neg:
        top = max(neg, key=lambda m: m["engagement"])
        if top["engagement"] >= 5:
            out.append({"type": "alert", "text": f"The most-engaged negative mention ({SOURCES[top['source']]['name']}, {top['engagement']} interactions) is worth reviewing.", "mention_id": top["id"]})
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
        mentions.append({**m, "ts": _parse_ts(m.get("published_at")), "label": p.label,
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
