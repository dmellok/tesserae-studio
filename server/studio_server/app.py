"""FastAPI thin server: Studio's own API, disk-first asset serving, and a
reverse proxy to a live Tesserae for the paths that genuinely need one.

Run: ``uvicorn studio_server.app:app --port 8770 --reload``
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import SIZE_DIMENSIONS, Settings, ha_options_debug
from .flatten import flatten_fields
from .linter import lint_widget
from .mine import MineError, apply_to_manifest, mine
from .packager import package_widget
from .proxy import forward
from .publish import (
    TAGS,
    PublishError,
    assemble_pr,
    build_catalog_entry,
    bundle_folders,
    package,
    sha256_of_url,
    upsert_into_index,
    validate_entry,
)
from .publish import (
    pr_body as _pr_body,
)
from .scaffold import ScaffoldError, copy_widget, scaffold_files, slugify
from .source import TesseraeSource, catalog_entry
from .sync import SyncError, is_synced
from .sync import sync as sync_widget
from .sync import unsync as unsync_widget
from .tesserae import PushError, TesseraeClient
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
    client = TesseraeClient(settings.tesserae_url, mcp_token=settings.mcp_token)
    app.state.tesserae = client
    app.state.source = TesseraeSource(settings.tesserae_path, client)
    app.state.workspace = Workspace(settings.workdir)
    try:
        yield
    finally:
        await client.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="tesserae-studio", version="0.3.5", lifespan=lifespan)
    app.state.settings = settings

    # ---- Studio's own API -------------------------------------------------
    @app.get("/studio/api/health")
    async def health() -> JSONResponse:
        status = await app.state.source.status()
        mode = "disk" if status["disk"] else ("live" if status["mcp"] else "none")
        return JSONResponse(
            {
                "studio": "ok",
                "version": app.version,
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
                "tesserae_data_root": str(settings.tesserae_data_root)
                if settings.tesserae_data_root
                else None,
                "mcp_token_set": bool(settings.mcp_token),
                # How a workspace widget registers with this Tesserae right now.
                "registration": await _registration_method(),
                # Diagnostic: did the HA add-on options file get read? (key names only)
                "ha_options": ha_options_debug(),
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
                "kind": w["manifest"].get("kind", "widget"),
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
            {
                **w,
                "editable": False,
                "origin": base.get("source", "tesserae"),
                "registered": w["key"] in live_keys,
            }
            for w in base.get("widgets", [])
            if w["key"] not in seen
        ]
        return JSONResponse(
            {
                "widgets": ws_entries + ref,
                "appearance": base.get("appearance", {}),
                "source": base.get("source", "none"),
            }
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
    async def write_file(
        widget: str, relpath: str, content: str = Body(..., embed=True)
    ) -> JSONResponse:
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

    @app.post("/studio/api/scaffold-bundle")
    async def scaffold_bundle(spec: dict = Body(...)) -> JSONResponse:
        from .bundle import scaffold_bundle_files

        name = str(spec.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "name is required"}, status_code=400)
        try:
            core_id, member_ids, folders = scaffold_bundle_files(
                name,
                spec.get("members") or None,
                admin=spec.get("admin", True) is not False,
            )
        except ScaffoldError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        ws = app.state.workspace
        # All-or-nothing: refuse if any folder id already exists.
        clashes = [fid for fid in folders if (ws.root / fid).exists()]
        if clashes:
            return JSONResponse({"error": f"already exist: {', '.join(clashes)}"}, status_code=400)
        try:
            for fid, files in folders.items():
                ws.create_widget(fid, files)
        except WorkspaceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(
            {"ok": True, "core": core_id, "members": member_ids, "folders": list(folders)}
        )

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
                {
                    "error": f"cannot duplicate '{source}': "
                    "needs a disk checkout or a workspace copy"
                },
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

    # ---- Register a widget over HTTP (push, works remote / HA) -----------
    async def _can_symlink() -> bool:
        m = settings.marketplace_dir
        return bool(m and settings.tesserae_is_loopback and (m.exists() or m.parent.exists()))

    async def _registration_method() -> str:
        """How Studio can register a workspace widget with the connected
        Tesserae: a local symlink (same host), an HTTP push (remote / HA), or
        neither. Prefer the symlink when co-located; default to push otherwise."""
        if await _can_symlink():
            return "symlink"
        if await app.state.tesserae.push_available():
            return "push"
        return "none"

    async def _await_active(widget: str, timeout: float = 30.0) -> bool:
        """Poll until a restarting Tesserae has the widget back in its registry."""
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(1.0)
            if await app.state.tesserae.probe_health():
                if widget in {w["id"] for w in await app.state.tesserae.list_authored()}:
                    return True
        return False

    async def _push(widget: str, reload: str) -> JSONResponse:
        wdir = app.state.workspace.root / widget
        if not (wdir / "plugin.json").is_file():
            return JSONResponse({"error": f"{widget} is not a workspace widget."}, status_code=400)
        tar = package_widget(wdir, widget)
        try:
            res = await app.state.tesserae.install_widget(tar, widget_id=widget, reload=reload)
        except PushError as exc:
            return JSONResponse({"error": exc.message}, status_code=exc.status)
        if res.get("restarting"):
            res["active"] = await _await_active(widget)
        return JSONResponse({**res, "method": "push"})

    @app.post("/studio/api/push/{widget}")
    async def push_endpoint(widget: str, reload: str = "auto") -> JSONResponse:
        return await _push(widget, reload)

    @app.delete("/studio/api/push/{widget}")
    async def push_delete_endpoint(widget: str, reload: str = "auto") -> JSONResponse:
        try:
            res = await app.state.tesserae.uninstall_widget(widget, reload=reload)
        except PushError as exc:
            return JSONResponse({"error": exc.message}, status_code=exc.status)
        return JSONResponse({**res, "method": "push"})

    @app.get("/studio/api/push")
    async def push_list_endpoint() -> JSONResponse:
        return JSONResponse({"widgets": await app.state.tesserae.list_authored()})

    # Unified register: pick the symlink (local) or push (remote) path.
    @app.post("/studio/api/register/{widget}")
    async def register_endpoint(widget: str, reload: str = "auto") -> JSONResponse:
        method = await _registration_method()
        if method == "symlink":
            try:
                sync_widget(settings.marketplace_dir, app.state.workspace.root, widget)
            except SyncError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)
            return JSONResponse({"ok": True, "method": "symlink", **(await _sync_state(widget))})
        if method == "push":
            return await _push(widget, reload)
        return JSONResponse(
            {
                "error": "no way to register: connect a local Tesserae, "
                "or a remote one with the push API + mcp token."
            },
            status_code=400,
        )

    @app.delete("/studio/api/register/{widget}")
    async def unregister_endpoint(widget: str) -> JSONResponse:
        # Remove whichever registration exists: a local symlink, or a push.
        if is_synced(settings.marketplace_dir, app.state.workspace.root, widget):
            try:
                unsync_widget(settings.marketplace_dir, app.state.workspace.root, widget)
            except SyncError as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)
            return JSONResponse({"ok": True, "method": "symlink", **(await _sync_state(widget))})
        try:
            res = await app.state.tesserae.uninstall_widget(widget)
        except PushError as exc:
            return JSONResponse({"error": exc.message}, status_code=exc.status)
        return JSONResponse({**res, "method": "push"})

    # ---- Faithful render (dithered PNG over the authed MCP surface) -------
    @app.get("/studio/api/render/{widget}.png")
    async def render_png_endpoint(
        widget: str, size: str = "lg", opts: str | None = None
    ) -> Response:
        try:
            content, ctype = await app.state.tesserae.render_png(widget, size=size, opts=opts)
        except PushError as exc:
            return JSONResponse({"error": exc.message}, status_code=exc.status)
        return Response(content=content, media_type=ctype)

    # ---- Manifest schema for Monaco JSON validation ----------------------
    def _load_schema() -> dict | None:
        import json

        # A live/disk checkout's schema wins (it matches that Tesserae's version);
        # otherwise fall back to Studio's bundled copy so validation works with no
        # checkout at all.
        path = settings.tesserae_path
        candidates = []
        if path:
            candidates.append(path / "schema" / "plugin.schema.json")
        candidates.append(
            Path(__file__).resolve().parent / "assets" / "schema" / "plugin.schema.json"
        )
        for schema_file in candidates:
            if schema_file.is_file():
                return json.loads(schema_file.read_text())
        return None

    @app.get("/studio/api/schema/plugin")
    async def plugin_schema() -> JSONResponse:
        schema = _load_schema()
        if schema is not None:
            return JSONResponse(schema)
        return JSONResponse({"error": "plugin.schema.json unavailable"}, 404)

    # ---- mine_data_schema (canvas-bindable fields from real data) --------
    async def _gather_fields(widget: str, manifest: dict, options: dict, source: str):
        """Return (data, data_source, raw_fields, warnings). Live uses the
        running Tesserae's flattener; sample flattens the manifest sample."""
        import json as _json  # noqa: F401 (kept local, mirrors other handlers)

        declared = manifest.get("data_schema") or {}
        warnings: list[str] = []
        if source in ("live", "auto"):
            try:
                res = await app.state.tesserae.widget_data(widget, options)
                if res.get("data_source") == "error":
                    raise RuntimeError(res.get("reason") or "widget fetch returned an error")
                return res.get("data"), res.get("data_source"), res.get("fields") or [], warnings
            except Exception as exc:  # noqa: BLE001
                sample = declared.get("sample")
                if source == "live" and not isinstance(sample, dict):
                    raise MineError(
                        f"live fetch failed and no manifest sample to fall back on: {exc}. "
                        "Register the widget with Tesserae, or add a data_schema.sample."
                    ) from exc
                warnings.append(f"live data unavailable ({exc}); mined from the manifest sample.")
        sample = declared.get("sample")
        if not isinstance(sample, dict):
            raise MineError(
                "no data_schema.sample in the manifest. Register the widget and mine live, "
                "or add a sample."
            )
        return sample, "sample", flatten_fields(sample), warnings

    @app.post("/studio/api/mine/{widget}")
    async def mine_endpoint(widget: str, spec: dict = Body(default={})) -> JSONResponse:
        import json

        ws = app.state.workspace
        try:
            manifest = json.loads(ws.read_file(widget, "plugin.json"))
        except (WorkspaceError, json.JSONDecodeError) as exc:
            return JSONResponse(
                {"error": f"cannot read {widget}/plugin.json: {exc}"}, status_code=400
            )

        source = spec.get("source") or "auto"
        options = spec.get("options") or {}
        max_fields = int(spec.get("max_fields") or 64)
        apply = bool(spec.get("apply"))
        try:
            data, data_source, raw_fields, warnings = await _gather_fields(
                widget, manifest, options, source
            )
        except MineError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

        result = mine(raw_fields, data, manifest.get("data_schema"), max_fields=max_fields)
        result["warnings"] = warnings + result["warnings"]

        applied = False
        if apply:
            merged = apply_to_manifest(manifest, result["data_schema"])
            schema = _load_schema()
            if schema is not None:
                try:
                    import jsonschema

                    jsonschema.Draft202012Validator(schema).validate(merged)
                except Exception as exc:  # noqa: BLE001
                    return JSONResponse(
                        {"error": f"mined schema would make plugin.json invalid: {exc}"},
                        status_code=400,
                    )
            ws.write_file(widget, "plugin.json", json.dumps(merged, indent=2) + "\n")
            applied = True

        return JSONResponse(
            {
                "ok": True,
                "source": source,
                "data_source": data_source,
                "fields": result["fields"],
                "data_schema": result["data_schema"],
                "diff": result["diff"],
                "applied": applied,
                "warnings": result["warnings"],
            }
        )

    # ---- Package + publish to the catalog (M6) ---------------------------
    def _marketplace_schema() -> dict | None:
        import json

        for base in (settings.catalog_path, settings.tesserae_path):
            if base:
                f = base / "schema" / "marketplace.schema.json"
                if f.is_file():
                    return json.loads(f.read_text())
        return None

    def _resolve_folders(widget: str, opts: dict) -> tuple[list[str] | None, str]:
        keys = [w["key"] for w in app.state.workspace.list_widgets()]
        folders = opts.get("folders") or bundle_folders(keys, widget)
        if folders:
            core = next((f for f in folders if f.endswith("_core")), None)
            entry_id = opts.get("id") or (core[: -len("_core")] if core else widget)
        else:
            entry_id = opts.get("id") or widget
        return folders, entry_id

    async def _entry_for(
        widget: str, opts: dict
    ) -> tuple[dict | None, list[str], JSONResponse | None]:
        import json

        ws = app.state.workspace
        try:
            manifest = json.loads(ws.read_file(widget, "plugin.json"))
        except (WorkspaceError, json.JSONDecodeError) as exc:
            return (
                None,
                [],
                JSONResponse(
                    {"error": f"cannot read {widget}/plugin.json: {exc}"}, status_code=400
                ),
            )
        folders, entry_id = _resolve_folders(widget, opts)
        release = dict(opts.get("release") or {})
        if release.get("tarball_url") and not release.get("sha256"):
            try:
                release["sha256"] = await sha256_of_url(release["tarball_url"])
            except Exception as exc:  # noqa: BLE001
                return (
                    None,
                    [],
                    JSONResponse(
                        {"error": f"could not fetch tarball for sha256: {exc}"}, status_code=400
                    ),
                )
        try:
            entry = build_catalog_entry(
                manifest, entry_id=entry_id, folders=folders, opts={**opts, "release": release}
            )
        except PublishError as exc:
            return None, [], JSONResponse({"error": str(exc), "tags": TAGS}, status_code=400)
        schema = _marketplace_schema()
        errors = validate_entry(entry, schema) if schema else []
        return entry, errors, None

    @app.post("/studio/api/package/{widget}")
    async def package_endpoint(widget: str) -> JSONResponse:
        ws = app.state.workspace
        folders, _ = _resolve_folders(widget, {})
        try:
            data, sha = package(ws.root, folders or [widget])
        except PublishError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(
            {"ok": True, "folders": folders or [widget], "sha256": sha, "size": len(data)}
        )

    @app.post("/studio/api/catalog-entry/{widget}")
    async def catalog_entry_endpoint(widget: str, opts: dict = Body(default={})) -> JSONResponse:
        entry, errors, err = await _entry_for(widget, opts)
        if err is not None:
            return err
        return JSONResponse({"entry": entry, "valid": not errors, "errors": errors})

    @app.post("/studio/api/publish/{widget}")
    async def publish_endpoint(widget: str, spec: dict = Body(default={})) -> JSONResponse:
        import json

        entry, errors, err = await _entry_for(widget, spec)
        if err is not None:
            return err
        if errors:
            return JSONResponse(
                {"error": "catalog entry is invalid", "errors": errors, "entry": entry},
                status_code=422,
            )
        catalog = settings.catalog_path
        if catalog is None:
            return JSONResponse(
                {
                    "error": "no widget-catalog checkout found; "
                    "set STUDIO_CATALOG_PATH to a tesserae-widgets clone.",
                    "entry": entry,
                },
                status_code=400,
            )
        index = json.loads((catalog / "widgets.json").read_text())
        new_index = upsert_into_index(index, entry)
        replacing = any(w.get("id") == entry["id"] for w in index.get("widgets", []))
        registered = entry["id"] in (await _live_keys()) or widget in (await _live_keys())
        plan = {
            "dry_run": spec.get("dry_run", True) is not False,
            "target_repo": settings.catalog_repo,
            "branch": f"widget-{entry['id']}",
            "action": "update" if replacing else "add",
            "entry": entry,
            "files": {
                "widgets.json": json.dumps(new_index, indent=2) + "\n",
                f"screenshots/{entry['id']}/lg.png": (
                    "<render lg via /studio/api/render/{widget}.png?size=lg>"
                ),
            },
            "screenshot_ready": registered and (await app.state.source.status())["faithful"],
            "pr_title": f"{'Update' if replacing else 'Add'} {entry['name']} ({entry['id']})",
            "pr_body": _pr_body(entry),
        }
        if plan["dry_run"]:
            return JSONResponse({"ok": True, **plan})
        if spec.get("confirm") is not True:
            return JSONResponse(
                {
                    "error": "opening the real PR is gated. "
                    "Re-run with dry_run:false AND confirm:true. First publish the widget "
                    "to its own GitHub repo + tag the release so tarball_url resolves.",
                    **plan,
                },
                status_code=400,
            )
        # Real PR: fetch the lg screenshot, then clone/branch/commit/push/gh pr create.
        try:
            png, _ = await app.state.tesserae.render_png(widget, size="lg")
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(
                {
                    "error": "could not render the lg screenshot "
                    f"(register the widget + run Tesserae in debug): {exc}"
                },
                status_code=400,
            )
        try:
            res = await asyncio.to_thread(
                assemble_pr,
                settings.catalog_repo,
                entry,
                plan["files"]["widgets.json"],
                png,
                title=plan["pr_title"],
                body=plan["pr_body"],
                push=True,
            )
        except PublishError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(
            {"ok": True, "pr_url": res.get("pr_url"), "branch": res["branch"], "entry": entry}
        )

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
            bad = [
                {
                    "rule": "manifest-json",
                    "level": "error",
                    "message": f"plugin.json is not valid JSON: {exc}",
                    "file": "plugin.json",
                    "line": exc.lineno,
                }
            ]
            return JSONResponse({"widget": widget, "findings": bad, "errors": 1, "warnings": 0})
        if manifest.get("kind") not in (None, "widget"):
            # Companion plugins (data/admin) aren't widgets; the widget rules
            # (client.js, fragments, ...) don't apply.
            return JSONResponse(
                {
                    "widget": widget,
                    "findings": [],
                    "errors": 0,
                    "warnings": 0,
                    "note": f"companion plugin (kind {manifest.get('kind')}); "
                    "not linted as a widget",
                }
            )
        findings = lint_widget(files, manifest, schema=_load_schema())
        errors = sum(1 for f in findings if f["level"] == "error")
        return JSONResponse(
            {
                "widget": widget,
                "findings": findings,
                "errors": errors,
                "warnings": len(findings) - errors,
            }
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
