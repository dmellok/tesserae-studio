"""Client for the connected Tesserae instance.

Studio talks to Tesserae over HTTP (never by importing its Flask app) so it stays
decoupled and can point at a Tesserae on another host. This module owns the shared
``httpx.AsyncClient`` and the typed helpers Studio's own API uses; the raw
reverse-proxy lives in ``proxy.py``.
"""

from __future__ import annotations

from typing import Any

import httpx


class PushError(Exception):
    """A widget push/install failed. Carries the HTTP status and Tesserae's
    friendly ``{error}`` message so it can be surfaced verbatim."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class TesseraeClient:
    def __init__(
        self, base_url: str, *, mcp_token: str | None = None, timeout: float = 30.0
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.mcp_token = mcp_token
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    def _mcp_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        # Loopback is authed by Tesserae's MCP gate without a token; a token is
        # required for remote / HA (Ingress) callers.
        headers = dict(extra or {})
        if self.mcp_token:
            headers["Authorization"] = f"Bearer {self.mcp_token}"
        return headers

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
            resp = await self._client.get("/api/mcp/catalog", headers=self._mcp_headers())
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def catalog(self) -> dict[str, Any]:
        """Installed widgets (with fragments) + appearance options."""
        resp = await self._client.get("/api/mcp/catalog", headers=self._mcp_headers())
        resp.raise_for_status()
        return resp.json()

    # -- push / install (0.109+) ------------------------------------------
    async def push_available(self) -> bool:
        """True when the running Tesserae exposes the authored-widget push API."""
        try:
            resp = await self._client.get(
                "/api/mcp/widgets", params={"origin": "authored"}, headers=self._mcp_headers()
            )
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def install_widget(
        self, tar_bytes: bytes, *, widget_id: str | None = None, reload: str = "auto"
    ) -> dict[str, Any]:
        params = {"reload": reload}
        if widget_id:
            params["id"] = widget_id
        resp = await self._client.post(
            "/api/mcp/widgets/install",
            params=params,
            content=tar_bytes,
            headers=self._mcp_headers({"content-type": "application/gzip"}),
        )
        return self._json_or_push_error(resp)

    async def uninstall_widget(self, widget_id: str, *, reload: str = "auto") -> dict[str, Any]:
        resp = await self._client.request(
            "DELETE",
            f"/api/mcp/widgets/{widget_id}",
            params={"reload": reload},
            headers=self._mcp_headers(),
        )
        return self._json_or_push_error(resp)

    async def get_widget_settings(self, widget_id: str) -> dict[str, Any]:
        """A widget's stored settings (secret values redacted by Tesserae). Needs
        the settings MCP endpoint (Tesserae 0.11x+)."""
        resp = await self._client.get(
            f"/api/mcp/widgets/{widget_id}/settings", headers=self._mcp_headers()
        )
        return self._json_or_push_error(resp)

    async def set_widget_settings(self, widget_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Store a widget's settings (e.g. an API key) in Tesserae so its fetch()
        runs with real credentials. Needs the settings MCP endpoint."""
        resp = await self._client.put(
            f"/api/mcp/widgets/{widget_id}/settings",
            json={"settings": values},
            headers=self._mcp_headers(),
        )
        return self._json_or_push_error(resp)

    async def list_authored(self) -> list[dict[str, Any]]:
        resp = await self._client.get(
            "/api/mcp/widgets", params={"origin": "authored"}, headers=self._mcp_headers()
        )
        if resp.status_code != 200:
            return []
        return resp.json().get("widgets", [])

    async def reload_registry(self, mode: str = "auto") -> dict[str, Any]:
        resp = await self._client.post(
            "/api/mcp/reload", params={"mode": mode}, headers=self._mcp_headers()
        )
        return self._json_or_push_error(resp)

    async def render_png(
        self, widget_id: str, *, size: str = "lg", opts: str | None = None
    ) -> tuple[bytes, str]:
        params: dict[str, str] = {"size": size}
        if opts:
            params["opts"] = opts
        resp = await self._client.get(
            f"/api/mcp/widgets/{widget_id}/render.png", params=params, headers=self._mcp_headers()
        )
        if resp.status_code != 200:
            self._json_or_push_error(resp)  # raises PushError
        return resp.content, resp.headers.get("content-type", "image/png")

    @staticmethod
    def _json_or_push_error(resp: httpx.Response) -> dict[str, Any]:
        if resp.status_code >= 400:
            try:
                msg = resp.json().get("error", resp.text)
            except Exception:  # noqa: BLE001
                msg = resp.text or f"HTTP {resp.status_code}"
            raise PushError(resp.status_code, msg)
        return resp.json()

    async def widget_data(
        self, widget_id: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Live ``fetch()`` output + flattened ``fields`` for a widget.

        This is the endpoint ``mine_data_schema`` will reuse (Tesserae's
        ``_flatten_fields``); here it just feeds ``ctx.data`` for the interactive
        preview.
        """
        resp = await self._client.post(
            f"/api/mcp/widgets/{widget_id}/data",
            json={"options": options or {}},
            headers=self._mcp_headers(),
        )
        resp.raise_for_status()
        return resp.json()
