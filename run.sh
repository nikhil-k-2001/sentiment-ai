#!/usr/bin/env bash
# One-command setup & launch for SentimentAI.
#   ./run.sh            -> create venv, install deps, fetch data, train (if needed), start server
#   PORT=9000 ./run.sh  -> prefer a different port (a busy port is skipped automatically)
#   NO_BROWSER=1 ./run.sh -> do not open the browser
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"

if [ ! -d .venv ]; then
  echo "▸ Creating virtual environment (.venv)"
  if command -v uv >/dev/null 2>&1; then uv venv --python 3.12 .venv -q; else python3 -m venv .venv; fi
fi
PY=.venv/bin/python
if ! "$PY" -c "import fastapi, sklearn, pandas, multipart" >/dev/null 2>&1; then
  echo "▸ Installing dependencies"
  if command -v uv >/dev/null 2>&1; then uv pip install -q --python "$PY" -r requirements.txt; else "$PY" -m pip install -q -r requirements.txt; fi
fi
if [ ! -f models/sentiment_model.joblib ] || [ ! -f models/metrics.json ]; then
  echo "▸ No trained model found — downloading data and training"
  "$PY" scripts/download_data.py
  "$PY" scripts/train.py
fi
# If the port is taken by another app, use the next free one.
port_busy() { "$PY" -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', $1))==0 else 1)"; }
START_PORT="$PORT"
while port_busy "$PORT"; do PORT=$((PORT + 1)); done
if [ "$PORT" != "$START_PORT" ]; then
  echo "▸ Port ${START_PORT} is used by another program — using ${PORT} instead"
fi

URL="http://localhost:${PORT}"
echo ""
echo "  ✅ SentimentAI is starting at  ${URL}"
echo "     Keep this window open. Press Ctrl+C to stop."
echo ""
# Open the browser once the server answers (macOS `open`, Linux `xdg-open`).
if [ -z "${NO_BROWSER:-}" ]; then
  (for _ in $(seq 1 30); do
     if curl -sf "${URL}/api/health" >/dev/null 2>&1; then
       (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true
       break
     fi
     sleep 0.5
   done) &
fi
exec "$PY" -m uvicorn sentiment.api:app --host 127.0.0.1 --port "$PORT"
