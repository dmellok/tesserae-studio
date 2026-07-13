"""A tiny in-process pub/sub so the browser can live-reload when the workspace
changes, whoever made the change, the human in the editor or an agent driving the
MCP tools (which go through the same REST API). One event bus per app; the SSE
endpoint subscribes a queue and streams events to each connected browser.
"""

from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        """Fan out to every subscriber. Drops the event for any queue that has
        backed up (a dead/slow browser) rather than blocking the mutation."""
        for q in list(self._subs):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass
