"""tesserae-studio-mcp, the stdio MCP bridge for authoring Tesserae widgets.

A thin client over a running Tesserae Studio server's local REST API (the same
backend the Studio web UI uses). It exposes the widget-authoring loop as MCP
tools so an agent (Claude Code / Desktop, or any MCP client) can scaffold, edit,
lint, mine a data schema, register to a running Tesserae, and preview, end to
end. Studio ships no LLM of its own; whatever MCP client connects is the author.

Point it at a running Studio server with ``STUDIO_URL`` (default
http://localhost:8770). Run it as ``tesserae-studio-mcp`` (console script) or
``python -m tesserae_studio_mcp``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP, Image

__version__ = "0.5.0"

STUDIO_URL = os.environ.get("STUDIO_URL", "http://localhost:8770").rstrip("/")

# Sent to the connecting agent at handshake so it drives the build loop the way
# that actually works against Tesserae (these rules were learned the hard way).
_INSTRUCTIONS = """\
You build Tesserae widgets through these tools (mcp__tesserae-studio__*). Follow this loop and these rules.

BUILD LOOP
1. scaffold_widget(name, archetype, server=true). Archetypes: stat|list|chart|status|weather|calendar|image.
2. Read the generated files to learn the skeleton, then edit with write_file (whole-file overwrite, no partial edit).
3. lint_widget until 0 errors.
4. register_widget. A new widget serves its client.js immediately on the in-process reload, no restart (Tesserae reads the plugin registry fresh per request as of the plugin-asset fix). ONE EXCEPTION: a widget that declares an admin blueprint() still needs a single Tesserae restart to wire its admin route, so batch those, register all of them, then ask the user for one restart. Widget UPDATES (already-registered) never need a restart.
5. faithful_render(size=xs|sm|md|lg, options={...}). Pass options to QA a configured state. Base font scales with container WIDTH, so also check extreme aspect ratios (wide-short cells overflow in ways the xs/sm size tokens don't reveal), not just size. For live data across all sizes/fragments, build a canvas via the tesserae MCP and render_preview.
6. mine_data_schema(apply=true) once the data shape is final.

LEARN FROM SIBLINGS
- read_file / list_files also work on the connected checkout's REFERENCE widgets (e.g. ha_core, ha_history). Read a family's server.py + client.js to copy its data pattern and house style, don't guess.
- design_system(name) returns the Spectra house-style CSS: spectra-widgets (widget classes like .w-title / list rows / .is-zebra), spectra-tokens (--space-*, --fs-*), spectra-styles. Match these on the first pass.
- edit_file(widget, path, old, new) makes a one-line change without resending the whole file.

DIAGNOSING A FAILED / BLANK RENDER (do this before re-editing client.js)
- Confirm the server side first with probe_widget_data: if it returns your real output (or your friendly error), server.py is loaded, so the problem is in client.js, fix the JS.
- "Failed to fetch dynamically imported module .../client.js" now almost always means a genuine JS error (syntax, bad import path), not a reload gate. The only remaining reload case is a brand-new widget that declares an admin blueprint() (needs one restart).

HARD RULES
- Lint: data_schema.fields[].type must be num | str | arr (never "int"). server.py must NEVER use `raise`, return {"error": "..."} or thread (value, error) tuples.
- select / multiselect cell_options: the choice list key is "choices" (or "choices_from"), NOT "options". A mis-named key parses but the config dropdown renders empty (the linter now flags this); verify with get_widget_options.
- Secrets (API keys) = settings[] with "secret": true, settings.get(...). Per-cell config = cell_options[], options.get(...).
- Egress: an own-host widget declares requires: ["network:<exact-host>", "settings:plugin"], caches in ctx["data_dir"], and returns friendly error strings (they render verbatim). EXCEPTION: a widget that reads a shared family core (e.g. ha_core via current_app.config["PLUGIN_REGISTRY"].get("ha_core")) OMITS requires and declares no host, the core owns egress. Mirror the family; do not add network requires.
- Pure client-side widgets (generative art, clocks, countdowns) need no data binding: server.py may return a tiny dict (e.g. a UTC day/seed for deterministic-per-day output) or you skip live data. Don't invent a fetch the widget doesn't need.
- client.js: default export render(shadow, ctx); paint ONLY from Spectra semantic tokens (--surface, --surface-sunken, --text-primary/-secondary/-muted, --accent-1..6 + --accent-*-soft); no hardcoded hex in CSS/style strings (a genuine literal like white-on-a-fixed-scrim needs a /* identity */ comment on that line; hex in a JS data array/palette is fine); cqmin / container queries; ph-bold icons; no borders, no animations, no client-side fetch; idempotent innerHTML; link /static/style/spectra-widgets.css. fragments[] and branch on ctx.cell.fragment for canvas-placeable pieces (declare NO fragments for one indivisible view rather than an unused one).
- Full-bleed / edge-to-edge art: one square SVG viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" inside a container-type:size wrapper (width/height 100%, overflow hidden) fills any cell aspect ratio without distortion.

DATA REALISM (before coding)
- Check what the API returns for a plain key. If a requested stat needs OAuth/analytics or history the API doesn't expose, say so and adapt (self-track snapshots in data_dir for deltas; swap an impossible metric for an honest one). Flag substitutions.

AUTHORITATIVE SPEC: the tesserae repo docs/widgets.md + docs/dev/writing-a-widget.md.

SUBMISSION (community catalog, keyed/third-party widgets). Creating a public repo, release, or PR is outward and gated: ASK the user before creating anything public.
- Each widget is its OWN public repo tesserae-widget-<slug> (files at ROOT, AGPL-3.0), tagged vX.Y.Z.
- release.tarball_url is the GitHub SOURCE ARCHIVE (.../archive/refs/tags/vX.Y.Z.tar.gz) and release.sha256 is the sha256 of THAT archive (stable/reproducible), NOT package_widget's tarball.
- Tags are a CLOSED enum (calendar, clock, finance, github, home-assistant, media, news, sports, transit, utility, weather); generative / art / picture widgets use "media". Description <= 280 chars.
- generate_catalog_entry validates against the real schema and rejects unknown tags. Then PR to dmellok/tesserae-widgets: entry in widgets.json (2-space indent, alphabetical by id; key order id,name,description,icon,author,tags,kind,tesserae_compat,official,screenshot_sizes,release,source) plus screenshots/<id>/lg.png (1200x800; required, CI rejects without it).
- Screenshots MUST come from Tesserae's faithful renderer (faithful_render), never a hand-rasterized SVG or a local headless browser.
"""

mcp = FastMCP("tesserae-studio", instructions=_INSTRUCTIONS)

_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=STUDIO_URL, timeout=90.0)
    return _client


async def _json(method: str, path: str, **kw) -> Any:
    """Call Studio's API; return parsed JSON or a friendly ``{error}`` dict so
    the agent gets an actionable message instead of an exception."""
    try:
        resp = await _http().request(method, path, **kw)
    except httpx.HTTPError as exc:
        return {
            "error": f"cannot reach Studio at {STUDIO_URL} ({exc}). "
            "Is the Studio server running (tesserae-studio)?"
        }
    if resp.status_code >= 400:
        try:
            return {"error": resp.json().get("error", resp.text), "status": resp.status_code}
        except Exception:  # noqa: BLE001
            return {"error": resp.text or f"HTTP {resp.status_code}", "status": resp.status_code}
    return resp.json()


# -- discovery -------------------------------------------------------------
@mcp.tool()
async def studio_health() -> dict:
    """Studio + Tesserae connection state: mode (disk/live), whether live data
    and faithful render are available, and how widgets register (symlink/push)."""
    health = await _json("GET", "/studio/api/health")
    config = await _json("GET", "/studio/api/config")
    if isinstance(config, dict):
        health["registration"] = config.get("registration")
    return health


@mcp.tool()
async def list_widgets() -> dict:
    """List every widget Studio can see: workspace widgets (editable) and the
    connected Tesserae's reference widgets, each with fragments, plus whether it
    is editable and registered (live)."""
    cat = await _json("GET", "/studio/api/catalog")
    if "error" in cat:
        return cat
    widgets = [
        {k: w.get(k) for k in ("key", "name", "editable", "registered", "origin")}
        | {"fragments": [f["id"] for f in w.get("fragments", [])]}
        for w in cat.get("widgets", [])
    ]
    return {"widgets": widgets, "source": cat.get("source")}


# -- authoring -------------------------------------------------------------
@mcp.tool()
async def scaffold_widget(
    name: str,
    archetype: str = "stat",
    server: bool = False,
    fragments: list[dict] | None = None,
) -> dict:
    """Create a new fragment-first, lint-clean widget in the workspace.
    archetype: stat|list|chart|status|weather|calendar|image. Set server=true to
    include a server.py stub. Returns the new widget id + files."""
    body: dict[str, Any] = {"name": name, "archetype": archetype, "server": server}
    if fragments:
        body["fragments"] = fragments
    return await _json("POST", "/studio/api/scaffold", json=body)


@mcp.tool()
async def scaffold_bundle(name: str, members: list[dict] | None = None, admin: bool = True) -> dict:
    """Scaffold a widget bundle: a shared <name>_core companion (kind data, with
    choices() + an admin blueprint) plus member widgets wired to it. members is a
    list of {name, icon?}; defaults to one member. Returns the core + member ids.
    Register the core and each member with Tesserae for the family to work live."""
    body: dict[str, Any] = {"name": name, "admin": admin}
    if members:
        body["members"] = members
    return await _json("POST", "/studio/api/scaffold-bundle", json=body)


@mcp.tool()
async def duplicate_widget(source: str, name: str | None = None) -> dict:
    """Copy an existing widget (workspace or a connected Tesserae reference
    widget) into the workspace as a new editable widget."""
    return await _json("POST", "/studio/api/duplicate", json={"source": source, "name": name})


@mcp.tool()
async def list_files(widget: str) -> dict:
    """List a workspace widget's files (path, language, editable)."""
    return await _json("GET", f"/studio/api/files/{widget}")


@mcp.tool()
async def read_file(widget: str, path: str) -> dict:
    """Read one file from a widget (e.g. path='client.js'). Works on workspace
    widgets and, read-only, on the connected checkout's reference widgets (e.g.
    ha_core) so you can learn a family's pattern + house style."""
    return await _json("GET", f"/studio/api/files/{widget}/{path}")


@mcp.tool()
async def write_file(widget: str, path: str, content: str) -> dict:
    """Write one file in a workspace widget (whole-file). For a small change
    prefer edit_file. Run lint_widget after editing."""
    return await _json("PUT", f"/studio/api/files/{widget}/{path}", json={"content": content})


@mcp.tool()
async def edit_file(widget: str, path: str, old: str, new: str, replace_all: bool = False) -> dict:
    """Replace an exact substring in one file, instead of resending the whole
    file. `old` must be unique unless replace_all=true. Run lint_widget after."""
    return await _json(
        "POST",
        f"/studio/api/edit/{widget}/{path}",
        json={"old": old, "new": new, "replace_all": replace_all},
    )


@mcp.tool()
async def design_system(name: str = "spectra-widgets") -> dict:
    """Read a Spectra house-style stylesheet so you match the widget conventions
    (classes + tokens) on the first pass instead of reverse-engineering siblings.
    name: spectra-widgets | spectra-styles | spectra-tokens | base | forms."""
    return await _json("GET", f"/studio/api/design/{name}")


# -- validate + data -------------------------------------------------------
@mcp.tool()
async def lint_widget(widget: str) -> dict:
    """Run the widget linter (the Golden Rules + manifest schema). Returns
    findings with rule/level/message/file/line and error/warning counts."""
    return await _json("GET", f"/studio/api/lint/{widget}")


@mcp.tool()
async def mine_data_schema(
    widget: str,
    source: str = "auto",
    apply: bool = False,
    max_fields: int = 64,
    options: dict | None = None,
) -> dict:
    """Mine a canvas-bindable data_schema (fields + sample) from the widget's
    data. source: auto|live|sample. apply=true writes it into plugin.json.
    Returns fields (typed), the data_schema, and a diff vs the declared one."""
    body: dict[str, Any] = {"source": source, "apply": apply, "max_fields": max_fields}
    if options:
        body["options"] = options
    return await _json("POST", f"/studio/api/mine/{widget}", json=body)


@mcp.tool()
async def widget_data(widget: str, fresh: bool = False) -> dict:
    """Fetch the data a widget's server.py returns (live), or its sample.
    Returns {data, source} with the flattened field paths. fresh=true bypasses
    Tesserae's cache so a just-edited server.py is reflected immediately."""
    params = {"fresh": "1"} if fresh else None
    return await _json("GET", f"/studio/api/widgets/{widget}/data", params=params)


# -- register + preview ----------------------------------------------------
@mcp.tool()
async def register_widget(widget: str) -> dict:
    """Register a workspace widget with the connected Tesserae so it gets live
    data + faithful render. Uses a local symlink when co-located, else an HTTP
    push over MCP (remote / HA). May report needs_reload / restarting."""
    return await _json("POST", f"/studio/api/register/{widget}")


@mcp.tool()
async def unregister_widget(widget: str) -> dict:
    """Remove a workspace widget's registration from the connected Tesserae."""
    return await _json("DELETE", f"/studio/api/register/{widget}")


@mcp.tool()
async def faithful_render(
    widget: str,
    size: str = "lg",
    options: dict | None = None,
    fragment: str | None = None,
    fresh: bool = False,
):
    """Return the true e-ink render of a registered widget as a PNG image
    (Tesserae's Playwright screenshot). size: xs|sm|md|lg. options = cell options
    to render a configured state; fragment = render one declared fragment (default
    the whole widget); fresh=true bypasses Tesserae's cache. The widget must be
    registered and Tesserae reachable. Returns an image, or {error} on failure."""
    params = {"size": size}
    if options:
        params["opts"] = json.dumps(options)
    if fragment:
        params["fragment"] = fragment
    if fresh:
        params["fresh"] = "1"
    try:
        resp = await _http().get(f"/studio/api/render/{widget}.png", params=params)
    except httpx.HTTPError as exc:
        return {"error": f"cannot reach Studio ({exc})."}
    if resp.status_code >= 400:
        try:
            return {"error": resp.json().get("error", resp.text), "status": resp.status_code}
        except Exception:  # noqa: BLE001
            return {"error": f"render failed (HTTP {resp.status_code})"}
    return Image(data=resp.content, format="png")


@mcp.tool()
async def screenshot_widget(
    widget: str,
    out_path: str,
    size: str = "lg",
    options: dict | None = None,
    fragment: str | None = None,
) -> dict:
    """Write a widget's faithful-render PNG (from Tesserae) to out_path on disk,
    for catalog screenshots. lg is 1200x800. options = a configured state;
    fragment = one declared fragment. The widget must be registered and Tesserae
    reachable. Same render path as faithful_render, just saved to a file."""
    params = {"size": size}
    if options:
        params["opts"] = json.dumps(options)
    if fragment:
        params["fragment"] = fragment
    try:
        resp = await _http().get(f"/studio/api/render/{widget}.png", params=params)
    except httpx.HTTPError as exc:
        return {"error": f"cannot reach Studio ({exc})."}
    if resp.status_code >= 400:
        try:
            return {"error": resp.json().get("error", resp.text), "status": resp.status_code}
        except Exception:  # noqa: BLE001
            return {"error": f"render failed (HTTP {resp.status_code})"}
    out = Path(out_path).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    return {"ok": True, "path": str(out), "bytes": len(resp.content)}


# -- package + publish -----------------------------------------------------
@mcp.tool()
async def package_widget(widget: str) -> dict:
    """Build the release tarball for a widget (or its whole bundle) and return
    its sha256 + size + folders. For the catalog, the tarball_url is normally the
    widget's own GitHub repo release archive; use this for a self-hosted tarball
    or to inspect what ships."""
    return await _json("POST", f"/studio/api/package/{widget}")


@mcp.tool()
async def generate_catalog_entry(
    widget: str,
    author: dict,
    tags: list[str],
    release: dict,
    source: str | None = None,
    name: str | None = None,
    description: str | None = None,
    official: bool | None = None,
) -> dict:
    """Build + validate a marketplace catalog entry against the real
    marketplace.schema.json. author={name, github?}; tags is a non-empty subset of
    the closed taxonomy; release={version, tarball_url, sha256} (sha256 is fetched
    from tarball_url if omitted). Identity (id/kind/folders) is filled from the
    manifest; a bundle gets folders. Returns {entry, valid, errors}."""
    opts: dict[str, Any] = {"author": author, "tags": tags, "release": release}
    for k, v in (
        ("source", source),
        ("name", name),
        ("description", description),
        ("official", official),
    ):
        if v is not None:
            opts[k] = v
    return await _json("POST", f"/studio/api/catalog-entry/{widget}", json=opts)


@mcp.tool()
async def open_catalog_pr(
    widget: str,
    author: dict,
    tags: list[str],
    release: dict,
    source: str | None = None,
    dry_run: bool = True,
) -> dict:
    """Prepare a PR to the widget catalog: validates the entry, computes the
    widgets.json diff, and drafts the PR title/body + screenshot path. dry_run
    (default true) returns the plan without touching GitHub; opening the real PR
    is gated (the widget must first live in its own GitHub repo with a tagged
    release, so tarball_url resolves)."""
    opts: dict[str, Any] = {"author": author, "tags": tags, "release": release, "dry_run": dry_run}
    if source is not None:
        opts["source"] = source
    return await _json("POST", f"/studio/api/publish/{widget}", json=opts)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
