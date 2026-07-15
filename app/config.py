"""Application configuration: AI model backends and active selections.

Config is stored as JSON next to the project root (``config.json``). Models can
be served from a **local host** (an OpenAI-compatible server such as Ollama or
LM Studio) or from a **provider-supplied API** (Anthropic, or any hosted
OpenAI-compatible endpoint).
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Overridable so a container can persist config on a mounted volume.
CONFIG_PATH = Path(os.environ.get("AI_WORDS_CONFIG") or (ROOT / "config.json"))

_lock = threading.Lock()


@dataclass
class ModelBackend:
    id: str
    label: str
    provider: str  # display/brand name shown in the UI, e.g. "Anthropic", "Qwen"
    model: str  # the provider's model identifier
    api_type: str = ""  # wire protocol used to talk to it: "anthropic" | "openai"
    base_url: str | None = None  # for local / self-hosted OpenAI-compatible servers
    api_key_env: str | None = None  # env var holding the key
    api_key: str | None = None  # inline key (discouraged; env is preferred)

    def __post_init__(self) -> None:
        # Back-compat: older configs stored the protocol in `provider` itself
        # (the only values were "anthropic" / "openai"). Infer api_type from it
        # so those configs keep working after `provider` became a free-text name.
        if not self.api_type:
            self.api_type = "anthropic" if self.provider.lower() == "anthropic" else "openai"

    def resolve_key(self) -> str | None:
        if self.api_key:
            return self.api_key
        if self.api_key_env:
            return os.environ.get(self.api_key_env)
        # sensible defaults
        if self.api_type == "anthropic":
            return os.environ.get("ANTHROPIC_API_KEY")
        if self.api_type == "openai":
            return os.environ.get("OPENAI_API_KEY") or "not-needed"
        return None


def _default_models() -> dict[str, ModelBackend]:
    return {
        "claude-opus": ModelBackend(
            id="claude-opus",
            label="Claude Opus 4.8 (API)",
            provider="Anthropic",
            model="claude-opus-4-8",
            api_type="anthropic",
            api_key_env="ANTHROPIC_API_KEY",
        ),
        "claude-haiku": ModelBackend(
            id="claude-haiku",
            label="Claude Haiku 4.5 (API)",
            provider="Anthropic",
            model="claude-haiku-4-5",
            api_type="anthropic",
            api_key_env="ANTHROPIC_API_KEY",
        ),
    }


OLLAMA_BASE = "http://localhost:11434"


def discover_ollama_models(base: str = OLLAMA_BASE) -> list[str]:
    """Return the names of models installed in a running local Ollama, if any."""
    try:
        import httpx

        resp = httpx.get(f"{base}/api/tags", timeout=1.5)
        resp.raise_for_status()
        return [m["name"] for m in resp.json().get("models", []) if m.get("name")]
    except Exception:
        return []


@dataclass
class AppConfig:
    active_model: str = "claude-opus"
    models: dict[str, ModelBackend] = field(default_factory=_default_models)
    active_skills: list[str] = field(default_factory=list)

    # -- serialization ----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "active_model": self.active_model,
            "models": {k: asdict(v) for k, v in self.models.items()},
            "active_skills": self.active_skills,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AppConfig":
        models = {
            k: ModelBackend(**v) for k, v in data.get("models", {}).items()
        }
        if not models:
            models = _default_models()
        return cls(
            active_model=data.get("active_model", next(iter(models))),
            models=models,
            active_skills=data.get("active_skills", []),
        )


def _slug(name: str) -> str:
    return "ollama-" + "".join(c if c.isalnum() else "-" for c in name).strip("-")


def is_ollama_backend(m: ModelBackend) -> bool:
    """True if the backend points at a local Ollama server (auto-discovered)."""
    return bool(m.base_url) and "11434" in m.base_url


def sync_local_models(cfg: AppConfig) -> bool:
    """Merge any installed local (Ollama) models into the config.

    Used once, when the config is first created, so a fresh install works out of
    the box. It is deliberately NOT run on every read: after the first run the
    user manages models explicitly, so adds and removals stick.

    Adds a backend for each installed Ollama model that isn't already present,
    and — when the active model is unusable (e.g. an API model with no key) —
    switches to a reachable local model. Returns True if the config changed.
    """
    changed = False
    installed = discover_ollama_models()
    known_ollama = {m.model for m in cfg.models.values() if is_ollama_backend(m)}
    first_local_id = None
    for name in installed:
        if name not in known_ollama:
            mid = _slug(name)
            cfg.models[mid] = ModelBackend(
                id=mid,
                label=f"Local — {name}",
                provider="Ollama",
                model=name,
                api_type="openai",
                base_url="http://localhost:11434/v1",
            )
            changed = True
        if first_local_id is None:
            first_local_id = _slug(name)

    # If the active backend can't run (missing key), fall back to a local model.
    active = cfg.models.get(cfg.active_model)
    active_usable = active is not None and (
        active.api_type == "openai" or bool(active.resolve_key())
    )
    if not active_usable and first_local_id and first_local_id in cfg.models:
        cfg.active_model = first_local_id
        changed = True
    return changed


def load_config() -> AppConfig:
    with _lock:
        cfg = None
        if CONFIG_PATH.exists():
            try:
                cfg = AppConfig.from_dict(json.loads(CONFIG_PATH.read_text("utf-8")))
            except (json.JSONDecodeError, TypeError, ValueError):
                cfg = None
        if cfg is None:
            cfg = AppConfig()
            sync_local_models(cfg)
            _save(cfg)
        return cfg


def save_config(cfg: AppConfig) -> None:
    with _lock:
        _save(cfg)


def _save(cfg: AppConfig) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg.to_dict(), indent=2), encoding="utf-8")
