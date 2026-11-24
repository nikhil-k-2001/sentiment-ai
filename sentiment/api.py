"""FastAPI application: JSON API under /api and the static web UI at /."""

from __future__ import annotations

import io
import time
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .model import MAX_TEXT_CHARS, ModelNotReadyError, model, summarise
from .monitor import analyse_brand
from .preprocess import LABELS
from .reviews import MAX_REVIEWS, PLATFORMS, ReviewImportError, analyse_reviews, parse_csv, parse_text
from .sources import SOURCES

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"

# Vercel rejects request bodies over 4.5 MB, so stay safely below that.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024
MAX_BATCH_ROWS = 5000
TEXT_COLUMN_HINTS = (
    "text", "review", "reviews", "review_text", "comment", "comments", "feedback",
    "content", "tweet", "message", "body", "sentence", "description",
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load the model once at startup so the first request is fast.
    if model.ready:
        model.predict_many(["warm up"])
    yield


app = FastAPI(title="SentimentAI", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def _revalidate_static(request, call_next):
    # The UI is plain ES modules; make browsers re-check them (cheap 304s via
    # ETag) so an updated app never runs with stale cached modules.
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(ModelNotReadyError)
async def _model_missing(_, exc: ModelNotReadyError):
    return JSONResponse(status_code=503, content={"detail": str(exc), "code": "model_not_ready"})


class AnalyzeRequest(BaseModel):
    text: str = Field(..., description="Text to analyse")


class MonitorRequest(BaseModel):
    query: str = Field(..., description="Brand, product or keyword to track")
    sources: list[str] | None = Field(None, description="Subset of /api/sources keys; default all")
    limit: int = Field(50, ge=10, le=100, description="Max mentions per source")


# ------------------------------------------------------------------ routes
@app.get("/api/health")
def health():
    return {"status": "ok", "model_ready": model.ready}


@app.get("/api/model")
def model_info():
    return model.metrics


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(422, "Please enter some text to analyse.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(422, f"Text is too long ({len(text)} characters). The limit is {MAX_TEXT_CHARS}.")
    if not any(ch.isalpha() for ch in text):
        raise HTTPException(422, "The text needs at least some words for the model to analyse.")

    t0 = time.perf_counter()
    pred = model.predict_many([text])[0]
    keywords = model.explain(text, pred)
    latency = (time.perf_counter() - t0) * 1000
    return {
        "text": text,
        "label": pred.label,
        "confidence": pred.confidence,
        "probabilities": pred.probabilities,
        "keywords": keywords,
        "summary": summarise(pred, keywords, text),
        "latency_ms": round(latency, 1),
        "model": model.metrics["model"]["name"],
    }


def _pick_column(df: pd.DataFrame, requested: str | None) -> str:
    if requested:
        if requested not in df.columns:
            raise HTTPException(422, f"Column “{requested}” was not found in the file.")
        return requested
    lower = {str(c).strip().lower(): c for c in df.columns}
    for hint in TEXT_COLUMN_HINTS:
        if hint in lower:
            return lower[hint]
    text_cols = [c for c in df.columns if df[c].dtype == object]
    if not text_cols:
        raise HTTPException(422, "No text column found. Make sure the CSV has a column of text.")
    return max(text_cols, key=lambda c: df[c].astype(str).str.len().mean())


@app.post("/api/batch")
async def batch(file: UploadFile = File(...), column: str | None = Form(None)):
    name = (file.filename or "").lower()
    if not name.endswith((".csv", ".txt")):
        raise HTTPException(422, "Please upload a .csv file.")
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is larger than 4 MB.")
    if not raw.strip():
        raise HTTPException(422, "The uploaded file is empty.")

    df = None
    for enc in ("utf-8-sig", "latin-1"):
        try:
            df = pd.read_csv(io.BytesIO(raw), encoding=enc, dtype=str, keep_default_na=False,
                             on_bad_lines="skip", engine="python")
            break
        except UnicodeDecodeError:
            continue
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(422, f"Could not parse the CSV file: {exc}") from exc
    if df is None or df.empty or len(df.columns) == 0:
        raise HTTPException(422, "The CSV file has no rows.")

    col = _pick_column(df, column)
    texts = df[col].astype(str).str.strip()
    total_rows = len(texts)
    truncated = total_rows > MAX_BATCH_ROWS
    texts = texts.iloc[:MAX_BATCH_ROWS]

    valid_mask = texts.map(lambda t: bool(t) and any(ch.isalpha() for ch in t))
    valid = texts[valid_mask]
    preds = model.predict_many([t[:MAX_TEXT_CHARS] for t in valid.tolist()])

    rows = []
    for (idx, text), pred in zip(valid.items(), preds):
        rows.append({
            "row": int(idx) + 1, "text": text, "label": pred.label,
            "confidence": round(pred.confidence, 4),
            "probabilities": {k: round(v, 4) for k, v in pred.probabilities.items()},
        })
    counts = {lbl: sum(r["label"] == lbl for r in rows) for lbl in LABELS}
    return {
        "filename": file.filename,
        "columns": [str(c) for c in df.columns],
        "column_used": str(col),
        "rows": rows,
        "summary": {
            "analyzed": len(rows),
            "skipped": int((~valid_mask).sum()),
            "total_rows": total_rows,
            "truncated": truncated,
            "max_rows": MAX_BATCH_ROWS,
            "counts": counts,
            "avg_confidence": round(sum(r["confidence"] for r in rows) / len(rows), 4) if rows else None,
        },
    }


@app.get("/api/sources")
def sources():
    return [{"key": k, **v} for k, v in SOURCES.items()]


@app.post("/api/monitor")
def monitor(req: MonitorRequest):
    query = " ".join(req.query.split())
    if len(query) < 2 or not any(ch.isalpha() for ch in query):
        raise HTTPException(422, "Enter a brand, product or keyword (at least 2 characters).")
    if len(query) > 60:
        raise HTTPException(422, "Keep the search term under 60 characters.")
    chosen = req.sources or list(SOURCES)
    unknown = [s for s in chosen if s not in SOURCES]
    if unknown:
        raise HTTPException(422, f"Unknown source(s): {', '.join(unknown)}")
    if not model.ready:
        raise ModelNotReadyError("No trained model found. Run `python scripts/train.py` first.")
    result = analyse_brand(query, list(dict.fromkeys(chosen)), req.limit)
    if not any(s["ok"] for s in result["sources"]):
        errors = "; ".join(f"{s['name']}: {s['error']}" for s in result["sources"])
        raise HTTPException(502, f"Couldn't reach any source ({errors}). Check your internet connection.")
    return result


# ------------------------------------------------------------ reviews
class ReviewIn(BaseModel):
    id: str | None = None
    import_id: str | None = None
    platform: str = "other"
    title: str = ""
    text: str = ""
    pros: str = ""
    cons: str = ""
    rating: float | None = Field(None, ge=1, le=5)
    date: str | None = None
    role: str = ""
    location: str = ""
    status: str = ""


class ReviewsRequest(BaseModel):
    reviews: list[ReviewIn] = Field(..., max_length=MAX_REVIEWS)


@app.post("/api/reviews/parse")
async def reviews_parse(platform: str = Form("other"), file: UploadFile | None = File(None), text: str | None = Form(None)):
    """Turn an uploaded CSV or pasted text into normalised reviews (no ML yet)."""
    if platform not in PLATFORMS:
        raise HTTPException(422, f"Unknown platform. Use one of: {', '.join(PLATFORMS)}")
    try:
        if file is not None and file.filename:
            if not file.filename.lower().endswith((".csv", ".txt")):
                raise HTTPException(422, "Please upload a .csv file.")
            raw = await file.read(MAX_UPLOAD_BYTES + 1)
            if len(raw) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File is larger than 4 MB.")
            if not raw.strip():
                raise HTTPException(422, "The uploaded file is empty.")
            reviews, mapping, skipped = parse_csv(raw)
        elif text and text.strip():
            if len(text) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "Pasted text is too long (4 MB max).")
            reviews, skipped = parse_text(text)
            mapping = None
        else:
            raise HTTPException(422, "Upload a CSV file or paste some reviews.")
    except ReviewImportError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not reviews:
        raise HTTPException(422, "No reviews with text were found.")
    truncated = len(reviews) > MAX_REVIEWS
    for r in reviews:
        r["platform"] = platform
    return {"platform": platform, "reviews": reviews[:MAX_REVIEWS], "mapping": mapping,
            "skipped": skipped, "truncated": truncated, "max_reviews": MAX_REVIEWS}


@app.post("/api/reviews/analyze")
def reviews_analyze(req: ReviewsRequest):
    if not req.reviews:
        raise HTTPException(422, "No reviews to analyse.")
    if not model.ready:
        raise ModelNotReadyError("No trained model found. Run `python scripts/train.py` first.")
    data = [r.model_dump() for r in req.reviews]
    for r in data:
        if r["platform"] not in PLATFORMS:
            r["platform"] = "other"
    return analyse_reviews(data)


# --------------------------------------------------------------- frontend
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html")
