"""Register a workspace widget with the connected Tesserae by symlinking it into
Tesserae's ``marketplace/`` plugins dir, the same mechanism Tesserae's own
marketplace uses. Once registered (Tesserae picks up new plugins on restart, so
a restart is needed the first time), the widget gets live ``fetch()`` data and
faithful ``/_test/render`` output.

Guarded: sync refuses to clobber a non-Studio entry, and unsync only ever
removes a symlink that points back at the workspace widget, never a real folder
or a foreign symlink.
"""

from __future__ import annotations

import os
from pathlib import Path


class SyncError(Exception):
    """A bad sync/unsync request."""


def _target(workspace_root: Path, key: str) -> Path:
    return (workspace_root / key).resolve()


def is_synced(marketplace_dir: Path | None, workspace_root: Path, key: str) -> bool:
    """True when ``marketplace/<key>`` is our symlink back to the workspace."""
    if marketplace_dir is None:
        return False
    link = marketplace_dir / key
    if not link.is_symlink():
        return False
    try:
        return link.resolve() == _target(workspace_root, key)
    except OSError:
        return False


def sync(marketplace_dir: Path | None, workspace_root: Path, key: str) -> None:
    if marketplace_dir is None:
        raise SyncError("Tesserae data root is unknown; set STUDIO_TESSERAE_DATA_ROOT.")
    target = _target(workspace_root, key)
    if not (target / "plugin.json").is_file():
        raise SyncError(f"{key} is not a workspace widget.")
    marketplace_dir.mkdir(parents=True, exist_ok=True)
    link = marketplace_dir / key
    if link.is_symlink() or link.exists():
        if link.is_symlink() and _resolves_to(link, target):
            return  # already synced, idempotent
        raise SyncError(f"{key} already exists in the Tesserae marketplace and is not a Studio symlink.")
    os.symlink(target, link)


def unsync(marketplace_dir: Path | None, workspace_root: Path, key: str) -> None:
    if marketplace_dir is None:
        raise SyncError("Tesserae data root is unknown.")
    link = marketplace_dir / key
    if not link.is_symlink():
        raise SyncError(f"{key} is not synced.")
    if not _resolves_to(link, _target(workspace_root, key)):
        raise SyncError(f"refusing to remove {key}: it does not point at the workspace widget.")
    link.unlink()


def _resolves_to(link: Path, target: Path) -> bool:
    try:
        return link.resolve() == target
    except OSError:
        return False
