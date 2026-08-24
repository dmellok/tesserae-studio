"""Which tesserae-studio-mcp bridge is talking to us, and whether it is stale.

The bridge is installed separately (``pipx install tesserae-studio-mcp``) and
points at whatever Studio happens to be running, so the two versions drift
freely and nothing told the operator. Most of what an agent reads is served live
from :mod:`studio_server.mcp_docs`, so a corrected rule needs no release at all;
what cannot be served is the tool LIST and the bridge's own result handling, and
those move only when a wheel does.

Every bridge call identifies itself as ``User-Agent:
tesserae-studio-mcp/<version>``, so the answer is already on the wire.
:func:`record` stashes what called and when, :func:`status` compares it against
:data:`EXPECTED_VERSION` (the bridge that ships in this repo), and the Studio UI
shows a line once something has actually connected. Nothing appears before then,
so a Studio driven only from the browser never sees it.

Deliberately in-memory, unlike Tesserae's equivalent, which persists to its
settings store. Studio is a local tool with no settings store and a process
lifetime measured in one authoring session; a note that resets on restart is
accurate for exactly as long as it is useful, and inventing a persistence layer
to remember which bridge called yesterday would be the larger mistake.
"""

from __future__ import annotations

import re
import time
from typing import Any

# The bridge version this Studio ships alongside. Both live in this repo
# (``packages/tesserae-studio-mcp``), so the server knows what "current" means
# without a network call; a test fails the build if the two drift.
EXPECTED_VERSION = "0.7.0"

UPGRADE_COMMAND = "pipx upgrade tesserae-studio-mcp"

# ``tesserae-studio-mcp/0.7.0``. Anything else (a browser, curl, the Studio web
# UI itself) is not a bridge and is ignored rather than recorded as one.
_UA_RE = re.compile(r"^tesserae-studio-mcp/(\d[A-Za-z0-9.+-]*)$")

_CLIENT_MAX = 80

_seen: dict[str, Any] = {}


def reset() -> None:
    """Forget the last-seen bridge. For tests; nothing in the app calls it."""
    _seen.clear()


def record(user_agent: str | None) -> None:
    """Note a bridge call. A no-op for any other client.

    Called from a middleware on every Studio API request, so it must stay cheap
    and must never raise: a malformed header is a reason to record nothing, not
    to fail the request the operator was making."""
    if not user_agent:
        return
    client = user_agent.strip()[:_CLIENT_MAX]
    match = _UA_RE.match(client)
    if not match:
        return
    _seen.update({"version": match.group(1), "client": client, "at": time.time()})


def version_tuple(text: str) -> tuple[int, ...] | None:
    """``"0.7.0"`` -> ``(0, 7, 0)``; None if it isn't plain dotted numbers.

    Strict on purpose. A version this cannot read means "say nothing", which is
    the right answer for a bridge built from a branch: guessing an ordering off
    something like ``0.7.0.dev3`` would nag an operator who is deliberately
    ahead."""
    parts = text.strip().split(".")
    if not parts or not all(p.isdigit() for p in parts):
        return None
    return tuple(int(p) for p in parts)


def status() -> dict[str, Any]:
    """What to show the operator about the connected bridge.

    ``seen`` is false until something has actually connected, and the UI hangs
    the whole line off that: a Studio nobody has pointed an agent at should say
    nothing rather than show an empty card.

    ``update_available`` is true only when we are sure. A bridge level with us,
    or ahead of us (running from a clone), is not out of date, and neither is one
    whose version we could not parse."""
    if not _seen:
        return {
            "seen": False,
            "version": "",
            "client": "",
            "at": None,
            "latest": EXPECTED_VERSION,
            "upgrade": UPGRADE_COMMAND,
            "update_available": False,
        }
    theirs = version_tuple(str(_seen.get("version") or ""))
    mine = version_tuple(EXPECTED_VERSION)
    return {
        "seen": True,
        "version": str(_seen.get("version") or ""),
        "client": str(_seen.get("client") or ""),
        "at": _seen.get("at"),
        "latest": EXPECTED_VERSION,
        "upgrade": UPGRADE_COMMAND,
        "update_available": bool(theirs and mine and theirs < mine),
    }
