"""FastAPI thin server: Studio's own API, disk-first asset serving, and a
reverse proxy to a live Tesserae for the paths that genuinely need one.

Run: ``uvicorn studio_server.app:app --port 8770 --reload``
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import SIZE_DIMENSIONS, Settings
from .proxy import forward
from .source import TesseraeSource
from .tesserae import TesseraeClient

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
                "sizes": {k: {"w": w, "h": h} for k, (w, h) in SIZE_DIMENSIONS.items()},
            }
        )

    @app.get("/studio/api/catalog")
    async def catalog() -> JSONResponse:
        try:
            return JSONResponse(await app.state.source.catalog())
        except Exception as exc:  # noqa: BLE001 - report, never 500 raw
            return JSONResponse(
                {"error": f"Catalog unavailable: {exc}", "widgets": [], "source": "none"},
                status_code=502,
            )

    @app.get("/studio/api/widgets/{key}/data")
    async def widget_data(key: str) -> JSONResponse:
        return await app.state.source.widget_data(key)

    # ---- Assets: disk-first, live-proxy fallback -------------------------
    async def _asset(request: Request):
        # request.url.path already includes the prefix (/static/... or
        # /plugins/...); the disk layout mirrors it, so pass it through whole.
        return await request.app.state.source.serve_asset(request, request.url.path)

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
