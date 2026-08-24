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
    "delete_widget",
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


# -- served docs + version awareness ---------------------------------------


def _serve(payload, *, status: int = 200):
    """Patch the bridge's docs fetch to answer with `payload`, the way a
    reachable Studio would. The real one is a synchronous urllib call made once
    before the loop starts, so there is no client to mock."""
    import json as _json

    def fake() -> dict:
        if status != 200:
            return {}
        if not isinstance(payload, dict) or payload.get("schema") != bridge._DOCS_SCHEMA:
            return {}
        return _json.loads(_json.dumps(payload))

    return fake


def _with_docs(payload, *, status: int = 200):
    original_fetch = bridge._fetch_docs
    original_instructions = bridge.mcp.instructions
    manager = getattr(bridge.mcp, "_tool_manager")
    original_desc = {name: tool.description for name, tool in manager._tools.items()}
    bridge._fetch_docs = _serve(payload, status=status)
    try:
        bridge._apply_served_docs()
        yield
    finally:
        bridge._fetch_docs = original_fetch
        bridge.mcp._mcp_server.instructions = original_instructions
        for name, desc in original_desc.items():
            manager._tools[name].description = desc


def test_served_instructions_replace_the_embedded_copy() -> None:
    gen = _with_docs({"schema": bridge._DOCS_SCHEMA, "instructions": "SERVED COPY"})
    next(gen)
    try:
        assert bridge.mcp.instructions.startswith("SERVED COPY")
    finally:
        next(gen, None)


def test_an_unreachable_studio_keeps_the_embedded_copy() -> None:
    """Offline is a normal state for a local tool, not an error: the bridge must
    still hand the agent a full set of rules."""
    gen = _with_docs(None, status=500)
    next(gen)
    try:
        assert "BUILD LOOP" in (bridge.mcp.instructions or "")
    finally:
        next(gen, None)


def test_an_unknown_schema_is_treated_as_unreadable() -> None:
    """Half-understood docs are worse than known-stale ones, so a shape this
    bridge does not know falls back wholesale rather than per key."""
    gen = _with_docs({"schema": 99, "instructions": "FROM THE FUTURE"})
    next(gen)
    try:
        assert "FROM THE FUTURE" not in (bridge.mcp.instructions or "")
        assert "BUILD LOOP" in (bridge.mcp.instructions or "")
    finally:
        next(gen, None)


def test_served_tool_descriptions_override_the_docstring() -> None:
    gen = _with_docs(
        {
            "schema": bridge._DOCS_SCHEMA,
            "instructions": "x",
            "tool_docs": {"lint_widget": "SERVED DESCRIPTION"},
        }
    )
    next(gen)
    try:
        manager = getattr(bridge.mcp, "_tool_manager")
        assert manager._tools["lint_widget"].description == "SERVED DESCRIPTION"
        # A tool the server said nothing about keeps its own docstring.
        assert "workspace widget" in (manager._tools["list_files"].description or "").lower()
    finally:
        next(gen, None)


def test_a_tool_this_bridge_does_not_have_is_ignored() -> None:
    """A description with no implementation behind it would be worse than a
    missing one: the agent would call a tool that is not there."""
    gen = _with_docs(
        {"schema": bridge._DOCS_SCHEMA, "instructions": "x", "tool_docs": {"from_the_future": "hi"}}
    )
    next(gen)
    try:
        manager = getattr(bridge.mcp, "_tool_manager")
        assert "from_the_future" not in manager._tools
    finally:
        next(gen, None)


def test_a_newer_studio_appends_an_upgrade_note() -> None:
    gen = _with_docs(
        {
            "schema": bridge._DOCS_SCHEMA,
            "instructions": "rules",
            "bridge": {"latest": "99.0.0", "upgrade": "pipx upgrade tesserae-studio-mcp"},
        }
    )
    next(gen)
    try:
        text = bridge.mcp.instructions or ""
        assert "BRIDGE OUT OF DATE" in text
        assert "pipx upgrade tesserae-studio-mcp" in text
    finally:
        next(gen, None)


def test_a_level_or_newer_bridge_is_not_nagged() -> None:
    """Running the bridge from a clone puts it ahead of the released Studio.
    Telling that operator to "upgrade" to an older version would be wrong."""
    for latest in (bridge.__version__, "0.0.1"):
        assert bridge._upgrade_note({"latest": latest}) == ""


def test_an_unparseable_version_says_nothing() -> None:
    assert bridge._upgrade_note({"latest": "0.7.0.dev3"}) == ""
    assert bridge._upgrade_note({"latest": ""}) == ""
    assert bridge._upgrade_note(None) == ""


def test_the_bridge_names_itself_in_every_request() -> None:
    """Studio detects a connected bridge purely from this header."""
    bridge._client = None
    try:
        client = bridge._http()
        assert client.headers["user-agent"] == f"tesserae-studio-mcp/{bridge.__version__}"
    finally:
        bridge._client = None
