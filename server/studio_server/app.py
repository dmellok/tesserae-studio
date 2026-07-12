"""FastAPI thin server: Studio's own API + a reverse proxy to Tesserae.

Run: ``uvicorn studio_server.app:app --port 8770 --reload``
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import SIZE_DIMENSIONS, Settings
from .proxy import PROXY_PREFIXES, forward
from .tesserae import TesseraeClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = app.state.settings
    app.state.tesserae = TesseraeClient(settings.tesserae_url)
    try:
        yield
    finally:
        await app.state.tesserae.aclose()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="tesserae-studio", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings

    # ---- Studio's own API -------------------------------------------------
    @app.get("/studio/api/health")
    async def health() -> JSONResponse:
        client = app.state.tesserae
        up = await client.probe_health()
        mcp = await client.probe_mcp() if up else False
        return JSONResponse(
            {
                "studio": "ok",
                "tesserae": "ok" if up else "unreachable",
                # "off" == Tesserae is up but the mcp experiment is disabled, so
                # the catalog/preview data won't load until it's switched on.
                "mcp": "ok" if mcp else ("off" if up else "unreachable"),
                "url": settings.tesserae_url,
            }
        )

    @app.get("/studio/api/config")
    async def config() -> JSONResponse:
        return JSONResponse(
            {
                "tesserae_url": settings.tesserae_url,
                "sizes": {k: {"w": w, "h": h} for k, (w, h) in SIZE_DIMENSIONS.items()},
                "features": {"faithful_preview": False, "editor": False, "mcp": False},
            }
        )

    @app.get("/studio/api/catalog")
    async def catalog() -> JSONResponse:
        try:
            return JSONResponse(await app.state.tesserae.catalog())
        except Exception as exc:  # noqa: BLE001 - report, never 500 raw
            return JSONResponse(
                {"error": f"Tesserae catalog unavailable: {exc}", "widgets": []},
                status_code=502,
            )

    # ---- Reverse proxy to Tesserae ---------------------------------------
    async def _proxy(request: Request):
        return await forward(request, request.app.state.tesserae.raw)

    for prefix in PROXY_PREFIXES:
        app.add_api_route(
            prefix + "/{path:path}",
            _proxy,
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        )
        # Also match the bare prefix (e.g. GET /_test/render has no sub-path
        # segment beyond the route, but /api/mcp/catalog does; keep both).
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
