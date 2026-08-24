"""The agent-facing copy Studio serves: handshake instructions + per-tool docs.

Studio's MCP bridge (``tesserae-studio-mcp``) is installed separately, from PyPI,
so anything baked into that wheel only moves when a release does. Most of what an
agent reads does not have to be: this module is the source of truth, and
``GET /studio/api/mcp/instructions`` hands it over at connect time, so a
corrected rule reaches an already-installed bridge on the next agent session.

What still needs a release is the tool LIST and the bridge's own result
handling, which is why the payload also names the bridge version Studio ships
with (see :mod:`studio_server.mcp_bridge`).

``TOOL_DOCS`` is read off the in-repo bridge module rather than retyped here.
The descriptions live with the functions they describe, which is where an author
will edit them; keeping a second hand-maintained copy in this file would just be
a third thing to forget.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

# Payload shape version. A bridge that does not recognise it treats the whole
# response as unreadable and falls back to its embedded copy, which is the
# correct failure: half-understood docs are worse than known-stale ones. Bump
# only for a BREAKING change to the shape, never to add a key.
DOCS_SCHEMA = 1

# Sent to the connecting agent at handshake (FastMCP ``instructions``) so it
# drives the build loop the way that actually works against Tesserae.
INSTRUCTIONS = """\
You build Tesserae widgets through these tools (mcp__tesserae-studio__*). Follow this loop and these rules.

BUILD LOOP
1. scaffold_widget(name, archetype, server=true). Archetypes: stat|list|chart|status|weather|calendar|image.
2. Read the generated files to learn the skeleton, then edit with write_file (whole-file overwrite, no partial edit).
3. lint_widget until 0 errors.
4. register_widget. A new widget serves its client.js immediately on the in-process reload, no restart (Tesserae reads the plugin registry fresh per request as of the plugin-asset fix). ONE EXCEPTION: a widget that declares an admin blueprint() still needs a single Tesserae restart to wire its admin route, so batch those, register all of them, then ask the user for one restart. Widget UPDATES (already-registered) never need a restart.
5. faithful_render(size=xs|sm|md|lg, options={...}). Pass options to QA a configured state. Base font scales with container WIDTH, so also check extreme aspect ratios (wide-short cells overflow in ways the xs/sm size tokens don't reveal), not just size. For live data across all sizes/fragments, build a canvas via the tesserae MCP and render_preview.
6. mine_data_schema(apply=true) once the data shape is final.

SERVICES (non-placeable data sources)
- To make an API available to a canvas code/data element (not draw a tile), scaffold_service(name) instead of a widget: kind "service", server.py fetch() only, no render/fragments, supports.sizes may be []. An empty-options probe MUST return a self-describing {service, auth, scopes, usage} map; a chosen options.scope returns the API JSON; failure returns {"error": ...}, never raise. Lint + register like a widget; it won't appear in the canvas picker (source it by key).

LEARN FROM SIBLINGS
- read_file / list_files also work on the connected checkout's REFERENCE widgets (e.g. ha_core, ha_history). Read a family's server.py + client.js to copy its data pattern and house style, don't guess.
- design_system(name) returns the Spectra house-style CSS: spectra-widgets (widget classes like .w-title / list rows / .is-zebra), spectra-tokens (--space-*, --fs-*), spectra-styles. Match these on the first pass.
- edit_file(widget, path, old, new) makes a one-line change without resending the whole file.

DIAGNOSING A FAILED / BLANK RENDER (do this before re-editing client.js)
- Confirm the server side first with probe_widget_data: if it returns your real output (or your friendly error), server.py is loaded, so the problem is in client.js, fix the JS.
- "Failed to fetch dynamically imported module .../client.js" now almost always means a genuine JS error (syntax, bad import path), not a reload gate. The only remaining reload case is a brand-new widget that declares an admin blueprint() (needs one restart).

HARD RULES
- Lint: data_schema.fields[].type must be num | str | arr (never "int"). server.py must NEVER use `raise`, return {"error": "..."} or thread (value, error) tuples.
- render is {dither: "none"|"floyd-steinberg"|"ordered", full_bleed, needs_network}. There is no render.per_device_id; older Studio copy claimed one and Tesserae's schema rejects it.
- select / multiselect cell_options: the choice list key is "choices" (or "choices_from"), NOT "options". A mis-named key parses but the config dropdown renders empty (the linter now flags this); verify with get_widget_options.
- Secrets (API keys) = settings[] with "secret": true, settings.get(...). Per-cell config = cell_options[], options.get(...).
- Egress: an own-host widget declares requires: ["network:<exact-host>", "settings:plugin"], caches in ctx["data_dir"], and returns friendly error strings (they render verbatim). A widget that fetches THROUGH a shared family core (e.g. ha_core via current_app.config["PLUGIN_REGISTRY"].get("ha_core")) declares requires: ["plugin:ha_core"] and NO host of its own. This reversed an older rule that said to omit requires entirely: the core's request runs inside the MEMBER's capability scope, so without the plugin: declaration the core's egress is denied at render time, not at lint time. The linter flags a missing delegate declaration.
- Placement refresh (optional, manifest `updates`): on_change: [{source, selector_option?}] names server data-change sources that may refresh an opted-in placement, where selector_option is a cell_options name whose saved value narrows the event to that placement. on_schedule: [{kind: "daily", suggested_at?}] offers a scheduled refresh; suggested_at (HH:MM) only prefills the custom-time control. A declaration ONLY makes the per-placement opt-in available; it never refreshes a dashboard by itself, so declare what the widget genuinely supports rather than everything.
- Linked options: fill_from: {option, map} on a cell option hands its value to another option; the editor looks the controlling value up in the map, fills the field and locks it. Resolved server-side, so it lands on reload after a save, not the instant the controlling option changes.
- Sensitive options: `secret: true` strips the value from the render context and redacts it when a dashboard is shared. `mask` controls ONLY the editor input type and defaults to secret, so set mask: false on a sensitive value the author must be able to read back to maintain (a webhook URL).
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


@lru_cache(maxsize=1)
def tool_docs() -> dict[str, str]:
    """Every bridge tool's description, keyed by tool name.

    Harvested from :mod:`studio_server.mcp_server`, the copy of the bridge that
    ships inside the server, by reading the docstring off each function the
    FastMCP tool manager registered. Asking the manager rather than scanning
    module globals means a helper that happens to be public never leaks in, and
    a tool that is added later needs no bookkeeping here.

    Cached: the docstrings cannot change while the process runs, and the import
    pulls in the MCP SDK, which is not work to repeat per request.
    """
    from studio_server import mcp_server

    out: dict[str, str] = {}
    manager: Any = getattr(mcp_server.mcp, "_tool_manager", None)
    tools = manager.list_tools() if manager is not None else []
    for tool in tools:
        text = (getattr(tool, "description", "") or "").strip()
        if text:
            out[str(tool.name)] = text
    return out
