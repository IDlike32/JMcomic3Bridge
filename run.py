"""Entry point: python -m jmbridge_app  (or python run.py)"""
from __future__ import annotations

import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    import uvicorn

    host = os.environ.get("JMBRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("JMBRIDGE_PORT", "8902"))
    uvicorn.run("service:app", host=host, port=port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
