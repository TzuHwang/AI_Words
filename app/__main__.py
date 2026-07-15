"""Launch the AI Words server and open the editor in the default browser.

Run with:  python -m app        (or use the top-level run.py)
"""

from __future__ import annotations

import argparse
import threading
import webbrowser
from pathlib import Path

import uvicorn

APP_DIR = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Words — ODT editor with an AI assistant.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser.")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Auto-reload the server when source files change (development).",
    )
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    print(f"AI Words running at {url}  (Ctrl+C to stop)")
    uvicorn.run(
        "app.server:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=args.reload,
        reload_dirs=[str(APP_DIR)] if args.reload else None,
    )


if __name__ == "__main__":
    main()
