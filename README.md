# tesserae-studio

Author **Tesserae widgets** end to end: a code editor, a WYSIWYG canvas, and an
MCP-driven LLM loop that finishes at an open PR in the widget catalog. Studio is a
separate repo that connects to a running Tesserae for render fidelity and the widget
registry.

See `CLAUDE.md` for the widget contract and golden rules, `docs/build-spec.md` for the
mission and milestones, `docs/architecture.md` for the resolved design, and
`docs/plan-m0-m1.md` for the current plan.

## Status

**M0 (Scaffold & connect):** thin FastAPI server that reverse-proxies a running Tesserae,
plus a Vite + TypeScript front end that mounts any installed widget (whole widget or a
single fragment) in an interactive shadow-root preview at any cell size. Faithful e-ink
render, the editor, scaffolding, and the MCP/LLM loop are later milestones.

## Prerequisites

- A running Tesserae (default `http://localhost:8765`) with the **`mcp` experiment
  enabled** (Settings → System → MCP, or launch with `TESSERAE_EXPERIMENT_MCP=1`). The
  `/api/mcp` surface 404s until it is on; Studio's connection indicator flags this. Run
  Tesserae in debug mode if you want the `/_test/render` faithful path later (M2).
- Python 3.11+ and Node 18+.

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

| Env var                | Default                  | Purpose                          |
| ---------------------- | ------------------------ | -------------------------------- |
| `STUDIO_TESSERAE_URL`  | `http://localhost:8765`  | Connected Tesserae base URL      |
| `STUDIO_PORT`          | `8770`                   | Thin server port                 |
| `STUDIO_WORKDIR`       | `../widgets`             | Widget working dir (M1+)         |

## Tests

```sh
cd server && pytest        # server unit tests
cd web && npm run build    # typecheck + build the front end
```
