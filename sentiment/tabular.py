"""Robust CSV reading shared by batch analysis and review import.

Handles the files people actually export from spreadsheets and survey tools:
UTF-8 (with or without BOM), UTF-16, Windows-1252/Latin-1, and comma,
semicolon, tab or pipe delimiters. Every cell is returned as a string, so
downstream code never meets NaN/float values.
"""

from __future__ import annotations

import csv
import io

import pandas as pd


class TableError(ValueError):
    """A user-facing problem with an uploaded file."""


def _decode(raw: bytes) -> str:
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise TableError("Could not read the file's text encoding. Save it as UTF-8 CSV and try again.")


def _delimiter(text: str) -> str:
    sample = text[:8192]
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        first = sample.split("\n", 1)[0]
        counts = {d: first.count(d) for d in ",;\t|"}
        best = max(counts, key=counts.get)
        return best if counts[best] else ","


def read_csv_bytes(raw: bytes) -> pd.DataFrame:
    if not raw.strip():
        raise TableError("The uploaded file is empty.")
    text = _decode(raw)
    if "\x00" in text:
        raise TableError("This doesn't look like a text CSV file. Export it as CSV (UTF-8) and try again.")
    first_line = text.lstrip("\ufeff").split("\n", 1)[0]
    # A one-column file (no delimiter in the header): treat each line as one
    # value so unquoted commas inside the text don't split it into fields.
    sep = "\x1f" if not any(d in first_line for d in ",;\t|") else _delimiter(text)
    try:
        df = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, keep_default_na=False,
                         on_bad_lines="skip", engine="python", index_col=False)
    except Exception as exc:  # noqa: BLE001 - pandas raises many error types
        hint = " It may contain an unclosed quote (\")." if text.count('"') % 2 else ""
        raise TableError(f"Could not parse the CSV file.{hint}") from exc
    df.columns = [str(c).strip() or f"column_{i + 1}" for i, c in enumerate(df.columns)]
    df = df.fillna("").astype(str)
    if df.empty:
        hint = " It may contain an unclosed quote (\")." if text.count('"') % 2 else " It may only contain a header row."
        raise TableError(f"The CSV file has no data rows.{hint}")
    return df


def has_letters(s: str) -> bool:
    return any(ch.isalpha() for ch in s)
