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
        tesserae_url="http://tess.test", port=8770, workdir=tmp_path, tesserae_path=None, tesserae_data_root=None, mcp_token=None
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
        tesserae_url="http://tess.test", port=8770, workdir=tmp_path, tesserae_path=checkout, tesserae_data_root=None, mcp_token=None
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


# -- workspace (M1) ---------------------------------------------------------
@pytest.fixture
def ws_client(tmp_path):
    """A workspace with one editable widget, no tesserae source."""
    wdir = tmp_path / "work"
    widget = wdir / "mywidget"
    (widget / "static").mkdir(parents=True)
    widget.joinpath("client.js").write_text("export default () => {}")
    widget.joinpath("plugin.json").write_text(
        json.dumps({"kind": "widget", "name": "Mine", "icon": "ph-star", "fragments": []})
    )
    settings = Settings(
        tesserae_url="http://tess.test", port=8770, workdir=wdir, tesserae_path=None, tesserae_data_root=None, mcp_token=None
    )
    c = _make_client(settings)
    c.app.state.tesserae.raw._transport = httpx.MockTransport(
        lambda req: httpx.Response(404)
    )
    yield c
    c.__exit__(None, None, None)


def test_workspace_widget_in_catalog_editable(ws_client):
    widgets = ws_client.get("/studio/api/catalog").json()["widgets"]
    mine = [w for w in widgets if w["key"] == "mywidget"]
    assert mine and mine[0]["editable"] is True
    assert mine[0]["origin"] == "workspace"


def test_workspace_list_files(ws_client):
    files = ws_client.get("/studio/api/files/mywidget").json()["files"]
    paths = {f["path"]: f for f in files}
    assert "client.js" in paths and paths["client.js"]["language"] == "javascript"
    assert paths["plugin.json"]["language"] == "json"


def test_workspace_read_write_roundtrip(ws_client):
    r = ws_client.put(
        "/studio/api/files/mywidget/client.js",
        json={"content": "export default (s) => { s.innerHTML = 'hi'; }"},
    )
    assert r.json()["ok"] is True
    back = ws_client.get("/studio/api/files/mywidget/client.js").json()
    assert "s.innerHTML" in back["content"]


def test_workspace_asset_shadows_plugin(ws_client):
    ws_client.put(
        "/studio/api/files/mywidget/client.js",
        json={"content": "// edited body"},
    )
    resp = ws_client.get("/plugins/mywidget/client.js")
    assert resp.status_code == 200
    assert "// edited body" in resp.text


def test_workspace_path_traversal_blocked(ws_client):
    # The HTTP client normalises ../ in the URL, so the router rejects it before
    # our guard; either way nothing is written outside the workdir.
    r = ws_client.put(
        "/studio/api/files/mywidget/../escape.txt", json={"content": "nope"}
    )
    assert r.status_code in (400, 404, 405)
    assert not (ws_client.app.state.settings.workdir / "escape.txt").exists()


def test_workspace_guard_rejects_escape(tmp_path):
    from studio_server.workspace import Workspace, WorkspaceError

    ws = Workspace(tmp_path)
    (tmp_path / "w").mkdir()
    (tmp_path / "w" / "plugin.json").write_text("{}")
    with pytest.raises(WorkspaceError):
        ws.write_file("w", "../../evil.txt", "x")
    with pytest.raises(WorkspaceError):
        ws.read_file("../..", "etc/passwd")


# -- scaffold + duplicate (M2) ---------------------------------------------
def test_scaffold_creates_editable_widget(ws_client):
    r = ws_client.post("/studio/api/scaffold", json={"name": "My Cool Widget"}).json()
    assert r["ok"] and r["key"] == "my_cool_widget"
    assert "plugin.json" in r["files"] and "client.js" in r["files"]
    # It shows up in the catalog as editable, and its client.js serves from disk.
    widgets = ws_client.get("/studio/api/catalog").json()["widgets"]
    assert any(w["key"] == "my_cool_widget" and w["editable"] for w in widgets)
    assert ws_client.get("/plugins/my_cool_widget/client.js").status_code == 200


def test_scaffold_manifest_is_fragment_first(ws_client):
    ws_client.post("/studio/api/scaffold", json={"name": "Frag Demo", "archetype": "stat"})
    manifest = json.loads(ws_client.get("/studio/api/files/frag_demo/plugin.json").json()["content"])
    assert manifest["kind"] == "widget"
    assert manifest["supports"]["sizes"] == ["xs", "sm", "md", "lg"]
    frag_ids = [f["id"] for f in manifest["fragments"]]
    assert "value" in frag_ids and "label" in frag_ids  # stat defaults


def test_scaffold_client_js_is_lint_clean(ws_client):
    ws_client.post("/studio/api/scaffold", json={"name": "Lint Me", "server": True})
    js = ws_client.get("/studio/api/files/lint_me/client.js").json()["content"]
    assert "export default function" in js
    assert "ctx.cell.fragment" in js
    assert "shadow.innerHTML" in js
    assert "fetch(" not in js  # no client-side network
    assert "@media" not in js  # container queries only
    assert "@keyframes" not in js and "transition:" not in js  # no animation
    import re as _re

    assert not _re.search(r"#[0-9a-fA-F]{3,6}\b", js)  # no hard-coded hex


def test_scaffold_rejects_duplicate_name(ws_client):
    ws_client.post("/studio/api/scaffold", json={"name": "Dup"})
    again = ws_client.post("/studio/api/scaffold", json={"name": "Dup"})
    assert again.status_code == 400


def test_duplicate_widget_into_workspace(ws_client):
    # 'mywidget' is seeded by the ws_client fixture.
    r = ws_client.post("/studio/api/duplicate", json={"source": "mywidget", "name": "My Fork"})
    assert r.status_code == 200 and r.json()["key"] == "my_fork"
    files = ws_client.get("/studio/api/files/my_fork").json()["files"]
    assert {"client.js", "plugin.json"} <= {f["path"] for f in files}


# -- sync to Tesserae (symlink into marketplace) ----------------------------
@pytest.fixture
def sync_client(tmp_path):
    wdir = tmp_path / "work"
    widget = wdir / "mywidget"
    widget.mkdir(parents=True)
    widget.joinpath("client.js").write_text("export default () => {}")
    widget.joinpath("plugin.json").write_text(json.dumps({"kind": "widget", "name": "Mine"}))
    data_root = tmp_path / "tess-data"  # marketplace/ created on sync
    settings = Settings(
        tesserae_url="http://tess.test", port=8770, workdir=wdir,
        tesserae_path=None, tesserae_data_root=data_root, mcp_token=None,
    )
    c = _make_client(settings)
    c.app.state.tesserae.raw._transport = httpx.MockTransport(lambda req: httpx.Response(404))
    yield c, tmp_path
    c.__exit__(None, None, None)


def test_sync_creates_symlink_into_marketplace(sync_client):
    c, tmp_path = sync_client
    r = c.post("/studio/api/sync/mywidget").json()
    assert r["ok"] and r["synced"] is True
    # No live registry (mock 404s) -> not registered, needs a reload.
    assert r["registered"] is False and r["needs_reload"] is True
    link = tmp_path / "tess-data" / "marketplace" / "mywidget"
    assert link.is_symlink()
    assert link.resolve() == (tmp_path / "work" / "mywidget").resolve()


def test_catalog_reports_synced(sync_client):
    c, _ = sync_client
    c.post("/studio/api/sync/mywidget")
    mine = [w for w in c.get("/studio/api/catalog").json()["widgets"] if w["key"] == "mywidget"][0]
    assert mine["synced"] is True and mine["registered"] is False


def test_unsync_removes_symlink(sync_client):
    c, tmp_path = sync_client
    c.post("/studio/api/sync/mywidget")
    r = c.delete("/studio/api/sync/mywidget").json()
    assert r["ok"] and r["synced"] is False
    assert not (tmp_path / "tess-data" / "marketplace" / "mywidget").exists()


def test_sync_refuses_foreign_marketplace_entry(sync_client):
    c, tmp_path = sync_client
    # A real (non-symlink) folder already occupying the id must not be clobbered.
    foreign = tmp_path / "tess-data" / "marketplace" / "mywidget"
    foreign.mkdir(parents=True)
    (foreign / "plugin.json").write_text("{}")
    assert c.post("/studio/api/sync/mywidget").status_code == 400
    assert not (foreign).is_symlink()  # untouched


def test_unsync_guard_rejects_foreign_symlink(tmp_path):
    from studio_server.sync import SyncError, unsync

    market = tmp_path / "market"
    market.mkdir()
    (tmp_path / "elsewhere").mkdir()
    (market / "w").symlink_to(tmp_path / "elsewhere")  # points outside the workspace
    with pytest.raises(SyncError):
        unsync(market, tmp_path / "work", "w")
    assert (market / "w").is_symlink()  # not removed


# -- push over MCP (remote / HA path) --------------------------------------
def _mock_push_tesserae(installed):
    """A mock Tesserae with the 0.109 push API. `installed` is a mutable set of
    ids that the authored-list + install reflect."""

    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/healthz":
            return httpx.Response(200, text="ok")
        if p == "/api/mcp/catalog":
            return httpx.Response(200, json={"widgets": [], "appearance": {}})
        if p == "/api/mcp/widgets" and request.url.params.get("origin") == "authored":
            return httpx.Response(200, json={"widgets": [{"id": i, "version": "0.1.0", "active": True} for i in sorted(installed)]})
        if p == "/api/mcp/widgets/install":
            wid = request.url.params.get("id", "widget")
            installed.add(wid)
            return httpx.Response(200, json={
                "ok": True, "id": wid, "version": "0.1.0", "installed": True,
                "reload": "in_process", "active": True, "restarting": False,
            })
        if p.startswith("/api/mcp/widgets/") and p.endswith("/render.png"):
            return httpx.Response(200, content=b"\x89PNG\r\n_fake_", headers={"content-type": "image/png"})
        if p.startswith("/api/mcp/widgets/") and request.method == "DELETE":
            installed.discard(p.rsplit("/", 1)[-1])
            return httpx.Response(200, json={"ok": True, "id": p.rsplit("/", 1)[-1], "reload": "in_process", "active": False, "restarting": False})
        return httpx.Response(404, json={"error": "not found"})

    return httpx.MockTransport(handler)


@pytest.fixture
def push_client(tmp_path):
    """Remote Tesserae (non-loopback URL, no data root) -> HTTP push path."""
    wdir = tmp_path / "work"
    widget = wdir / "mywidget"
    widget.mkdir(parents=True)
    widget.joinpath("client.js").write_text("export default () => {}")
    widget.joinpath("plugin.json").write_text(json.dumps({"kind": "widget", "name": "Mine"}))
    settings = Settings(
        tesserae_url="http://tess.remote:8765", port=8770, workdir=wdir,
        tesserae_path=None, tesserae_data_root=None, mcp_token="tok",
    )
    c = _make_client(settings)
    c.app.state.tesserae.raw._transport = _mock_push_tesserae(set())
    yield c


def test_packager_makes_rooted_tarball(tmp_path):
    import io
    import tarfile

    from studio_server.packager import package_widget

    w = tmp_path / "aq"
    (w / "static").mkdir(parents=True)
    (w / "plugin.json").write_text("{}")
    (w / "client.js").write_text("x")
    (w / "__pycache__").mkdir()
    (w / "__pycache__" / "junk.pyc").write_text("nope")
    data = package_widget(w, "air_quality")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = tar.getnames()
    assert "air_quality/plugin.json" in names and "air_quality/client.js" in names
    assert not any("__pycache__" in n or n.endswith(".pyc") for n in names)


def test_register_method_is_push_for_remote(push_client):
    assert push_client.get("/studio/api/config").json()["registration"] == "push"


def test_push_installs_via_mcp(push_client):
    r = push_client.post("/studio/api/push/mywidget").json()
    assert r["ok"] and r["method"] == "push" and r["active"] is True and r["id"] == "mywidget"
    listed = push_client.get("/studio/api/push").json()["widgets"]
    assert any(w["id"] == "mywidget" for w in listed)


def test_register_dispatches_to_push(push_client):
    r = push_client.post("/studio/api/register/mywidget").json()
    assert r["method"] == "push" and r["active"] is True


def test_render_png_proxied(push_client):
    resp = push_client.get("/studio/api/render/mywidget.png?size=md")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")


def test_push_error_surfaced(push_client):
    # Swap in a transport that rejects install with a friendly error.
    push_client.app.state.tesserae.raw._transport = httpx.MockTransport(
        lambda req: httpx.Response(200, text="ok") if req.url.path == "/healthz"
        else httpx.Response(200, json={"widgets": []}) if req.url.path == "/api/mcp/widgets"
        else httpx.Response(409, json={"error": "id collides with a bundled widget"})
    )
    r = push_client.post("/studio/api/push/mywidget")
    assert r.status_code == 409 and "bundled" in r.json()["error"]


# -- mine_data_schema -------------------------------------------------------
@pytest.fixture
def mine_client(tmp_path):
    """A workspace widget whose live data endpoint returns a flattened payload."""
    wdir = tmp_path / "work"
    widget = wdir / "wx"
    widget.mkdir(parents=True)
    widget.joinpath("client.js").write_text("export default () => {}")
    widget.joinpath("plugin.json").write_text(json.dumps({
        "tesserae_compat": "1.x", "name": "Wx", "version": "0.1.0", "kind": "widget",
        "supports": {"sizes": ["md"]},
    }))
    # A tesserae checkout so the schema endpoint can validate on apply.
    checkout = tmp_path / "tess"
    (checkout / "schema").mkdir(parents=True)
    (checkout / "schema" / "plugin.schema.json").write_text(json.dumps({
        "type": "object", "required": ["name", "kind"],
        "properties": {"data_schema": {"type": "object"}},
    }))
    (checkout / "plugins").mkdir()
    settings = Settings(
        tesserae_url="http://tess.test", port=8770, workdir=wdir,
        tesserae_path=checkout, tesserae_data_root=None, mcp_token=None,
    )
    c = _make_client(settings)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/healthz":
            return httpx.Response(200, text="ok")
        if request.url.path == "/api/mcp/widgets/wx/data":
            return httpx.Response(200, json={
                "key": "wx", "data": {"temp": 19, "humidity": 58}, "data_source": "live",
                "fields": [{"path": "temp", "type": "int", "sample": 19},
                           {"path": "humidity", "type": "int", "sample": 58}],
            })
        return httpx.Response(404, json={"error": "x"})

    c.app.state.tesserae.raw._transport = httpx.MockTransport(handler)
    yield c


def test_mine_returns_fields_and_diff(mine_client):
    r = mine_client.post("/studio/api/mine/wx", json={"source": "live"}).json()
    assert r["ok"] and r["data_source"] == "live" and r["applied"] is False
    by = {f["name"]: f for f in r["fields"]}
    assert by["temp"]["type"] == "num" and by["humidity"]["unit"] == "%"
    assert set(r["diff"]["added"]) == {"temp", "humidity"}  # nothing declared yet


def test_mine_apply_writes_manifest(mine_client):
    r = mine_client.post("/studio/api/mine/wx", json={"source": "live", "apply": True}).json()
    assert r["applied"] is True
    manifest = json.loads(mine_client.get("/studio/api/files/wx/plugin.json").json()["content"])
    names = [f["name"] for f in manifest["data_schema"]["fields"]]
    assert names == ["humidity", "temp"]  # sorted by path, minimal shape
    assert manifest["data_schema"]["sample"] == {"temp": 19, "humidity": 58}


def test_mine_never_writes_from_error(mine_client):
    # No live data endpoint match + no manifest sample -> error, nothing written.
    mine_client.app.state.tesserae.raw._transport = httpx.MockTransport(
        lambda req: httpx.Response(200, text="ok") if req.url.path == "/healthz"
        else httpx.Response(200, json={"data": {"error": "boom"}, "data_source": "error", "fields": []})
    )
    r = mine_client.post("/studio/api/mine/wx", json={"source": "auto"})
    assert r.status_code == 400
    manifest = json.loads(mine_client.get("/studio/api/files/wx/plugin.json").json()["content"])
    assert "data_schema" not in manifest


# -- unit -------------------------------------------------------------------
def test_config_exposes_sizes(live_client):
    body = live_client.get("/studio/api/config").json()
    assert body["sizes"]["md"] == {"w": 640, "h": 400}


def test_clean_headers_drops_hop_by_hop():
    cleaned = _clean_headers({"Host": "x", "Content-Length": "3", "X-Keep": "1"})
    assert cleaned == {"X-Keep": "1"}
