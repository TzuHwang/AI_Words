"""Shared pytest fixtures.

Every test that touches persistent state (config, skills) is redirected to a
temporary directory, and the ODT<->HTML converter is pinned to its pure-Python
path so the suite is hermetic: no real config file, no installed LibreOffice,
and no network calls to a local Ollama.
"""

from __future__ import annotations

import pytest

from app import config, converter, skills


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    """Point config storage at a temp file and stub out Ollama discovery."""
    path = tmp_path / "config.json"
    monkeypatch.setattr(config, "CONFIG_PATH", path)
    monkeypatch.setattr(config, "discover_ollama_models", lambda *a, **k: [])
    return path


@pytest.fixture
def tmp_skills(tmp_path, monkeypatch):
    """Point the skills directory at a temp folder."""
    d = tmp_path / "skills"
    monkeypatch.setattr(skills, "SKILLS_DIR", d)
    return d


@pytest.fixture
def pure_converter(monkeypatch):
    """Force the dependency-free ODT<->HTML path (ignore any installed soffice)."""
    monkeypatch.setattr(converter, "find_soffice", lambda: None)
