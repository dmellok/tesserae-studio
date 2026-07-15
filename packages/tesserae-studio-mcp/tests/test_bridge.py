"""Smoke tests for the tesserae-studio-mcp bridge.

These don't need a running Studio; they exercise the local plumbing (tool
registration, the instructions handshake, JSON/error handling)."""

from __future__ import annotations

import asyncio

import httpx

import tesserae_studio_mcp as bridge

_EXPECTED_TOOLS = {
    "studio_health",
    "list_widgets",
    "scaffold_widget",
    "scaffold_bundle",
    "scaffold_service",
    "duplicate_widget",
    "list_files",
    "read_file",
    "write_file",
    "edit_file",
    "design_system",
    "lint_widget",
    "mine_data_schema",
    "widget_data",
    "register_widget",
    "unregister_widget",
    "faithful_render",
    "screenshot_widget",
    "package_widget",
    "generate_catalog_entry",
    "open_catalog_pr",
}


def test_tools_register() -> None:
    tools = asyncio.run(bridge.mcp.list_tools())
    assert {t.name for t in tools} == _EXPECTED_TOOLS


def test_ships_build_loop_instructions() -> None:
    """The build loop is sent at handshake via FastMCP instructions, so it lives
    with the tools instead of being pasted into every project."""
    text = bridge.mcp.instructions or ""
    assert "BUILD LOOP" in text
    assert "scaffold_widget" in text
    assert "lint_widget until 0 errors" in text


def test_json_wraps_http_error() -> None:
    """A non-2xx response is returned as data (with a status), not raised, so the
    agent gets an actionable message."""
    bridge._client = httpx.AsyncClient(
        base_url="http://studio.test",
        transport=httpx.MockTransport(
            lambda req: httpx.Response(400, json={"error": "bad widget"})
        ),
    )
    try:
        result = asyncio.run(bridge._json("GET", "/studio/api/lint/nope"))
    finally:
        bridge._client = None
    assert result == {"error": "bad widget", "status": 400}


def test_json_wraps_unreachable() -> None:
    """A connection failure returns a friendly {error}, never an exception."""

    def _boom(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    bridge._client = httpx.AsyncClient(
        base_url="http://studio.test", transport=httpx.MockTransport(_boom)
    )
    try:
        result = asyncio.run(bridge._json("GET", "/studio/api/health"))
    finally:
        bridge._client = None
    assert "error" in result and "cannot reach Studio" in result["error"]
