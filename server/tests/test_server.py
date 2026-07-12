"""Server tests. A mock Tesserae is injected via httpx.MockTransport so the
live-mode tests run with no real instance; disk-mode tests build a tiny fake
checkout on tmp_path."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from studio_server.app import create_app
from studio_server.config import Settings
from studio_server.proxy import _clean_headers


def _mock_tesserae() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/healthz":
            return httpx.Response(200, text="ok")
        if request.url.path == "/api/mcp/catalog":
            return httpx.Response(200, json={"widgets": [{"key": "clock"}], "appearance": {}})
        if request.url.path == "/plugins/clock/client.js":
            return httpx.Response(
                200, text="export default () => {}", headers={"content-type": "text/javascript"}
            )
        return httpx.Response(404, text="not found")

    return httpx.MockTransport(handler)


def _make_client(settings: Settings) -> TestClient:
    app = create_app(settings)
    c = TestClient(app)
    c.__enter__()
    c.app.state.tesserae.raw._transport = _mock_tesserae()
    return c


@pytest.fixture
def live_client(tmp_path):
    """No disk checkout: assets + catalog come from the (mock) live instance."""
    settings = Settings(
        tesserae_url="http://tess.test", port=8770, workdir=tmp_path, tesserae_path=None
    )
    c = _make_client(settings)
    yield c
    c.__exit__(None, None, None)


@pytest.fixture
def disk_client(tmp_path):
    """A fake tesserae checkout: assets + catalog come from disk, no live needed.
    The mock transport 404s everything, standing in for 'no running instance'."""
    checkout = tmp_path / "tess"
    (checkout / "static" / "style").mkdir(parents=True)
    (checkout / "static" / "style" / "base.css").write_text("body{color:red}")
    wdir = checkout / "plugins" / "demo"
    wdir.mkdir(parents=True)
    wdir.joinpath("client.js").write_text("export default () => {}")
    wdir.joinpath("plugin.json").write_text(
        json.dumps(
            {
                "kind": "widget",
                "name": "Demo",
                "icon": "ph-star",
                "fragments": [{"id": "full"}, {"id": "mini", "label": "Mini", "w": 100, "h": 80}],
            }
        )
    )
    # A non-widget plugin that must be excluded from the catalog.
    core = checkout / "plugins" / "fonts_core"
    core.mkdir(parents=True)
    core.joinpath("plugin.json").write_text(json.dumps({"kind": "companion", "name": "Fonts"}))

    settings = Settings(
        tesserae_url="http://tess.test", port=8770, workdir=tmp_path, tesserae_path=checkout
    )
    c = _make_client(settings)
    # Force the live probe to fail, proving disk mode is self-sufficient.
    c.app.state.tesserae.raw._transport = httpx.MockTransport(
        lambda req: httpx.Response(404, text="down")
    )
    yield c
    c.__exit__(None, None, None)


# -- live mode --------------------------------------------------------------
def test_live_health(live_client):
    body = live_client.get("/studio/api/health").json()
    assert body["tesserae"] == "ok"
    assert body["mcp"] == "ok"
    assert body["mode"] == "live"
    assert body["interactive"] is True and body["faithful"] is True


def test_live_catalog_from_mcp(live_client):
    body = live_client.get("/studio/api/catalog").json()
    assert body["source"] == "live"
    assert body["widgets"][0]["key"] == "clock"


def test_live_asset_proxies_plugin(live_client):
    resp = live_client.get("/plugins/clock/client.js")
    assert resp.status_code == 200
    assert "export default" in resp.text


# -- disk mode (standalone) -------------------------------------------------
def test_disk_health_no_live(disk_client):
    body = disk_client.get("/studio/api/health").json()
    assert body["tesserae"] == "unreachable"
    assert body["mode"] == "disk"
    # Interactive works from disk; faithful still needs a live instance.
    assert body["interactive"] is True
    assert body["faithful"] is False


def test_disk_catalog_from_files(disk_client):
    body = disk_client.get("/studio/api/catalog").json()
    assert body["source"] == "disk"
    keys = [w["key"] for w in body["widgets"]]
    assert keys == ["demo"]  # fonts_core (companion) excluded
    frags = [f["id"] for f in body["widgets"][0]["fragments"]]
    assert frags == ["full", "mini"]


def test_disk_serves_static_from_files(disk_client):
    resp = disk_client.get("/static/style/base.css")
    assert resp.status_code == 200
    assert "color:red" in resp.text


def test_disk_widget_data_falls_back_to_none(disk_client):
    # No widget_samples for "demo" in the fake checkout -> null data, source none.
    body = disk_client.get("/studio/api/widgets/demo/data").json()
    assert body["data"] is None
    assert body["source"] == "none"


# -- unit -------------------------------------------------------------------
def test_config_exposes_sizes(live_client):
    body = live_client.get("/studio/api/config").json()
    assert body["sizes"]["md"] == {"w": 640, "h": 400}


def test_clean_headers_drops_hop_by_hop():
    cleaned = _clean_headers({"Host": "x", "Content-Length": "3", "X-Keep": "1"})
    assert cleaned == {"X-Keep": "1"}
