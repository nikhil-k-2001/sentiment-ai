"""Imported employee/customer reviews (Glassdoor, AmbitionBox or any CSV).

SentimentAI does not scrape review sites: their terms forbid automated
collection. Instead users import reviews they have collected themselves, as a
CSV file or pasted text. This module

* parses those inputs into one normalised shape (auto-detecting columns such
  as Pros/Likes, Cons/Dislikes, Rating, Date, Job title), and
* analyses them: overall sentiment per review, separate sentiment for pros and
  cons, recurring themes, rating distribution, and how often the model agrees
  with the reviewer's own star rating.
"""

from __future__ import annotations

import io
import re
from collections import Counter

import pandas as pd

from .model import model
from .preprocess import LABELS

PLATFORMS = {
    "glassdoor": "Glassdoor",
    "ambitionbox": "AmbitionBox",
    "other": "Other reviews",
}
MAX_REVIEWS = 3000
MAX_FIELD = 3000

# Column names we recognise (compared after lower-casing and stripping
# everything but letters/digits).
COLUMN_HINTS = {
    "pros": ["pros", "likes", "like", "whatilike", "whatyoulike", "liked", "positives", "good", "advantages", "thegood"],
    "cons": ["cons", "dislikes", "dislike", "whatidislike", "whatyoudislike", "disliked", "negatives", "bad", "disadvantages", "thebad"],
    "text": ["review", "reviewtext", "text", "comment", "comments", "feedback", "content", "body", "description", "advice", "advicetomanagement"],
    "title": ["title", "headline", "reviewtitle", "summary", "heading"],
    "rating": ["rating", "overallrating", "overall", "stars", "score", "ratingoverall"],
    "date": ["date", "reviewdate", "posted", "postedon", "createdat", "reviewedon", "time"],
    "role": ["jobtitle", "role", "designation", "position", "title_role", "employeetitle", "profile", "department"],
    "location": ["location", "city", "office"],
    "status": ["employmentstatus", "status", "employeestatus", "currentformer"],
}

_KEY_LINE = re.compile(r"^\s*(pros|likes?|what i like|cons|dislikes?|what i dislike|rating|title|role|job title|designation|date)\s*[:\-]\s*(.*)$", re.I)
_STARS = re.compile(r"[★⭐]")
_NUM = re.compile(r"(\d+(?:\.\d+)?)")

_TOKEN = re.compile(r"[a-z][a-z'&-]{1,}")
_STOP = frozenset("""
a about above after again all also am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further get gets got had has have having he her here him his
how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own
same she should so some such than that the their them then there these they this those through to too under until up
very was we were what when where which while who why will with would you your yours company work working job also lot
lots one good bad great nice like dislike pros cons nothing none na n/a much many every really well get able things
thing etc us people employee employees time make makes made overall even still per
""".split())


_WLB = re.compile(r"\bwork[\s-]*life[\s-]*balance\b")


class ReviewImportError(ValueError):
    pass


# ------------------------------------------------------------------ parsing
def _norm(col: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(col).lower())


def _detect_columns(columns: list[str]) -> dict[str, str]:
    normed = {_norm(c): c for c in columns}
    found: dict[str, str] = {}
    used: set[str] = set()
    # Order matters: "title" of a review vs "job title" of the reviewer.
    for field in ("pros", "cons", "rating", "date", "role", "title", "text", "location", "status"):
        for hint in COLUMN_HINTS[field]:
            col = normed.get(hint)
            if col is not None and col not in used:
                found[field] = col
                used.add(col)
                break
    return found


def parse_rating(value) -> float | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() in {"nan", "none", "na", "n/a"}:
        return None
    stars = len(_STARS.findall(s))
    if stars and not _NUM.search(s):
        return float(min(stars, 5))
    m = _NUM.search(s)
    if not m:
        return None
    r = float(m.group(1))
    if "/10" in s or (5 < r <= 10):
        r = r / 2
    return r if 1 <= r <= 5 else None


def _parse_date(value) -> str | None:
    s = str(value or "").strip()
    if not s or s.lower() in {"nan", "none"}:
        return None
    ts = pd.to_datetime(s, errors="coerce", dayfirst=False)
    if pd.isna(ts):
        return None
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.isoformat()


def _clip(v) -> str:
    s = "" if v is None else str(v)
    s = "" if s.lower() in {"nan", "none"} else re.sub(r"\s+", " ", s).strip()
    return s[:MAX_FIELD]


def _finish(raw: list[dict]) -> list[dict]:
    out = []
    for r in raw:
        review = {
            "title": _clip(r.get("title")), "text": _clip(r.get("text")),
            "pros": _clip(r.get("pros")), "cons": _clip(r.get("cons")),
            "rating": parse_rating(r.get("rating")), "date": _parse_date(r.get("date")),
            "role": _clip(r.get("role"))[:120], "location": _clip(r.get("location"))[:120],
            "status": _clip(r.get("status"))[:60],
        }
        if any(review[k] and re.search(r"[A-Za-z]", review[k]) for k in ("title", "text", "pros", "cons")):
            out.append(review)
    return out


def parse_csv(raw: bytes) -> tuple[list[dict], dict, int]:
    df = None
    for enc in ("utf-8-sig", "latin-1"):
        try:
            df = pd.read_csv(io.BytesIO(raw), encoding=enc, dtype=str, keep_default_na=False,
                             on_bad_lines="skip", engine="python")
            break
        except UnicodeDecodeError:
            continue
        except Exception as exc:  # noqa: BLE001
            raise ReviewImportError(f"Could not read the CSV file: {exc}") from exc
    if df is None or df.empty:
        raise ReviewImportError("The CSV file has no rows.")
    mapping = _detect_columns(list(df.columns))
    if not {"pros", "cons", "text", "title"} & mapping.keys():
        raise ReviewImportError(
            "No review text column found. Name your columns e.g. Pros / Cons, Likes / Dislikes, "
            "or Review — see the sample CSVs.")
    rows = [{f: row.get(col) for f, col in mapping.items()} for row in df.to_dict("records")]
    reviews = _finish(rows)
    return reviews, mapping, len(df) - len(reviews)


def parse_text(text: str) -> tuple[list[dict], int]:
    """Pasted reviews: one review per block, blocks separated by a blank line.

    Lines such as "Pros: ...", "Likes: ...", "Cons: ...", "Dislikes: ...",
    "Rating: 4", "Title: ..." are recognised; other lines become review text.
    """
    blocks = [b for b in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if b.strip()]
    raw = []
    for block in blocks:
        r: dict[str, str] = {}
        current = "text"
        for line in block.split("\n"):
            m = _KEY_LINE.match(line)
            if m:
                key = m.group(1).lower()
                current = ("pros" if key.startswith(("pro", "like", "what i like")) else
                           "cons" if key.startswith(("con", "dislike", "what i dislike")) else
                           "role" if key in {"role", "job title", "designation"} else key)
                r[current] = (r.get(current, "") + " " + m.group(2)).strip()
                if current in {"rating", "title", "role", "date"}:
                    current = "text"
            elif line.strip():
                if "rating" not in r and parse_rating(line) is not None and len(line.strip()) <= 12:
                    r["rating"] = line
                else:
                    r[current] = (r.get(current, "") + " " + line.strip()).strip()
        raw.append(r)
    reviews = _finish(raw)
    return reviews, len(blocks) - len(reviews)


# ----------------------------------------------------------------- analysis
def rating_bucket(r: float | None) -> str | None:
    if r is None:
        return None
    return "negative" if r < 2.5 else "neutral" if r < 3.5 else "positive"


def _overall_text(r: dict) -> str:
    parts = [r.get("title"), r.get("text")]
    if r.get("pros"):
        parts.append(f"Pros: {r['pros']}")
    if r.get("cons"):
        parts.append(f"Cons: {r['cons']}")
    return ". ".join(p for p in parts if p)[:MAX_FIELD]


def _themes(texts: list[str], n: int = 12) -> list[tuple[str, int]]:
    """Most common words and two-word phrases (by number of reviews)."""
    uni, bi = Counter(), Counter()
    for t in texts:
        t = _WLB.sub("work-life balance", t.lower())
        toks = [w.strip("'-") for w in _TOKEN.findall(t)]
        toks = [w for w in toks if len(w) > 2 or w in {"hr", "pf", "wfh", "ai"}]
        content = [w for w in toks if w not in _STOP]
        uni.update(set(content))
        bi.update({f"{a} {b}" for a, b in zip(toks, toks[1:]) if a not in _STOP and b not in _STOP})
    phrases = [(p, c) for p, c in bi.most_common(40) if c >= 2]
    chosen: list[tuple[str, int]] = phrases[: n // 2]
    covered = {w for p, _ in chosen for w in p.split()}
    for w, c in uni.most_common(60):
        if len(chosen) >= n or c < 2:
            break
        if w in covered and c <= 1.3 * max(cc for p, cc in chosen if w in p.split()):
            continue
        chosen.append((w, c))
    return sorted(chosen, key=lambda x: -x[1])[:n]


def analyse_reviews(reviews: list[dict]) -> dict:
    reviews = reviews[:MAX_REVIEWS]
    overall = model.predict_many([_overall_text(r) for r in reviews]) if reviews else []
    pros_idx = [i for i, r in enumerate(reviews) if r.get("pros")]
    cons_idx = [i for i, r in enumerate(reviews) if r.get("cons")]
    pros_pred = dict(zip(pros_idx, model.predict_many([reviews[i]["pros"] for i in pros_idx]))) if pros_idx else {}
    cons_pred = dict(zip(cons_idx, model.predict_many([reviews[i]["cons"] for i in cons_idx]))) if cons_idx else {}

    out = []
    for i, (r, p) in enumerate(zip(reviews, overall)):
        item = {**r, "label": p.label, "confidence": round(p.confidence, 4),
                "probabilities": {k: round(v, 4) for k, v in p.probabilities.items()},
                "rating_label": rating_bucket(r.get("rating"))}
        if i in pros_pred:
            item["pros_label"], item["pros_confidence"] = pros_pred[i].label, round(pros_pred[i].confidence, 4)
        if i in cons_pred:
            item["cons_label"], item["cons_confidence"] = cons_pred[i].label, round(cons_pred[i].confidence, 4)
        out.append(item)

    n = len(out)
    counts = {lbl: sum(r["label"] == lbl for r in out) for lbl in LABELS}
    rated = [r for r in out if r.get("rating") is not None]
    ratings = Counter(int(round(r["rating"])) for r in rated)
    agree = sum(r["label"] == r["rating_label"] for r in rated)
    matrix = {rb: {pl: sum(1 for r in rated if r["rating_label"] == rb and r["label"] == pl) for pl in LABELS} for rb in LABELS}

    platforms = {}
    for r in out:
        pf = r.get("platform") or "other"
        d = platforms.setdefault(pf, {"name": PLATFORMS.get(pf, pf), "total": 0, "counts": dict.fromkeys(LABELS, 0), "rating_sum": 0.0, "rated": 0})
        d["total"] += 1
        d["counts"][r["label"]] += 1
        if r.get("rating") is not None:
            d["rating_sum"] += r["rating"]
            d["rated"] += 1
    for d in platforms.values():
        d["avg_rating"] = round(d.pop("rating_sum") / d["rated"], 2) if d["rated"] else None
        d["net_score"] = round((d["counts"]["positive"] - d["counts"]["negative"]) / d["total"] * 100)

    pros_texts = [r["pros"] for r in out if r.get("pros")]
    cons_texts = [r["cons"] for r in out if r.get("cons")]
    has_split = bool(pros_texts or cons_texts)
    if has_split:
        themes = {"positive": _themes(pros_texts), "negative": _themes(cons_texts), "source": "pros_cons"}
    else:
        themes = {"positive": _themes([_overall_text(r) for r in out if r["label"] == "positive"]),
                  "negative": _themes([_overall_text(r) for r in out if r["label"] == "negative"]), "source": "sentiment"}

    summary = {
        "total": n,
        "counts": counts,
        "net_score": round((counts["positive"] - counts["negative"]) / n * 100) if n else 0,
        "avg_confidence": round(sum(r["confidence"] for r in out) / n, 4) if n else None,
        "avg_rating": round(sum(r["rating"] for r in rated) / len(rated), 2) if rated else None,
        "rated": len(rated),
        "rating_distribution": {str(k): ratings.get(k, 0) for k in range(1, 6)},
        "rating_agreement": round(agree / len(rated), 4) if rated else None,
        "rating_matrix": matrix,
        "pros_positive_share": round(sum(p.label == "positive" for p in pros_pred.values()) / len(pros_pred), 4) if pros_pred else None,
        "cons_negative_share": round(sum(p.label == "negative" for p in cons_pred.values()) / len(cons_pred), 4) if cons_pred else None,
        "pros_count": len(pros_pred),
        "cons_count": len(cons_pred),
        "by_platform": platforms,
        "themes": themes,
    }
    return {"reviews": out, "summary": summary}
