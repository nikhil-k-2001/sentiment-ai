"""Fetch public mentions of a brand/keyword from free, key-less sources.

Every fetcher returns a list of `Mention` dicts with the same shape so the rest
of the pipeline doesn't care where a mention came from. Results are cached in
memory for a few minutes to stay well inside each service's rate limits.

Sources
-------
bluesky   Bluesky public search API (social posts)
hn        Hacker News via the Algolia search API (stories + comments)
news      Google News RSS search (headlines)
lemmy     Lemmy (federated Reddit-style forums) public search
mastodon  Mastodon public hashtag timeline

Reddit, X/Twitter and App Store reviews are intentionally absent: Reddit needs
an authenticated API app, X needs a paid plan, and Apple's public review feed
no longer returns reviews.
"""

from __future__ import annotations

import html
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

USER_AGENT = "SentimentAI/1.0 (open-source brand monitoring demo)"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
CACHE_TTL = 600  # seconds

SOURCES: dict[str, dict] = {
    "bluesky": {"name": "Bluesky", "kind": "Social posts"},
    "hn": {"name": "Hacker News", "kind": "Tech discussions"},
    "news": {"name": "Google News", "kind": "News headlines"},
    "lemmy": {"name": "Lemmy", "kind": "Forum threads"},
    "mastodon": {"name": "Mastodon", "kind": "Social posts (hashtag)"},
}

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
_cache: dict[tuple, tuple[float, list[dict]]] = {}
_cache_lock = threading.Lock()


class SourceError(RuntimeError):
    pass


# ----------------------------------------------------------------- helpers
def _clean(s: str | None) -> str:
    if not s:
        return ""
    s = _TAG.sub(" ", s.replace("<p>", "\n"))
    return _WS.sub(" ", html.unescape(s)).strip()


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _mentions_query(text: str, query: str) -> bool:
    """Keep only items that literally contain every word of the query."""
    t = text.lower()
    return all(w in t for w in query.lower().split())


def _get(client: httpx.Client, url: str, **params) -> httpx.Response:
    r = client.get(url, params=params or None)
    if r.status_code == 429:
        raise SourceError("rate limited — try again in a minute")
    if r.status_code >= 400:
        raise SourceError(f"HTTP {r.status_code}")
    return r


# ---------------------------------------------------------------- fetchers
def fetch_bluesky(client: httpx.Client, query: str, limit: int) -> list[dict]:
    r = _get(client, "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
             q=query, limit=min(limit, 100), sort="latest", lang="en")
    out = []
    for p in r.json().get("posts", []):
        rec = p.get("record", {})
        text = _clean(rec.get("text"))
        if not text or not _mentions_query(text, query):
            continue
        handle = p.get("author", {}).get("handle", "")
        rkey = p.get("uri", "").rsplit("/", 1)[-1]
        out.append({
            "id": f"bsky:{p.get('cid')}",
            "source": "bluesky",
            "title": None,
            "text": text,
            "url": f"https://bsky.app/profile/{handle}/post/{rkey}" if handle and rkey else None,
            "author": p.get("author", {}).get("displayName") or handle,
            "published_at": rec.get("createdAt") or p.get("indexedAt"),
            "engagement": sum(int(p.get(k) or 0) for k in ("likeCount", "repostCount", "replyCount", "quoteCount")),
        })
    return out


def fetch_hn(client: httpx.Client, query: str, limit: int) -> list[dict]:
    r = _get(client, "https://hn.algolia.com/api/v1/search_by_date",
             query=query, tags="(story,comment)", hitsPerPage=min(limit, 100))
    out = []
    for h in r.json().get("hits", []):
        is_story = "story" in (h.get("_tags") or []) and h.get("title")
        title = _clean(h.get("title")) if is_story else None
        body = _clean(h.get("story_text") if is_story else h.get("comment_text"))
        text = " ".join(x for x in (title, body) if x)
        if not text or not _mentions_query(text, query):
            continue
        out.append({
            "id": f"hn:{h['objectID']}",
            "source": "hn",
            "title": title,
            "text": text,
            "url": f"https://news.ycombinator.com/item?id={h['objectID']}",
            "author": h.get("author"),
            "published_at": _iso(datetime.fromtimestamp(h["created_at_i"], tz=timezone.utc)),
            "engagement": int(h.get("points") or 0) + int(h.get("num_comments") or 0),
        })
    return out


def fetch_news(client: httpx.Client, query: str, limit: int) -> list[dict]:
    r = _get(client, "https://news.google.com/rss/search",
             q=query, hl="en-US", gl="US", ceid="US:en")
    root = ET.fromstring(r.content)
    out = []
    for item in root.iter("item"):
        title = _clean(item.findtext("title"))
        publisher = _clean(item.findtext("source"))
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3]
        if not title or not _mentions_query(title, query):
            continue
        try:
            published = _iso(parsedate_to_datetime(item.findtext("pubDate") or ""))
        except (TypeError, ValueError):
            published = None
        out.append({
            "id": f"news:{item.findtext('guid') or item.findtext('link')}",
            "source": "news",
            "title": None,
            "text": title,
            "url": item.findtext("link"),
            "author": publisher or None,
            "published_at": published,
            "engagement": 0,
        })
        if len(out) >= limit:
            break
    return out


def fetch_lemmy(client: httpx.Client, query: str, limit: int) -> list[dict]:
    """Lemmy (federated, Reddit-style forums) via lemmy.world's public search."""
    out = []
    per_type = max(5, min(50, limit // 2))
    for kind in ("Posts", "Comments"):
        r = _get(client, "https://lemmy.world/api/v3/search", q=query, type_=kind, sort="New", limit=per_type)
        data = r.json()
        for item in data.get("posts" if kind == "Posts" else "comments", []):
            if kind == "Posts":
                p = item["post"]
                title = _clean(p.get("name"))
                text = " ".join(x for x in (title, _clean(p.get("body"))[:600]) if x)
                url, published = p.get("ap_id"), p.get("published")
            else:
                c = item["comment"]
                title, text = None, _clean(c.get("content"))
                url, published = c.get("ap_id"), c.get("published")
            if not text or not _mentions_query(text, query):
                continue
            out.append({
                "id": f"lemmy:{url}",
                "source": "lemmy",
                "title": title,
                "text": text,
                "url": url,
                "author": item.get("creator", {}).get("name"),
                "published_at": published,
                "engagement": max(0, int(item.get("counts", {}).get("score") or 0)),
            })
    return out[:limit]


def fetch_mastodon(client: httpx.Client, query: str, limit: int) -> list[dict]:
    """Mastodon public hashtag timeline (mastodon.social sees the wider fediverse)."""
    tag = re.sub(r"[^0-9A-Za-z_]", "", query)
    if not tag:
        return []
    r = _get(client, f"https://mastodon.social/api/v1/timelines/tag/{tag}", limit=min(limit, 40))
    out = []
    for st in r.json():
        if st.get("language") not in (None, "en"):
            continue
        text = _clean(st.get("content"))
        if not text or not _mentions_query(text, query):
            continue
        out.append({
            "id": f"mastodon:{st.get('uri')}",
            "source": "mastodon",
            "title": None,
            "text": text,
            "url": st.get("url") or st.get("uri"),
            "author": st.get("account", {}).get("display_name") or st.get("account", {}).get("acct"),
            "published_at": st.get("created_at"),
            "engagement": sum(int(st.get(k) or 0) for k in ("favourites_count", "reblogs_count", "replies_count")),
        })
    return out


FETCHERS = {"bluesky": fetch_bluesky, "mastodon": fetch_mastodon, "lemmy": fetch_lemmy, "hn": fetch_hn, "news": fetch_news}


# ------------------------------------------------------------------ public
def _fetch_one(source: str, query: str, limit: int) -> tuple[str, list[dict] | None, str | None, bool]:
    key = (source, query.lower(), limit)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return source, hit[1], None, True
    try:
        with httpx.Client(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
            items = FETCHERS[source](client, query, limit)
    except SourceError as exc:
        return source, None, str(exc), False
    except httpx.TimeoutException:
        return source, None, "timed out", False
    except httpx.HTTPError as exc:
        return source, None, f"network error ({type(exc).__name__})", False
    except (ValueError, KeyError, ET.ParseError):
        return source, None, "unexpected response format", False
    with _cache_lock:
        _cache[key] = (now, items)
    return source, items, None, False


def fetch_mentions(query: str, sources: list[str], limit: int) -> tuple[list[dict], list[dict]]:
    """Fetch from all sources in parallel. Returns (mentions, per-source status)."""
    with ThreadPoolExecutor(max_workers=len(sources) or 1) as pool:
        results = list(pool.map(lambda s: _fetch_one(s, query, limit), sources))
    mentions, status, seen = [], [], set()
    for source, items, error, cached in results:
        status.append({"source": source, "name": SOURCES[source]["name"], "ok": error is None,
                       "count": len(items or []), "error": error, "cached": cached})
        for m in items or []:
            key = m["id"] if m["source"] != "news" else m["text"].lower()
            if key in seen:
                continue
            seen.add(key)
            mentions.append(m)
    return mentions, status
