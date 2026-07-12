"""Runtime configuration, resolved from environment variables.

Kept tiny and dependency-free so tests can construct a Settings without touching
the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Cell dimensions Tesserae uses for its size presets (app/composer.py
# SIZE_DIMENSIONS). Duplicated here so the front end can offer the same presets
# without a round-trip; the interactive mount also accepts arbitrary w/h.
SIZE_DIMENSIONS: dict[str, tuple[int, int]] = {
    "xs": (180, 180),
    "sm": (380, 240),
    "md": (640, 400),
    "lg": (1200, 800),
}


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

    @classmethod
    def from_env(cls) -> "Settings":
        url = os.environ.get("STUDIO_TESSERAE_URL", "http://localhost:8765").rstrip("/")
        port = int(os.environ.get("STUDIO_PORT", "8770"))
        workdir = Path(os.environ.get("STUDIO_WORKDIR", "../widgets")).expanduser()

        raw_path = os.environ.get("STUDIO_TESSERAE_PATH")
        if raw_path:
            path: Path | None = Path(raw_path).expanduser()
            if not _is_tesserae_checkout(path):  # explicit but wrong: warn by ignoring
                path = None
        else:
            path = _autodetect_tesserae_path()

        return cls(tesserae_url=url, port=port, workdir=workdir, tesserae_path=path)
