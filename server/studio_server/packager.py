"""Package a workspace widget into a gzipped tarball for the HTTP push path.

The tar's single top-level folder is the widget id, so Tesserae's installer
defaults the id to the folder name (see docs/tesserae-push-api.md). Caches and
VCS/editor cruft are excluded.
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

_IGNORE_DIRS = {"__pycache__", ".git", "node_modules", ".pytest_cache"}
_IGNORE_NAMES = {".DS_Store"}
_IGNORE_SUFFIXES = {".pyc"}


def package_widget(widget_dir: Path, widget_id: str) -> bytes:
    """Return the gzipped tar bytes of ``widget_dir``, rooted at ``widget_id/``."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path in sorted(widget_dir.rglob("*")):
            rel = path.relative_to(widget_dir)
            if any(part in _IGNORE_DIRS for part in rel.parts):
                continue
            if not path.is_file() or path.name in _IGNORE_NAMES or path.suffix in _IGNORE_SUFFIXES:
                continue
            tar.add(path, arcname=f"{widget_id}/{rel.as_posix()}")
    return buf.getvalue()
