"""Where Studio gets Tesserae's assets, catalog, and preview data from.

Two sources, resolved per request so Studio degrades gracefully:

- **Disk** (``STUDIO_TESSERAE_PATH``, autodetected sibling ``tesserae``): serve
  static assets and widget files straight off the filesystem, and build the
  widget catalog by reading manifests. No running instance needed. This is what
  makes interactive preview standalone.
- **Live** (a running Tesserae): proxy assets, and use ``/api/mcp`` for the
  catalog and real ``fetch()`` data. Required only for live data and faithful
  (e-ink) render.

Interactive preview works from either source; disk is preferred for assets so
the fast path never depends on the network. Preview data comes from Tesserae's
own dev-gallery ``widget_samples`` when running against a disk checkout, so a
data-driven widget still previews without a live fetch.
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .proxy import forward
from .tesserae import TesseraeClient

# Fragment box defaults, matching Tesserae's app/panels_schema.py so disk-built
# fragments line up with what the live catalog would report.
_DEFAULT_W = 240
_DEFAULT_H = 160


def _safe_join(root: Path, rel: str) -> Path | None:
    """Join ``rel`` under ``root``, refusing anything that escapes it."""
    target = (root / rel.lstrip("/")).resolve()
    root_resolved = root.resolve()
    if target == root_resolved or root_resolved in target.parents:
        return target
    return None


def catalog_entry(key: str, manifest: dict[str, Any]) -> dict[str, Any]:
    """A catalog entry from a widget id + manifest. Shared by the disk catalog
    and the workspace so both surface widgets identically to the front end."""
    return {
        "key": key,
        "name": str(manifest.get("name") or key),
        "icon": str(manifest.get("icon") or "ph-puzzle-piece"),
        "desc": str(manifest.get("description") or ""),
        "fragments": _fragments_of(manifest),
    }


def _fragments_of(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """The widget's declared fragments, always including ``full``. Mirrors
    Tesserae's fragments_of so disk paths match the canvas."""
    out: list[dict[str, Any]] = []
    raw = manifest.get("fragments")
    if isinstance(raw, list):
        for frag in raw:
            if not isinstance(frag, dict):
                continue
            fid = frag.get("id")
            if not isinstance(fid, str) or not fid:
                continue
            entry: dict[str, Any] = {
                "id": fid,
                "label": str(frag.get("label") or fid),
                "w": frag["w"] if isinstance(frag.get("w"), int) else _DEFAULT_W,
                "h": frag["h"] if isinstance(frag.get("h"), int) else _DEFAULT_H,
            }
            icon = frag.get("icon")
            if isinstance(icon, str) and icon:
                entry["icon"] = icon
            out.append(entry)
    if not any(f["id"] == "full" for f in out):
        out.insert(0, {"id": "full", "label": "Full widget", "w": _DEFAULT_W, "h": _DEFAULT_H})
    return out


class TesseraeSource:
    def __init__(self, tesserae_path: Path | None, client: TesseraeClient) -> None:
        self.path = tesserae_path
        self.client = client

    @property
    def has_disk(self) -> bool:
        return self.path is not None

    async def status(self) -> dict[str, Any]:
        live = await self.client.probe_health()
        mcp = await self.client.probe_mcp() if live else False
        # Interactive preview needs a widget source: disk files or the live
        # catalog. Faithful render + real fetch() data need the live MCP API.
        return {
            "disk": self.has_disk,
            "live": live,
            "mcp": mcp,
            "interactive": self.has_disk or mcp,
            "faithful": mcp,
            "live_data": mcp,
        }

    # -- assets ------------------------------------------------------------
    async def serve_asset(self, request: Request, rel: str) -> Response:
        """Serve ``rel`` (e.g. ``static/style/base.css`` or
        ``plugins/clock/client.js``) from disk when available, else proxy the
        live instance."""
        if self.path is not None:
            target = _safe_join(self.path, rel)
            if target is not None and target.is_file():
                return FileResponse(target)
        return await forward(request, self.client.raw)

    # -- catalog -----------------------------------------------------------
    async def catalog(self) -> dict[str, Any]:
        if self.path is not None:
            return {"widgets": self._disk_catalog(), "appearance": {}, "source": "disk"}
        data = await self.client.catalog()
        data["source"] = "live"
        return data

    def _disk_catalog(self) -> list[dict[str, Any]]:
        assert self.path is not None
        plugins_dir = self.path / "plugins"
        entries: list[dict[str, Any]] = []
        for manifest_path in sorted(plugins_dir.glob("*/plugin.json")):
            widget_dir = manifest_path.parent
            if not (widget_dir / "client.js").is_file():
                continue  # not previewable without a client module
            try:
                manifest = json.loads(manifest_path.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if manifest.get("kind") != "widget":
                continue
            entries.append(catalog_entry(widget_dir.name, manifest))
        entries.sort(key=lambda e: str(e["name"]).lower())
        return entries

    # -- preview data ------------------------------------------------------
    async def widget_data(self, key: str) -> JSONResponse:
        """ctx.data for the interactive preview. Live MCP fetch when reachable;
        otherwise Tesserae's dev-gallery sample from the disk checkout."""
        status = await self.status()
        if status["mcp"]:
            try:
                res = await self.client.widget_data(key)
                return JSONResponse({**res, "source": "live"})
            except Exception:  # noqa: BLE001 - fall back to sample below
                pass
        sample = self._disk_sample(key)
        return JSONResponse({"data": sample, "source": "sample" if sample is not None else "none"})

    def _disk_sample(self, key: str) -> Any:
        if self.path is None:
            return None
        get_sample = _load_widget_samples(str(self.path))
        if get_sample is None:
            return None
        try:
            return get_sample(key)
        except Exception:  # noqa: BLE001 - sample is best-effort enrichment
            return None


@lru_cache(maxsize=4)
def _load_widget_samples(tesserae_path: str):
    """Import Tesserae's dev-gallery ``get_sample`` from a disk checkout, once.

    The module is pure-stdlib (hand-written payloads), so importing it here does
    not drag Flask into Studio's process. Returns None if unavailable so disk
    mode still works, just with null preview data."""
    if tesserae_path not in sys.path:
        sys.path.insert(0, tesserae_path)
    try:
        from app.widget_samples import get_sample  # type: ignore

        return get_sample
    except Exception:  # noqa: BLE001
        return None
