"""Deployment entrypoint.

Vercel (and other ASGI hosts) look for a top-level `app` object in app.py.
The application itself lives in sentiment/api.py.
"""

from sentiment.api import app  # noqa: F401
