"""FastAPI server for AI Words.

Serves the two-pane web UI and the JSON/SSE API for document import/export,
AI chat (streaming), model switching, and skill management.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import ai, skills
from .config import ModelBackend, load_config, save_config
from .converter import find_soffice, html_to_odt_bytes, odt_bytes_to_html

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="AI Words")


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ---------------------------------------------------------------------------
# Document import / export
# ---------------------------------------------------------------------------
@app.post("/api/import")
async def import_document(file: UploadFile) -> JSONResponse:
    name = (file.filename or "").lower()
    data = await file.read()
    if name.endswith(".odt"):
        html = odt_bytes_to_html(data)
    elif name.endswith((".html", ".htm")):
        html = data.decode("utf-8", errors="replace")
    else:
        raise HTTPException(400, "Unsupported file type. Upload an .odt or .html file.")
    return JSONResponse({"html": html, "filename": file.filename})


@app.post("/api/export")
async def export_document(request: Request) -> Response:
    body = await request.json()
    html = body.get("html", "")
    fmt = (body.get("format") or "odt").lower()
    filename = body.get("filename") or "document"
    stem = Path(filename).stem or "document"
    if fmt == "html":
        content = (
            "<!DOCTYPE html><html><head><meta charset='utf-8'>"
            f"<title>{stem}</title></head><body>{html}</body></html>"
        ).encode("utf-8")
        media = "text/html"
        out_name = f"{stem}.html"
    else:
        content = html_to_odt_bytes(html)
        media = "application/vnd.oasis.opendocument.text"
        out_name = f"{stem}.odt"
    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{out_name}"'},
    )


# ---------------------------------------------------------------------------
# AI chat (SSE stream)
# ---------------------------------------------------------------------------
@app.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    body = await request.json()
    messages = body.get("messages", [])
    document_html = body.get("document_html", "")

    cfg = load_config()
    backend = cfg.models.get(cfg.active_model)
    if backend is None:
        raise HTTPException(400, "No active model configured.")
    skill_prompt = skills.compose_skill_prompt(cfg.active_skills)

    async def event_stream():
        try:
            async for chunk in ai.stream_chat(
                backend, messages, document_html, skill_prompt
            ):
                yield f"data: {json.dumps({'delta': chunk})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as exc:  # surface errors to the UI
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
@app.get("/api/models")
async def get_models() -> JSONResponse:
    # No live Ollama sync here — models are whatever the user configured. Local
    # models are discovered once when the config is first created (see
    # load_config), then managed explicitly, so deletions stick.
    cfg = load_config()
    return JSONResponse(
        {
            "active": cfg.active_model,
            "models": [
                {
                    "id": m.id,
                    "label": m.label,
                    "provider": m.provider,
                    "api_type": m.api_type,
                    "model": m.model,
                    "base_url": m.base_url,
                    "has_key": bool(m.resolve_key()) if m.api_type != "openai" else True,
                }
                for m in cfg.models.values()
            ],
            "soffice": bool(find_soffice()),
        }
    )


@app.post("/api/models/active")
async def set_active_model(request: Request) -> JSONResponse:
    body = await request.json()
    model_id = body.get("id")
    cfg = load_config()
    if model_id not in cfg.models:
        raise HTTPException(404, f"Unknown model: {model_id}")
    cfg.active_model = model_id
    save_config(cfg)
    return JSONResponse({"active": model_id})


@app.post("/api/models")
async def add_model(request: Request) -> JSONResponse:
    body = await request.json()
    required = {"id", "label", "provider", "model"}
    if not required.issubset(body):
        raise HTTPException(400, f"Missing fields: {required - set(body)}")
    cfg = load_config()
    cfg.models[body["id"]] = ModelBackend(
        id=body["id"],
        label=body["label"],
        provider=body["provider"],
        model=body["model"],
        api_type=body.get("api_type", ""),  # inferred from provider if omitted
        base_url=body.get("base_url"),
        api_key_env=body.get("api_key_env"),
        api_key=body.get("api_key"),
    )
    save_config(cfg)
    return JSONResponse({"ok": True, "id": body["id"]})


@app.delete("/api/models/{model_id}")
async def delete_model(model_id: str) -> JSONResponse:
    cfg = load_config()
    if model_id not in cfg.models:
        raise HTTPException(404, f"Unknown model: {model_id}")
    if len(cfg.models) <= 1:
        raise HTTPException(400, "Cannot remove the last remaining model.")
    del cfg.models[model_id]
    # If the active model was removed, fall back to any remaining one.
    if cfg.active_model == model_id:
        cfg.active_model = next(iter(cfg.models))
    save_config(cfg)
    return JSONResponse({"ok": True, "active": cfg.active_model})


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------
@app.get("/api/skills")
async def get_skills() -> JSONResponse:
    cfg = load_config()
    return JSONResponse(
        {
            "active": cfg.active_skills,
            "skills": [
                {"name": s.name, "description": s.description} for s in skills.list_skills()
            ],
        }
    )


@app.post("/api/skills")
async def create_skill(request: Request) -> JSONResponse:
    body = await request.json()
    name = body.get("name")
    content = body.get("body", "")
    if not name:
        raise HTTPException(400, "Skill name is required.")
    skill = skills.create_skill(name, content, body.get("description", ""))
    return JSONResponse({"ok": True, "name": skill.name})


@app.delete("/api/skills/{name}")
async def remove_skill(name: str) -> JSONResponse:
    ok = skills.delete_skill(name)
    if not ok:
        raise HTTPException(404, f"Skill not found: {name}")
    cfg = load_config()
    if name in cfg.active_skills:
        cfg.active_skills.remove(name)
        save_config(cfg)
    return JSONResponse({"ok": True})


@app.post("/api/skills/active")
async def set_active_skills(request: Request) -> JSONResponse:
    body = await request.json()
    names = body.get("active", [])
    cfg = load_config()
    valid = {s.name for s in skills.list_skills()}
    cfg.active_skills = [n for n in names if n in valid]
    save_config(cfg)
    return JSONResponse({"active": cfg.active_skills})


# Serve static assets (css/js) from /static
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
