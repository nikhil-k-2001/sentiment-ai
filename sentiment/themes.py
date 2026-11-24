"""Find words and short phrases that characterise a group of texts.

Used to answer "what are people complaining about?" and "what do people
like?". A term is reported only when it is clearly *over-represented* in the
group compared with the remaining texts, so generic words shared by every
text (the product name, the category) drop out.

This is frequency analysis, not topic modelling: it surfaces recurring
wording that a person should then read in context.
"""

from __future__ import annotations

import re
from collections import Counter

STOPWORDS = frozenset("""
a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for
from further get gets got had hadn't has hasn't have haven't having he her here hers herself him himself his how
i if in into is isn't it it's its itself just let's like me more most much my myself no nor not now of off on once
only or other ought our ours ourselves out over own really same she should shouldn't so some such than that that's
the their theirs them themselves then there there's these they they're this those through to too under until up us
very was wasn't we were weren't what when where which while who whom why will with won't would wouldn't you your
yours yourself yourselves one two new via still even back way well make made says said say going go see know
think want need people time year years day days today week thing things lot lots url http https www com amp im
ive dont cant can't won't use used using i'm i've you're we're they're isn't wasn't also etc per every many able got really much always never yet ever since though
""".split())

_TOKEN = re.compile(r"[a-z][a-z'&-]*[a-z]|[a-z]")
_WLB = re.compile(r"\bwork[\s-]*life[\s-]*balance\b")
# @handles and links are addressing, not content ("@united" isn't a complaint).
_NOISE = re.compile(r"@\w+|https?://\S+|www\.\S+")
_KEEP_SHORT = {"hr", "ui", "ux", "ai", "pf", "wfh", "app", "bug", "ads", "tv"}


def _terms(text: str, skip: set[str]) -> set[str]:
    t = _WLB.sub("work-life balance", _NOISE.sub(" ", text.lower()))
    toks = [w.strip("'-") for w in _TOKEN.findall(t)]
    toks = [w for w in toks if len(w) > 2 or w in _KEEP_SHORT]
    out = {w for w in toks if w not in STOPWORDS and w not in skip}
    out |= {f"{a} {b}" for a, b in zip(toks, toks[1:])
            if a not in STOPWORDS and b not in STOPWORDS and a not in skip and b not in skip and a != b}
    return out


def distinctive_terms(group: list[str], rest: list[str], n: int = 10, skip: set[str] | None = None,
                      min_lift: float = 0.02) -> list[tuple[str, int]]:
    """Return up to n (term, count) pairs over-represented in `group`.

    count = number of texts in `group` containing the term.
    """
    skip = {s.lower() for s in (skip or set())}
    if not group:
        return []
    g = Counter(t for doc in group for t in _terms(doc, skip))
    r = Counter(t for doc in rest for t in _terms(doc, skip))
    min_count = max(2, round(0.02 * len(group)))
    scored = []
    for term, c in g.items():
        if c < min_count:
            continue
        lift = c / len(group) - (r[term] / len(rest) if rest else 0.0)
        if lift >= min_lift:
            # Prefer phrases a little: "customer support" says more than "support".
            scored.append((lift * (1.25 if " " in term else 1.0), term, c))
    scored.sort(reverse=True)
    chosen: list[tuple[str, int]] = []
    for _, term, c in scored:
        words = term.split()
        # Skip a single word already covered by a chosen phrase with a similar count,
        # and a phrase whose words are both covered by chosen single words.
        if len(words) == 1 and any(term in p.split() and c <= cp * 1.3 for p, cp in chosen):
            continue
        if len(words) == 2 and all(any(w == p for p, _ in chosen) for w in words):
            continue
        # Treat simple plural/singular variants as one term ("thank"/"thanks", "hour"/"hours").
        if any(term == p + "s" or p == term + "s" for p, _ in chosen):
            continue
        chosen.append((term, c))
        if len(chosen) >= n:
            break
    return chosen
