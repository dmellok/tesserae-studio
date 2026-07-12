"""Runtime configuration, resolved from environment variables.

Kept tiny and dependency-free so tests can construct a Settings without touching
the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

# Cell dimensions Tesserae uses for its size presets (app/composer.py
# SIZE_DIMENSIONS). Duplicated here so the front end can offer the same presets
# without a round-trip; the interactive mount also accepts arbitrary w/h.
SIZE_DIMENSIONS: dict[str, tuple[int, int]] = {
    "xs": (180, 180),
    "sm": (380, 240),
    "md": (640, 400),
    "lg": (1200, 800),
}


def _ha_options() -> dict:
    """Home Assistant add-on options. Supervisor writes the user's configured
    options to /data/options.json for every add-on; read them here so their
    values apply regardless of how the server process is launched. Empty for any
    non-HA install (the file is absent). Path overridable for tests."""
    import json

    path = os.environ.get("STUDIO_HA_OPTIONS", "/data/options.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def ha_options_debug() -> dict:
    """Diagnostic view of the HA add-on options file, safe to surface (key names
    only, never values). Answers 'is the file there, readable, and does it have
    tesserae_url?' without needing a shell in the container."""
    import json

    path = os.environ.get("STUDIO_HA_OPTIONS", "/data/options.json")
    info: dict = {"path": path, "exists": os.path.exists(path)}
    try:
        info["uid"] = os.getuid()
    except AttributeError:  # pragma: no cover - non-POSIX
        info["uid"] = None
    if info["exists"]:
        try:
            with open(path) as fh:
                data = json.load(fh)
            info["readable"] = True
            info["keys"] = sorted(data) if isinstance(data, dict) else []
        except Exception as exc:  # noqa: BLE001 - report why it failed
            info["readable"] = False
            info["error"] = type(exc).__name__
    return info


def _autodetect_tesserae_path() -> Path | None:
    """Best-effort sibling ``tesserae`` checkout next to this repo, so Studio
    runs standalone (disk assets + disk catalog) out of the box with no running
    instance. Returns None when no usable checkout is found."""
    repo_root = Path(__file__).resolve().parents[2]  # tesserae-studio/
    candidate = repo_root.parent / "tesserae"
    return candidate if _is_tesserae_checkout(candidate) else None


def _is_tesserae_checkout(path: Path) -> bool:
    return (path / "static").is_dir() and (path / "plugins").is_dir()


@dataclass(frozen=True)
class Settings:
    tesserae_url: str
    port: int
    workdir: Path
    # A tesserae checkout on disk. When present, Studio serves static assets and
    # builds the widget catalog from files, so interactive preview needs no
    # running instance. A live Tesserae is only required for real fetch() data
    # and faithful (e-ink) render.
    tesserae_path: Path | None
    # The connected Tesserae's data root. Its ``marketplace/`` subdir is an
    # additional plugins dir Tesserae scans, so symlinking a workspace widget
    # there (then restarting Tesserae) registers it for live data + faithful
    # render. None when unknown.
    tesserae_data_root: Path | None
    # MCP bearer token for the connected Tesserae. Loopback callers don't need
    # it; remote / HA (Ingress) callers do. From Settings -> System -> MCP.
    mcp_token: str | None
    # The widget catalog repo (for M6 publish). Local checkout for reading
    # widgets.json + the marketplace schema, and the GitHub slug for the PR.
    catalog_path: Path | None
    catalog_repo: str

    @property
    def marketplace_dir(self) -> Path | None:
        return (self.tesserae_data_root / "marketplace") if self.tesserae_data_root else None

    @property
    def tesserae_is_loopback(self) -> bool:
        """True when the connected Tesserae is on this host (so the local symlink
        path can register widgets). Remote instances must push over HTTP."""
        host = urlparse(self.tesserae_url).hostname or ""
        return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}

    @classmethod
    def from_env(cls) -> Settings:
        repo_root = Path(__file__).resolve().parents[2]  # tesserae-studio/
        # HA add-on options are a fallback layer under real env vars: an operator
        # who sets STUDIO_TESSERAE_URL directly still wins, otherwise the add-on's
        # tesserae_url / mcp_token option applies.
        ha = _ha_options()
        url = (
            os.environ.get("STUDIO_TESSERAE_URL")
            or (ha.get("tesserae_url") if isinstance(ha.get("tesserae_url"), str) else None)
            or "http://localhost:8765"
        ).rstrip("/")
        port = int(os.environ.get("STUDIO_PORT", "8770"))
        # Widgets being authored live here. Defaults to the repo's tracked
        # examples/ so the editor always has something to open; point it at a
        # scratch dir for real authoring.
        raw_workdir = os.environ.get("STUDIO_WORKDIR")
        workdir = Path(raw_workdir).expanduser() if raw_workdir else repo_root / "examples"

        raw_path = os.environ.get("STUDIO_TESSERAE_PATH")
        if raw_path:
            path: Path | None = Path(raw_path).expanduser()
            if not _is_tesserae_checkout(path):  # explicit but wrong: warn by ignoring
                path = None
        else:
            path = _autodetect_tesserae_path()

        # Tesserae's data root: explicit env, else <checkout>/data (its default
        # when TESSERAE_DATA_ROOT is unset). Used to register synced widgets.
        raw_data_root = os.environ.get("STUDIO_TESSERAE_DATA_ROOT")
        if raw_data_root:
            data_root: Path | None = Path(raw_data_root).expanduser()
        elif path is not None:
            data_root = path / "data"
        else:
            data_root = None

        token = (
            os.environ.get("STUDIO_TESSERAE_MCP_TOKEN")
            or (ha.get("mcp_token") if isinstance(ha.get("mcp_token"), str) else None)
            or None
        )

        raw_catalog = os.environ.get("STUDIO_CATALOG_PATH")
        if raw_catalog:
            catalog_path: Path | None = Path(raw_catalog).expanduser()
        else:
            sibling = repo_root.parent / "tesserae-widgets"
            catalog_path = sibling if (sibling / "widgets.json").is_file() else None
        catalog_repo = os.environ.get("STUDIO_CATALOG_REPO", "dmellok/tesserae-widgets")

        return cls(
            tesserae_url=url,
            port=port,
            workdir=workdir,
            tesserae_path=path,
            tesserae_data_root=data_root,
            mcp_token=token,
            catalog_path=catalog_path,
            catalog_repo=catalog_repo,
        )
