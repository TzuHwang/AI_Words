"""Tests for app.__main__ — CLI argument handling and server launch."""

from __future__ import annotations

import sys

from app import __main__ as entry


def test_main_launches_uvicorn_with_args(monkeypatch):
    captured = {}

    def fake_run(app_path, **kwargs):
        captured["app"] = app_path
        captured.update(kwargs)

    monkeypatch.setattr(entry.uvicorn, "run", fake_run)
    monkeypatch.setattr(sys, "argv",
                        ["ai-words", "--no-browser", "--host", "0.0.0.0", "--port", "9000"])

    entry.main()

    assert captured["app"] == "app.server:app"
    assert captured["host"] == "0.0.0.0"
    assert captured["port"] == 9000


def test_main_no_browser_skips_webbrowser(monkeypatch):
    opened = []
    monkeypatch.setattr(entry.uvicorn, "run", lambda *a, **k: None)
    monkeypatch.setattr(entry.webbrowser, "open", lambda url: opened.append(url))
    monkeypatch.setattr(sys, "argv", ["ai-words", "--no-browser"])

    entry.main()

    assert opened == []  # browser must not be opened when --no-browser is set
