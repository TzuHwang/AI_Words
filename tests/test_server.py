"""Tests for app.server — FastAPI endpoints via TestClient.

Config and skills are isolated to temp dirs and the converter runs pure-Python,
so these hit the real request/response path without external state or network.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import ai, converter
from app.server import app


@pytest.fixture
def client(tmp_config, tmp_skills, pure_converter):
    return TestClient(app)


# -- pages ------------------------------------------------------------------
def test_index(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "AI Words" in r.text


# -- models -----------------------------------------------------------------
def test_get_models(client):
    data = client.get("/api/models").json()
    assert data["active"] in {m["id"] for m in data["models"]}
    assert len(data["models"]) >= 1


def test_set_active_model(client):
    assert client.post("/api/models/active", json={"id": "claude-haiku"}).status_code == 200
    assert client.get("/api/models").json()["active"] == "claude-haiku"


def test_set_active_model_unknown(client):
    assert client.post("/api/models/active", json={"id": "ghost"}).status_code == 404


def test_add_model_and_missing_fields(client):
    r = client.post("/api/models", json={"id": "x"})
    assert r.status_code == 400  # missing required fields

    ok = client.post("/api/models", json={
        "id": "local-x", "label": "Local X", "provider": "Ollama",
        "model": "x", "api_type": "openai", "base_url": "http://localhost:11434/v1",
    })
    assert ok.status_code == 200
    assert "local-x" in {m["id"] for m in client.get("/api/models").json()["models"]}


def test_delete_model_and_guard_last(client):
    ids = [m["id"] for m in client.get("/api/models").json()["models"]]
    # Delete all but one — the final deletion must be refused.
    for mid in ids[:-1]:
        assert client.delete(f"/api/models/{mid}").status_code == 200
    assert client.delete(f"/api/models/{ids[-1]}").status_code == 400


def test_delete_unknown_model(client):
    assert client.delete("/api/models/ghost").status_code == 404


# -- skills -----------------------------------------------------------------
def test_skills_crud(client):
    assert client.post("/api/skills", json={"name": "Tone", "body": "Be kind."}).status_code == 200
    listed = client.get("/api/skills").json()
    assert any(s["name"] == "Tone" for s in listed["skills"])

    assert client.post("/api/skills/active", json={"active": ["Tone"]}).status_code == 200
    assert client.get("/api/skills").json()["active"] == ["Tone"]

    assert client.delete("/api/skills/Tone").status_code == 200
    assert client.delete("/api/skills/Tone").status_code == 404


def test_create_skill_requires_name(client):
    assert client.post("/api/skills", json={"body": "x"}).status_code == 400


# -- import / export --------------------------------------------------------
def test_export_odt(client):
    r = client.post("/api/export", json={"html": "<p>Hi</p>", "format": "odt", "filename": "doc"})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"  # zip / ODT container
    assert "attachment" in r.headers["content-disposition"]


def test_export_html(client):
    r = client.post("/api/export", json={"html": "<p>Hi</p>", "format": "html", "filename": "doc"})
    assert r.status_code == 200
    assert "<p>Hi</p>" in r.text


def test_import_roundtrip(client):
    odt = converter.html_to_odt_bytes("<h1>Imported</h1><p>Body text</p>")
    r = client.post(
        "/api/import",
        files={"file": ("doc.odt", odt, "application/vnd.oasis.opendocument.text")},
    )
    assert r.status_code == 200
    body = r.json()
    assert "Imported" in body["html"]
    assert body["filename"] == "doc.odt"


def test_import_rejects_unknown_type(client):
    r = client.post("/api/import", files={"file": ("x.txt", b"data", "text/plain")})
    assert r.status_code == 400


# -- chat (SSE) -------------------------------------------------------------
def test_chat_streams_sse(client, monkeypatch):
    async def fake_stream(backend, messages, document_html, skill_prompt):
        yield "Hello "
        yield "world"

    monkeypatch.setattr(ai, "stream_chat", fake_stream)
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}],
                                       "document_html": "<p>doc</p>"})
    assert r.status_code == 200
    assert "Hello " in r.text and "world" in r.text
    assert '"done": true' in r.text
