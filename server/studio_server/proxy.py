"""Reverse-proxy the asset / API / render paths a mounted widget reaches.

The browser only ever talks to Studio's origin. Anything under ``/api/mcp``,
``/static``, ``/plugins``, or ``/_test`` is forwarded to the connected Tesserae
under its real path, so root-relative URLs inside a widget's shadow root
(``/static/style/spectra-widgets.css``, ``/plugins/<id>/client.js``) resolve
unchanged and the interactive mount matches Tesserae exactly.
"""

from __future__ import annotations

import httpx
from fastapi import Request, Response

# Path prefixes forwarded verbatim to Tesserae. Kept in one place so app.py and
# the Vite dev-proxy config stay in sync with what the browser expects.
PROXY_PREFIXES: tuple[str, ...] = ("/api/mcp", "/static", "/plugins", "/_test")

# Hop-by-hop headers that must not be forwarded in either direction.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def _clean_headers(headers: httpx.Headers | dict) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in _HOP_BY_HOP}


async def forward(request: Request, client: httpx.AsyncClient) -> Response:
    """Forward ``request`` to Tesserae and return its response verbatim."""
    url = httpx.URL(path=request.url.path, query=request.url.query.encode("utf-8"))
    body = await request.body()
    upstream = client.build_request(
        method=request.method,
        url=url,
        headers=_clean_headers(request.headers),
        content=body,
    )
    try:
        resp = await client.send(upstream)
    except httpx.HTTPError as exc:
        return Response(
            content=f"Studio could not reach Tesserae: {exc}".encode(),
            status_code=502,
            media_type="text/plain",
        )
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=_clean_headers(resp.headers),
        media_type=resp.headers.get("content-type"),
    )
