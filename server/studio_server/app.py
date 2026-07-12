"""FastAPI thin server: Studio's own API, disk-first asset serving, and a
reverse proxy to a live Tesserae for the paths that genuinely need one.

Run: ``uvicorn studio_server.app:app --port 8770 --reload``
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import SIZE_DIMENSIONS, Settings
from .proxy import forward
from .linter import lint_widget
from .scaffold import ScaffoldError, copy_widget, scaffold_files, slugify
from .source import TesseraeSource, catalog_entry
from .sync import SyncError, is_synced
from .sync import sync as sync_widget
from .sync import unsync as unsync_widget
from .tesserae import TesseraeClient
from .workspace import Workspace, WorkspaceError

# Asset prefixes Studio owns (disk-first, live-proxy fallback). Their on-disk
# layout under a tesserae checkout mirrors the URL, so the mounted widget's
# root-relative links resolve unchanged.
_ASSET_PREFIXES = ("/static", "/plugins")
# Live-only prefixes: proxied straight through, meaningful only with a running
# Tesserae (the MCP API and the faithful-render screenshot path).
_LIVE_PREFIXES = ("/api/mcp", "/_test")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    client = TesseraeClient(settings.tesserae_url)
    app.state.tesserae = client
    app.state.source = TesseraeSource(settings.tesserae_path, client)
    app.state.workspace = Workspace(settings.workdir)
    try:
        yield
    finally:
        await client.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="tesserae-studio", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings

    # ---- Studio's own API -------------------------------------------------
    @app.get("/studio/api/health")
    async def health() -> JSONResponse:
        status = await app.state.source.status()
        mode = "disk" if status["disk"] else ("live" if status["mcp"] else "none")
        return JSONResponse(
            {
                "studio": "ok",
                "tesserae": "ok" if status["live"] else "unreachable",
                # "off" = up but the mcp experiment is disabled.
                "mcp": "ok" if status["mcp"] else ("off" if status["live"] else "unreachable"),
                "mode": mode,  # where assets + catalog come from
                "interactive": status["interactive"],
                "faithful": status["faithful"],
                "live_data": status["live_data"],
                "url": settings.tesserae_url,
                "path": str(settings.tesserae_path) if settings.tesserae_path else None,
            }
        )

    @app.get("/studio/api/config")
    async def config() -> JSONResponse:
        return JSONResponse(
            {
                "tesserae_url": settings.tesserae_url,
                "tesserae_path": str(settings.tesserae_path) if settings.tesserae_path else None,
                "tesserae_data_root": str(settings.tesserae_data_root) if settings.tesserae_data_root else None,
                "sizes": {k: {"w": w, "h": h} for k, (w, h) in SIZE_DIMENSIONS.items()},
            }
        )

    async def _live_keys() -> set[str]:
        """Widget keys the *running* Tesserae registry knows about, for
        registered-detection. Empty when the live MCP API is unreachable."""
        status = await app.state.source.status()
        if not status["mcp"]:
            return set()
        try:
            live = await app.state.tesserae.catalog()
            return {w["key"] for w in live.get("widgets", [])}
        except Exception:  # noqa: BLE001
            return set()

    @app.get("/studio/api/catalog")
    async def catalog() -> JSONResponse:
        # Workspace widgets (editable, authored here) merge in front of the
        # read-only tesserae widgets and shadow any that share a key. Each also
        # reports whether it is synced (symlinked into Tesserae) and registered
        # (live in the running registry).
        marketplace = settings.marketplace_dir
        wsroot = app.state.workspace.root
        live_keys = await _live_keys()
        ws_entries = [
            {
                **catalog_entry(w["key"], w["manifest"]),
                "editable": True,
                "origin": "workspace",
                "synced": is_synced(marketplace, wsroot, w["key"]),
                "registered": w["key"] in live_keys,
            }
            for w in app.state.workspace.list_widgets()
        ]
        try:
            base = await app.state.source.catalog()
        except Exception as exc:  # noqa: BLE001 - degrade to workspace-only
            base = {"widgets": [], "appearance": {}, "source": "none", "error": str(exc)}
        seen = {w["key"] for w in ws_entries}
        ref = [
            {**w, "editable": False, "origin": base.get("source", "tesserae")}
            for w in base.get("widgets", [])
            if w["key"] not in seen
        ]
        return JSONResponse(
            {"widgets": ws_entries + ref, "appearance": base.get("appearance", {}),
             "source": base.get("source", "none")}
        )

    @app.get("/studio/api/widgets/{key}/data")
    async def widget_data(key: str) -> JSONResponse:
        return await app.state.source.widget_data(key)

    # ---- Working directory: the files Monaco edits -----------------------
    @app.get("/studio/api/files/{widget}")
    async def list_files(widget: str) -> JSONResponse:
        try:
            return JSONResponse({"widget": widget, "files": app.state.workspace.list_files(widget)})
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)

    @app.get("/studio/api/files/{widget}/{relpath:path}")
    async def read_file(widget: str, relpath: str) -> JSONResponse:
        try:
            content = app.state.workspace.read_file(widget, relpath)
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        return JSONResponse({"widget": widget, "path": relpath, "content": content})

    @app.put("/studio/api/files/{widget}/{relpath:path}")
    async def write_file(widget: str, relpath: str, content: str = Body(..., embed=True)) -> JSONResponse:
        try:
            result = app.state.workspace.write_file(widget, relpath, content)
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, **result})

    # ---- Scaffold a new widget / duplicate an existing one ---------------
    @app.post("/studio/api/scaffold")
    async def scaffold(spec: dict = Body(...)) -> JSONResponse:
        name = str(spec.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "name is required"}, status_code=400)
        try:
            key, files = scaffold_files(
                name,
                archetype=str(spec.get("archetype") or "stat"),
                fragments=spec.get("fragments") or None,
                with_server=bool(spec.get("server")),
            )
            result = app.state.workspace.create_widget(key, files)
        except (ScaffoldError, WorkspaceError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, **result})

    @app.post("/studio/api/duplicate")
    async def duplicate(spec: dict = Body(...)) -> JSONResponse:
        source = str(spec.get("source") or "").strip()
        if not source:
            return JSONResponse({"error": "source is required"}, status_code=400)
        # Resolve the source folder: a workspace widget, else the disk checkout.
        ws = app.state.workspace
        src_dir = ws.root / source
        if not (src_dir / "plugin.json").is_file():
            tpath = settings.tesserae_path
            src_dir = (tpath / "plugins" / source) if tpath else src_dir
        if not (src_dir / "plugin.json").is_file():
            return JSONResponse(
                {"error": f"cannot duplicate '{source}': needs a disk checkout or a workspace copy"},
                status_code=400,
            )
        try:
            key = slugify(str(spec.get("name") or f"{source}_copy"))
            dest = ws.new_widget_dir(key)
            written = copy_widget(src_dir, dest)
        except (ScaffoldError, WorkspaceError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, "key": key, "files": written})

    # ---- Register a workspace widget with Tesserae (symlink) -------------
    async def _sync_state(widget: str) -> dict:
        synced = is_synced(settings.marketplace_dir, app.state.workspace.root, widget)
        registered = widget in (await _live_keys())
        return {
            "widget": widget,
            "synced": synced,
            "registered": registered,
            # Symlinked but not yet in the live registry: Tesserae must restart
            # to pick it up (same "restart to activate" model as its marketplace).
            "needs_reload": synced and not registered,
        }

    @app.post("/studio/api/sync/{widget}")
    async def sync_endpoint(widget: str) -> JSONResponse:
        try:
            sync_widget(settings.marketplace_dir, app.state.workspace.root, widget)
        except SyncError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, **(await _sync_state(widget))})

    @app.delete("/studio/api/sync/{widget}")
    async def unsync_endpoint(widget: str) -> JSONResponse:
        try:
            unsync_widget(settings.marketplace_dir, app.state.workspace.root, widget)
        except SyncError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, **(await _sync_state(widget))})

    # ---- Manifest schema for Monaco JSON validation ----------------------
    def _load_schema() -> dict | None:
        import json

        path = settings.tesserae_path
        schema_file = (path / "schema" / "plugin.schema.json") if path else None
        if schema_file and schema_file.is_file():
            return json.loads(schema_file.read_text())
        return None

    @app.get("/studio/api/schema/plugin")
    async def plugin_schema() -> JSONResponse:
        schema = _load_schema()
        if schema is not None:
            return JSONResponse(schema)
        return JSONResponse({"error": "plugin.schema.json unavailable (no disk checkout)"}, 404)

    # ---- Widget linter (the Golden Rules) --------------------------------
    @app.get("/studio/api/lint/{widget}")
    async def lint(widget: str) -> JSONResponse:
        import json

        ws = app.state.workspace
        try:
            files = ws.read_text_files(widget)
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        try:
            manifest = json.loads(files.get("plugin.json", "{}"))
        except json.JSONDecodeError as exc:
            manifest = {}
            # Surface the parse error itself as a finding instead of failing.
            bad = [{"rule": "manifest-json", "level": "error",
                    "message": f"plugin.json is not valid JSON: {exc}", "file": "plugin.json", "line": exc.lineno}]
            return JSONResponse({"widget": widget, "findings": bad, "errors": 1, "warnings": 0})
        findings = lint_widget(files, manifest, schema=_load_schema())
        errors = sum(1 for f in findings if f["level"] == "error")
        return JSONResponse(
            {"widget": widget, "findings": findings,
             "errors": errors, "warnings": len(findings) - errors}
        )

    # ---- Assets: workspace-first, then disk, then live proxy -------------
    async def _asset(request: Request):
        path = request.url.path
        # A widget being authored shadows the tesserae checkout so its edited
        # client.js/static previews immediately.
        ws_file = request.app.state.workspace.resolve_plugin_asset(path)
        if ws_file is not None:
            return FileResponse(ws_file)
        # request.url.path already includes the prefix (/static/... or
        # /plugins/...); the disk layout mirrors it, so pass it through whole.
        return await request.app.state.source.serve_asset(request, path)

    for prefix in _ASSET_PREFIXES:
        app.add_api_route(prefix + "/{path:path}", _asset, methods=["GET", "HEAD"])

    # ---- Live-only proxy (MCP API, faithful render) ----------------------
    async def _proxy(request: Request):
        return await forward(request, request.app.state.tesserae.raw)

    for prefix in _LIVE_PREFIXES:
        app.add_api_route(
            prefix + "/{path:path}",
            _proxy,
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        )
        app.add_api_route(
            prefix,
            _proxy,
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        )

    # ---- Serve the built front end in prod (dev uses the Vite server) -----
    dist = Path(__file__).resolve().parents[2] / "web" / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="web")

    return app


app = create_app()
