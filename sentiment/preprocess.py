"""Text normalisation shared by training and inference.

The same function is used in both places so the model always sees text in the
exact form it was trained on.
"""

from __future__ import annotations

import html
import re

LABELS: tuple[str, ...] = ("negative", "neutral", "positive")

_URL = re.compile(r"https?://\S+|www\.\S+")
_MENTION = re.compile(r"@\w+")
_HASHTAG = re.compile(r"#(\w+)")
_REPEAT = re.compile(r"(\w)\1{2,}")          # "sooooo" -> "soo"
_PUNCT_RUN = re.compile(r"([!?])\1+")          # "!!!" -> "!"
_WS = re.compile(r"\s+")

# Emoticons carry a lot of sentiment in short texts; map them to word tokens
# so the vectoriser can learn them.
_EMOTICONS = [
    (re.compile(r"(?::|;|=)-?(?:\)|\]|d\b|p\b)|<3|\(\s?:"), " emopos "),
    (re.compile(r"(?::|=)'?-?(?:\(|\[|/|\\(?!\w))|\):"), " emoneg "),
]

_CONTRACTIONS = [
    (re.compile(r"\bwon't\b"), "will not"),
    (re.compile(r"\bcan't\b"), "can not"),
    (re.compile(r"\bain't\b"), "is not"),
    (re.compile(r"n't\b"), " not"),
    (re.compile(r"'re\b"), " are"),
    (re.compile(r"'ve\b"), " have"),
    (re.compile(r"'ll\b"), " will"),
    (re.compile(r"'m\b"), " am"),
    (re.compile(r"'d\b"), " would"),
]

# Token pattern used by the word vectoriser: words plus "!" and "?" which are
# useful intensity cues.
TOKEN_PATTERN = r"(?u)\b\w+\b|[!?]"


def clean_text(text: object) -> str:
    """Normalise raw user / tweet text into model-ready form."""
    if text is None:
        return ""
    s = html.unescape(str(text))
    s = s.replace("’", "'").replace("‘", "'")
    s = _URL.sub(" url ", s)
    s = _MENTION.sub(" ", s)
    s = _HASHTAG.sub(r" \1 ", s)
    s = s.lower()
    for pattern, repl in _EMOTICONS:
        s = pattern.sub(repl, s)
    for pattern, repl in _CONTRACTIONS:
        s = pattern.sub(repl, s)
    s = _REPEAT.sub(r"\1\1", s)
    s = _PUNCT_RUN.sub(r"\1", s)
    s = _WS.sub(" ", s).strip()
    return s
