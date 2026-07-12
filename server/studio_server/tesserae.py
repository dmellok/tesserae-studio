"""Client for the connected Tesserae instance.

Studio talks to Tesserae over HTTP (never by importing its Flask app) so it stays
decoupled and can point at a Tesserae on another host. This module owns the shared
``httpx.AsyncClient`` and the typed helpers Studio's own API uses; the raw
reverse-proxy lives in ``proxy.py``.
"""

from __future__ import annotations

from typing import Any

import httpx


class TesseraeClient:
    def __init__(self, base_url: str, *, timeout: float = 15.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    @property
    def raw(self) -> httpx.AsyncClient:
        """The underlying client, used by the reverse proxy."""
        return self._client

    async def probe_health(self) -> bool:
        """True when Tesserae is up. Uses the always-open ``/healthz`` so
        liveness is independent of auth and the (opt-in) ``mcp`` experiment."""
        try:
            resp = await self._client.get("/healthz")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def probe_mcp(self) -> bool:
        """True when the Tesserae MCP API answers. It 404s until the ``mcp``
        experiment is enabled (Settings -> System -> MCP, or
        ``TESSERAE_EXPERIMENT_MCP=1``), so this is Studio's signal that the
        widget catalog and preview data are actually reachable."""
        try:
            resp = await self._client.get("/api/mcp/catalog")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def catalog(self) -> dict[str, Any]:
        """Installed widgets (with fragments) + appearance options."""
        resp = await self._client.get("/api/mcp/catalog")
        resp.raise_for_status()
        return resp.json()

    async def widget_data(self, widget_id: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        """Live ``fetch()`` output + flattened ``fields`` for a widget.

        This is the endpoint ``mine_data_schema`` will reuse (Tesserae's
        ``_flatten_fields``); here it just feeds ``ctx.data`` for the interactive
        preview.
        """
        resp = await self._client.post(
            f"/api/mcp/widgets/{widget_id}/data",
            json={"options": options or {}},
        )
        resp.raise_for_status()
        return resp.json()
