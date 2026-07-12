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


@dataclass(frozen=True)
class Settings:
    tesserae_url: str
    port: int
    workdir: Path

    @classmethod
    def from_env(cls) -> "Settings":
        url = os.environ.get("STUDIO_TESSERAE_URL", "http://localhost:8765").rstrip("/")
        port = int(os.environ.get("STUDIO_PORT", "8770"))
        workdir = Path(os.environ.get("STUDIO_WORKDIR", "../widgets")).expanduser()
        return cls(tesserae_url=url, port=port, workdir=workdir)
