"""Home Assistant add-on options -> Settings, layered under real env vars.

Read inside Settings.from_env (config.py) so the add-on's tesserae_url / mcp_token
apply no matter how the server is launched (console script or uvicorn directly)."""

from __future__ import annotations

import json

from studio_server.config import Settings


def _write_options(tmp_path, options: dict) -> str:
    p = tmp_path / "options.json"
    p.write_text(json.dumps(options))
    return str(p)


def test_ha_options_supply_tesserae_url(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "STUDIO_HA_OPTIONS", _write_options(tmp_path, {"tesserae_url": "http://tess:8765"})
    )
    monkeypatch.delenv("STUDIO_TESSERAE_URL", raising=False)
    s = Settings.from_env()
    assert s.tesserae_url == "http://tess:8765"


def test_ha_options_supply_mcp_token(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_HA_OPTIONS", _write_options(tmp_path, {"mcp_token": "secret"}))
    monkeypatch.delenv("STUDIO_TESSERAE_MCP_TOKEN", raising=False)
    assert Settings.from_env().mcp_token == "secret"


def test_env_var_wins_over_ha_option(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "STUDIO_HA_OPTIONS", _write_options(tmp_path, {"tesserae_url": "http://from-options:8765"})
    )
    monkeypatch.setenv("STUDIO_TESSERAE_URL", "http://from-env:8765")
    assert Settings.from_env().tesserae_url == "http://from-env:8765"


def test_blank_ha_option_falls_back_to_default(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_HA_OPTIONS", _write_options(tmp_path, {"tesserae_url": ""}))
    monkeypatch.delenv("STUDIO_TESSERAE_URL", raising=False)
    assert Settings.from_env().tesserae_url == "http://localhost:8765"


def test_no_options_file_is_noop(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_HA_OPTIONS", str(tmp_path / "missing.json"))
    monkeypatch.delenv("STUDIO_TESSERAE_URL", raising=False)
    assert Settings.from_env().tesserae_url == "http://localhost:8765"
