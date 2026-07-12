# tesserae-studio

Author **Tesserae widgets** end to end: a code editor with live and faithful preview, a
widget linter, data-schema mining, and an **MCP authoring server** that an agent (Claude
Code / Desktop) drives from scaffold to a registered, rendering widget. Studio is a separate
repo that connects to a running Tesserae for render fidelity and the widget registry.

## Status

**M5 (bundles + admin pages):** scaffold a widget **bundle**, a shared `<name>_core` companion
(`kind: data`, with `choices()`, shared data functions, and a Flask `blueprint()` admin page
under `templates/<id>/`) plus member widgets wired to it (their `fetch()` reaches the core via
the plugin registry, and a `choices_from` cell option offers the core's items). Follows
Tesserae's real family pattern (`calendar_core`, `ha_core`). The core is editable in Studio as
a companion plugin (no widget render); members preview and lint like any widget. "New bundle"
in the toolbar, or the `scaffold_bundle` MCP tool.

**M2 (in progress):** scaffold new widgets and duplicate existing ones into the workspace,
with a live widget linter. "New widget" generates a fragment-first, lint-clean widget
(manifest validated against `plugin.schema.json`, `client.js` branching on
`ctx.cell.fragment`, optional `server.py`, a smoke test); "Duplicate to workspace" copies a
read-only reference widget so you can edit it. The **linter** encodes the Golden Rules
(no client fetch, no hard-coded hex, container queries not media queries, idempotent render,
declared egress, and more) and shows findings inline in the editor, on load and every save.
**Register to Tesserae** makes an authored widget live: a local **symlink** into
Tesserae's `marketplace/` when Studio and Tesserae share a host, or an **HTTP push over MCP**
(package -> install -> in-process reload, no restart) when Tesserae is remote or in the Home
Assistant add-on. Either way the widget's `server.py` then serves **live `fetch()` data** in
the preview (a source chip shows live vs sample vs empty). The preview has two explicit
tiers: **Interactive** (fast shadow-mount) and **Faithful** (the true e-ink PNG rendered by
Tesserae), toggled in the stage head, so interactive output is never mistaken for the panel
render. **Mine schema** reverse-engineers a bindable `data_schema` (fields + sample) from the
widget's live or sample data, reusing Tesserae's field-path grammar, and applies it to
`plugin.json` so the widget is canvas-bindable. M2 is complete.

**M3 (MCP authoring server):** the whole loop is exposed as an MCP server so an agent (Claude
Code / Desktop, or any MCP client) is the author, Studio ships no LLM of its own. See
[MCP authoring server](#mcp-authoring-server) below.

**M1 (Editor):** a Monaco multi-file editor over a working directory, side by side with the
live preview. Open a widget's `plugin.json` (validated live against Tesserae's
`plugin.schema.json`), `client.js`, and `server.py`; edit and save (⌘/Ctrl+S) and the
preview re-mounts the widget immediately. Widgets in the workspace are editable and shadow
the read-only tesserae catalog. Ships an example widget (`examples/hello_stat`).

**M0 (Scaffold & connect):** thin FastAPI server plus a Vite + TypeScript front end that
mounts any installed widget (whole widget or a single fragment) in an interactive
shadow-root preview at any cell size. Studio reuses Tesserae's admin design system
(`base.css` tokens, Inter, `.field` controls) so it reads as part of the same product.

**Standalone by default.** Studio reads Tesserae's assets and builds the widget catalog
straight off a `tesserae` checkout on disk, so interactive preview needs **no running
instance**. Preview data comes from Tesserae's dev-gallery samples. A live Tesserae is
required only for real `fetch()` data and faithful (e-ink) render, both later milestones.

## Prerequisites

- Python 3.11+ and Node 18+.
- A `tesserae` checkout on disk for the assets + widget catalog. Studio autodetects a
  sibling `../tesserae`; override with `STUDIO_TESSERAE_PATH`.
- *(Optional)* A running Tesserae for live `fetch()` data and faithful render, with the
  **`mcp` experiment enabled** (Settings → System → MCP, or `TESSERAE_EXPERIMENT_MCP=1`).
  The `/api/mcp` surface 404s until it is on; Studio's connection pill flags this. Run
  Tesserae in debug mode for the `/_test/render` faithful path (M2).

## Run (dev)

Two processes. From the repo root:

```sh
# 1. thin server (reverse-proxies Tesserae, serves Studio's API)
cd server
python -m venv .venv && . .venv/bin/activate
pip install -e .
STUDIO_TESSERAE_URL=http://localhost:8765 uvicorn studio_server.app:app --port 8770 --reload

# 2. front end (in another terminal)
cd web
npm install
npm run dev   # http://localhost:5173
```

Open http://localhost:5173. The connection indicator turns green when Studio can reach
Tesserae. Pick a widget, a fragment, and a size to preview it.

## MCP authoring server

Studio exposes its authoring loop as an MCP server, so an agent drives the work: `list_widgets`,
`scaffold_widget`, `scaffold_bundle`, `duplicate_widget`, `read_file`/`write_file`,
`lint_widget`, `mine_data_schema`, `register_widget`, `widget_data`, and `faithful_render`
(which returns the e-ink PNG as an image). It is a thin client over the running Studio backend,
so **start the server above first** (`uvicorn studio_server.app:app`), then point your MCP
client at:

```jsonc
// Claude Desktop / Code: mcpServers config
{
  "tesserae-studio": {
    "command": "python",
    "args": ["-m", "studio_server.mcp_server"],
    "env": { "STUDIO_URL": "http://localhost:8770" }
  }
}
```

Or, with the package installed (`pip install -e server`), run the console script
`tesserae-studio-mcp`. From Claude Code:
`claude mcp add tesserae-studio -e STUDIO_URL=http://localhost:8770 -- tesserae-studio-mcp`.

## Configuration

| Env var                | Default                  | Purpose                                      |
| ---------------------- | ------------------------ | -------------------------------------------- |
| `STUDIO_TESSERAE_PATH` | autodetect `../tesserae` | Disk checkout for assets + catalog (standalone) |
| `STUDIO_TESSERAE_DATA_ROOT` | `<checkout>/data`   | Tesserae data root; its `marketplace/` is where synced widgets are registered |
| `STUDIO_TESSERAE_MCP_TOKEN` | (none)              | MCP bearer token for pushing to a remote / HA Tesserae (Settings -> System -> MCP) |
| `STUDIO_TESSERAE_URL`  | `http://localhost:8765`  | Live Tesserae for data + faithful render     |
| `STUDIO_PORT`          | `8770`                   | Thin server port                             |
| `STUDIO_WORKDIR`       | `<repo>/examples`        | Working dir of widgets being authored        |

The default workdir is the tracked `examples/` so the editor always has something to open;
point `STUDIO_WORKDIR` at a scratch directory for real authoring.

## Tests

```sh
cd server && pytest        # server unit tests
cd web && npm run build    # typecheck + build the front end
```
