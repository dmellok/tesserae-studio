# tesserae-studio

Author **Tesserae widgets** end to end: a code editor, a WYSIWYG canvas, and an
MCP-driven LLM loop that finishes at an open PR in the widget catalog. Studio is a
separate repo that connects to a running Tesserae for render fidelity and the widget
registry.

See `CLAUDE.md` for the widget contract and golden rules, `docs/build-spec.md` for the
mission and milestones, `docs/architecture.md` for the resolved design, and
`docs/plan-m0-m1.md` for the current plan.

## Status

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

## Configuration

| Env var                | Default                  | Purpose                                      |
| ---------------------- | ------------------------ | -------------------------------------------- |
| `STUDIO_TESSERAE_PATH` | autodetect `../tesserae` | Disk checkout for assets + catalog (standalone) |
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
