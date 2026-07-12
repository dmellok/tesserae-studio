"""Server tests. A mock Tesserae is injected via httpx.MockTransport so these
run with no live instance."""

from __future__ import annotations

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
            return httpx.Response(200, json={"widgets": [{"id": "clock"}], "appearance": {}})
        if request.url.path == "/plugins/clock/client.js":
            return httpx.Response(
                200, text="export default () => {}", headers={"content-type": "text/javascript"}
            )
        return httpx.Response(404, text="not found")

    return httpx.MockTransport(handler)


@pytest.fixture
def client(tmp_path):
    settings = Settings(tesserae_url="http://tess.test", port=8770, workdir=tmp_path)
    app = create_app(settings)
    with TestClient(app) as c:
        # Swap the lifespan-created client's transport for the mock.
        c.app.state.tesserae.raw._transport = _mock_tesserae()
        yield c


def test_health_reports_tesserae_reachable(client):
    body = client.get("/studio/api/health").json()
    assert body == {
        "studio": "ok",
        "tesserae": "ok",
        "mcp": "ok",
        "url": "http://tess.test",
    }


def test_config_exposes_sizes(client):
    body = client.get("/studio/api/config").json()
    assert body["sizes"]["md"] == {"w": 640, "h": 400}
    assert body["features"]["faithful_preview"] is False


def test_catalog_passthrough(client):
    body = client.get("/studio/api/catalog").json()
    assert body["widgets"][0]["id"] == "clock"


def test_proxy_forwards_plugin_asset(client):
    resp = client.get("/plugins/clock/client.js")
    assert resp.status_code == 200
    assert "export default" in resp.text
    assert resp.headers["content-type"].startswith("text/javascript")


def test_clean_headers_drops_hop_by_hop():
    cleaned = _clean_headers({"Host": "x", "Content-Length": "3", "X-Keep": "1"})
    assert cleaned == {"X-Keep": "1"}
