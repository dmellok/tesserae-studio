"""The working directory of widgets being authored.

Owns the file surface Monaco edits: list widgets, list a widget's files, read
and write a file. Every path is resolved and confined under the workdir, so a
crafted ``widget``/``relpath`` can't escape it. Widgets here are editable and
take precedence over the read-only tesserae checkout when previewing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Files/dirs never surfaced or written, keeps the tree clean and avoids letting
# the editor stomp on caches or VCS metadata.
_IGNORE_DIRS = {"__pycache__", ".git", "node_modules", ".pytest_cache"}
_IGNORE_SUFFIXES = {".pyc"}
# Editable text files a widget is made of. Anything else (images, fonts) is
# listed but not opened as text by the editor.
_TEXT_SUFFIXES = {".py", ".js", ".json", ".css", ".html", ".txt", ".md", ".svg"}
_MAX_FILE_BYTES = 512 * 1024


class WorkspaceError(Exception):
    """A bad request against the workspace (missing widget, escaping path)."""


class Workspace:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    # -- resolution --------------------------------------------------------
    def _widget_dir(self, widget: str) -> Path:
        target = (self.root / widget).resolve()
        if target.parent != self.root or not target.is_dir():
            raise WorkspaceError(f"unknown widget: {widget}")
        return target

    def _file_path(self, widget: str, relpath: str) -> Path:
        wdir = self._widget_dir(widget)
        target = (wdir / relpath).resolve()
        if target != wdir and wdir not in target.parents:
            raise WorkspaceError(f"path escapes widget: {relpath}")
        return target

    def resolve_plugin_asset(self, url_path: str) -> Path | None:
        """Map a ``/plugins/<widget>/<rel>`` URL to a workspace file, or None
        when this widget isn't in the workspace. Lets a widget being authored
        shadow the read-only tesserae checkout when previewing."""
        parts = url_path.strip("/").split("/", 2)
        if len(parts) < 3 or parts[0] != "plugins":
            return None
        widget, rel = parts[1], parts[2]
        try:
            target = self._file_path(widget, rel)
        except WorkspaceError:
            return None
        return target if target.is_file() else None

    # -- reads -------------------------------------------------------------
    def list_widgets(self) -> list[dict[str, Any]]:
        """Editable widgets in the workdir, each with identity + fragments so
        they merge into the catalog. A widget is any folder with a plugin.json
        of kind ``widget``."""
        if not self.root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for manifest_path in sorted(self.root.glob("*/plugin.json")):
            wdir = manifest_path.parent
            try:
                manifest = json.loads(manifest_path.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            if manifest.get("kind") != "widget":
                continue
            out.append({"key": wdir.name, "manifest": manifest})
        return out

    def list_files(self, widget: str) -> list[dict[str, Any]]:
        wdir = self._widget_dir(widget)
        files: list[dict[str, Any]] = []
        for path in sorted(wdir.rglob("*")):
            if any(part in _IGNORE_DIRS for part in path.relative_to(wdir).parts):
                continue
            if not path.is_file() or path.suffix in _IGNORE_SUFFIXES:
                continue
            rel = path.relative_to(wdir).as_posix()
            files.append(
                {
                    "path": rel,
                    "size": path.stat().st_size,
                    "editable": path.suffix in _TEXT_SUFFIXES,
                    "language": _language_for(path.suffix),
                }
            )
        return files

    def read_file(self, widget: str, relpath: str) -> str:
        target = self._file_path(widget, relpath)
        if not target.is_file():
            raise WorkspaceError(f"no such file: {relpath}")
        if target.stat().st_size > _MAX_FILE_BYTES:
            raise WorkspaceError(f"file too large to edit: {relpath}")
        return target.read_text()

    # -- writes ------------------------------------------------------------
    def write_file(self, widget: str, relpath: str, content: str) -> dict[str, Any]:
        target = self._file_path(widget, relpath)
        if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
            raise WorkspaceError(f"content too large: {relpath}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return {"path": relpath, "size": target.stat().st_size}


def _language_for(suffix: str) -> str:
    return {
        ".py": "python",
        ".js": "javascript",
        ".json": "json",
        ".css": "css",
        ".html": "html",
        ".md": "markdown",
        ".svg": "xml",
    }.get(suffix, "plaintext")
