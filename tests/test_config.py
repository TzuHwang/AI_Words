"""Tests for app.config — model backends and config persistence."""

from __future__ import annotations

from app import config
from app.config import AppConfig, ModelBackend


# -- ModelBackend -----------------------------------------------------------
def test_api_type_inferred_from_provider():
    assert ModelBackend("i", "l", "Anthropic", "m").api_type == "anthropic"
    assert ModelBackend("i", "l", "Qwen", "m").api_type == "openai"


def test_explicit_api_type_is_preserved():
    m = ModelBackend("i", "l", "Anthropic", "m", api_type="openai")
    assert m.api_type == "openai"


def test_resolve_key_prefers_inline_then_env(monkeypatch):
    assert ModelBackend("i", "l", "X", "m", api_key="inline").resolve_key() == "inline"

    monkeypatch.setenv("MY_KEY", "from-env")
    assert ModelBackend("i", "l", "X", "m", api_key_env="MY_KEY").resolve_key() == "from-env"


def test_resolve_key_defaults_per_api_type(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    assert ModelBackend("i", "l", "Anthropic", "m").resolve_key() == "sk-ant"

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    # OpenAI-compatible endpoints frequently need no key at all.
    assert ModelBackend("i", "l", "Local", "m", api_type="openai").resolve_key() == "not-needed"


# -- AppConfig serialization ------------------------------------------------
def test_appconfig_roundtrip():
    cfg = AppConfig(active_model="claude-haiku", active_skills=["a", "b"])
    restored = AppConfig.from_dict(cfg.to_dict())
    assert restored.active_model == "claude-haiku"
    assert restored.active_skills == ["a", "b"]
    assert set(restored.models) == set(cfg.models)
    assert isinstance(next(iter(restored.models.values())), ModelBackend)


def test_from_dict_empty_models_falls_back_to_defaults():
    cfg = AppConfig.from_dict({"models": {}})
    assert cfg.models  # defaults injected
    assert cfg.active_model in cfg.models


# -- helpers ----------------------------------------------------------------
def test_slug_and_is_ollama_backend():
    assert config._slug("qwen2.5:7b") == "ollama-qwen2-5-7b"
    local = ModelBackend("i", "l", "Ollama", "m", base_url="http://localhost:11434/v1")
    remote = ModelBackend("i", "l", "OpenAI", "m", base_url="https://api.openai.com/v1")
    assert config.is_ollama_backend(local) is True
    assert config.is_ollama_backend(remote) is False


# -- load / save ------------------------------------------------------------
def test_load_config_creates_default_when_missing(tmp_config):
    assert not tmp_config.exists()
    cfg = config.load_config()
    assert tmp_config.exists()  # persisted on first run
    assert cfg.active_model in cfg.models


def test_save_and_reload_roundtrip(tmp_config):
    cfg = config.load_config()
    cfg.active_skills = ["writing"]
    cfg.active_model = "claude-haiku"
    config.save_config(cfg)

    reloaded = config.load_config()
    assert reloaded.active_skills == ["writing"]
    assert reloaded.active_model == "claude-haiku"


def test_load_config_recovers_from_corrupt_json(tmp_config):
    tmp_config.write_text("{ not valid json", encoding="utf-8")
    cfg = config.load_config()
    assert cfg.active_model in cfg.models  # rebuilt from defaults


# -- sync_local_models ------------------------------------------------------
def test_sync_local_models_adds_discovered_models(monkeypatch):
    monkeypatch.setattr(config, "discover_ollama_models", lambda *a, **k: ["llama3", "qwen"])
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cfg = AppConfig()

    changed = config.sync_local_models(cfg)

    assert changed is True
    assert config._slug("llama3") in cfg.models
    added = cfg.models[config._slug("llama3")]
    assert added.api_type == "openai"
    assert "11434" in added.base_url
    # Active API model had no key, so it should switch to a reachable local one.
    assert cfg.active_model == config._slug("llama3")


def test_sync_local_models_noop_without_local_models(monkeypatch):
    monkeypatch.setattr(config, "discover_ollama_models", lambda *a, **k: [])
    cfg = AppConfig()
    before = dict(cfg.models)
    config.sync_local_models(cfg)
    assert dict(cfg.models) == before
