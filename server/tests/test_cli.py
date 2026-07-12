"""The console-script helpers: the Home Assistant options -> env bridge."""

from __future__ import annotations

import json

from studio_server import cli


def _run_bridge(monkeypatch, tmp_path, options: dict | None, env: dict[str, str]):
    if options is None:
        monkeypatch.setattr(cli, "_HA_OPTIONS", str(tmp_path / "missing.json"))
    else:
        p = tmp_path / "options.json"
        p.write_text(json.dumps(options))
        monkeypatch.setattr(cli, "_HA_OPTIONS", str(p))
    for k in ("STUDIO_TESSERAE_URL", "STUDIO_TESSERAE_MCP_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    cli._load_ha_options()


def test_maps_ha_options_to_env(monkeypatch, tmp_path):
    _run_bridge(
        monkeypatch,
        tmp_path,
        {"tesserae_url": "http://tess:8765", "mcp_token": "secret"},
        env={},
    )
    import os

    assert os.environ["STUDIO_TESSERAE_URL"] == "http://tess:8765"
    assert os.environ["STUDIO_TESSERAE_MCP_TOKEN"] == "secret"


def test_existing_env_wins(monkeypatch, tmp_path):
    _run_bridge(
        monkeypatch,
        tmp_path,
        {"tesserae_url": "http://from-options:8765"},
        env={"STUDIO_TESSERAE_URL": "http://from-env:8765"},
    )
    import os

    assert os.environ["STUDIO_TESSERAE_URL"] == "http://from-env:8765"


def test_blank_option_ignored(monkeypatch, tmp_path):
    _run_bridge(monkeypatch, tmp_path, {"tesserae_url": "", "mcp_token": ""}, env={})
    import os

    assert "STUDIO_TESSERAE_URL" not in os.environ


def test_no_options_file_is_noop(monkeypatch, tmp_path):
    _run_bridge(monkeypatch, tmp_path, None, env={})
    import os

    assert "STUDIO_TESSERAE_URL" not in os.environ
