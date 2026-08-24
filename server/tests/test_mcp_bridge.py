"""Bridge-version awareness: which tesserae-studio-mcp called, and is it stale.

The bridge is installed separately from Studio, so an operator can sit on an old
one indefinitely without noticing. It names itself in every request's
``User-Agent``, so the server records that, reports it on ``/studio/api/health``,
and hands its own idea of "current" to the bridge over the instructions
endpoint.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_server import mcp_bridge, mcp_docs
from studio_server.app import create_app
from studio_server.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]
_UA = f"tesserae-studio-mcp/{mcp_bridge.EXPECTED_VERSION}"


@pytest.fixture
def client(tmp_path):
    mcp_bridge.reset()
    settings = Settings(
        tesserae_url="http://tess.test",
        port=8770,
        workdir=tmp_path / "work",
        tesserae_path=None,
        tesserae_data_root=None,
        mcp_token=None,
        catalog_path=None,
        catalog_repo="dmellok/tesserae-widgets",
    )
    with TestClient(create_app(settings)) as c:
        yield c
    mcp_bridge.reset()


# -- the constant tracks the shipped bridge ---------------------------------


def test_expected_version_matches_the_bridge_in_this_repo() -> None:
    """Studio's idea of "current" is a constant, so it can answer without a
    network call. This is the check that stops it going stale: bump the bridge
    and this fails until EXPECTED_VERSION follows."""
    source = (
        REPO_ROOT / "packages" / "tesserae-studio-mcp" / "tesserae_studio_mcp" / "__init__.py"
    ).read_text(encoding="utf-8")
    match = re.search(r'^__version__ = "([^"]+)"', source, re.MULTILINE)
    assert match, "couldn't find __version__ in the bridge package"
    assert match.group(1) == mcp_bridge.EXPECTED_VERSION, (
        "studio_server/mcp_bridge.py EXPECTED_VERSION is out of step with "
        "packages/tesserae-studio-mcp; bump it alongside the bridge."
    )


def test_the_packaged_version_matches_its_own_metadata() -> None:
    """The wheel's version and the module constant are two places one number
    lives; a release that moves only one ships a bridge that misreports itself."""
    pyproject = (REPO_ROOT / "packages" / "tesserae-studio-mcp" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    assert f'version = "{mcp_bridge.EXPECTED_VERSION}"' in pyproject


# -- recording --------------------------------------------------------------


def test_a_bridge_call_records_its_version(client) -> None:
    client.get("/studio/api/health", headers={"User-Agent": "tesserae-studio-mcp/0.1.0"})

    status = mcp_bridge.status()
    assert status["seen"] is True
    assert status["version"] == "0.1.0"
    assert status["update_available"] is True


def test_nothing_is_recorded_before_a_bridge_connects(client) -> None:
    # The UI hangs its line off "seen": a Studio driven only from the browser
    # should show nothing, not an empty card.
    client.get("/studio/api/health")

    assert mcp_bridge.status()["seen"] is False


def test_a_current_bridge_reports_no_update(client) -> None:
    client.get("/studio/api/health", headers={"User-Agent": _UA})

    status = mcp_bridge.status()
    assert status["version"] == mcp_bridge.EXPECTED_VERSION
    assert status["update_available"] is False


def test_a_bridge_ahead_of_us_is_not_nagged(client) -> None:
    """Someone running the bridge from a clone can be ahead of the constant.
    Telling them to upgrade to an older version would be wrong."""
    client.get("/studio/api/health", headers={"User-Agent": "tesserae-studio-mcp/99.0.0"})

    assert mcp_bridge.status()["update_available"] is False


def test_a_browser_is_not_a_bridge(client) -> None:
    """The Studio web UI hits the same API. Recording it would show the operator
    a bridge that does not exist."""
    client.get("/studio/api/health", headers={"User-Agent": "Mozilla/5.0 (Macintosh)"})

    assert mcp_bridge.status()["seen"] is False


def test_a_malformed_user_agent_records_nothing_and_does_not_fail(client) -> None:
    resp = client.get("/studio/api/health", headers={"User-Agent": "tesserae-studio-mcp/"})

    assert resp.status_code == 200
    assert mcp_bridge.status()["seen"] is False


def test_health_reports_the_connected_bridge(client) -> None:
    client.get("/studio/api/health", headers={"User-Agent": "tesserae-studio-mcp/0.1.0"})

    body = client.get("/studio/api/health").json()

    assert body["bridge"]["seen"] is True
    assert body["bridge"]["version"] == "0.1.0"
    assert body["bridge"]["latest"] == mcp_bridge.EXPECTED_VERSION
    assert body["bridge"]["upgrade"] == mcp_bridge.UPGRADE_COMMAND
    assert body["bridge"]["update_available"] is True


# -- served docs ------------------------------------------------------------


def test_instructions_endpoint_serves_the_handshake_copy(client) -> None:
    payload = client.get("/studio/api/mcp/instructions").json()

    assert payload["schema"] == mcp_docs.DOCS_SCHEMA
    assert payload["instructions"] == mcp_docs.INSTRUCTIONS
    assert "BUILD LOOP" in payload["instructions"]


def test_instructions_endpoint_names_the_shipped_bridge(client) -> None:
    payload = client.get("/studio/api/mcp/instructions").json()

    assert payload["bridge"]["latest"] == mcp_bridge.EXPECTED_VERSION
    assert payload["bridge"]["upgrade"] == mcp_bridge.UPGRADE_COMMAND


def test_instructions_endpoint_carries_a_description_for_every_tool(client) -> None:
    """The point of serving these is that a description fix reaches an installed
    bridge. A tool missing from the map silently keeps whatever text shipped in
    the wheel, so the gap has to fail here."""
    payload = client.get("/studio/api/mcp/instructions").json()
    served = payload["tool_docs"]

    assert set(served) == _bridge_tool_names()
    assert all(text.strip() for text in served.values())


def _bridge_tool_names() -> set[str]:
    """The tools the published bridge registers, read from its source. Read
    rather than imported so this test says something even in an environment
    without the package installed."""
    import ast

    source = (
        REPO_ROOT / "packages" / "tesserae-studio-mcp" / "tesserae_studio_mcp" / "__init__.py"
    ).read_text(encoding="utf-8")
    names: set[str] = set()
    for node in ast.parse(source).body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        for dec in node.decorator_list:
            func = dec.func if isinstance(dec, ast.Call) else dec
            if isinstance(func, ast.Attribute) and func.attr == "tool":
                names.add(node.name)
    assert names, "couldn't find any @mcp.tool() functions in the bridge"
    return names


def test_the_served_docs_describe_the_current_contract(client) -> None:
    """The instructions are the only place the authoring agent learns the widget
    contract, so the rules that changed under it have to be in there."""
    text = client.get("/studio/api/mcp/instructions").json()["instructions"]

    assert "plugin:ha_core" in text  # delegate capability, not "omit requires"
    assert "on_schedule" in text and "selector_option" in text
    assert "fill_from" in text
    assert "no render.per_device_id" in text
