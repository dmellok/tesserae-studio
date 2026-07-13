# tesserae-studio-mcp

> Part of the [Tesserae Studio](https://github.com/dmellok/tesserae-studio)
> repo (`packages/tesserae-studio-mcp`), so the bridge stays in lockstep with
> the Studio API it wraps. Published to PyPI as `tesserae-studio-mcp`.

The [MCP](https://modelcontextprotocol.io) bridge for
[Tesserae Studio](https://github.com/dmellok/tesserae-studio). It lets an AI
agent (Claude Code, Claude Desktop, or any MCP client) **author Tesserae
widgets** end to end: scaffold a widget, edit its files, lint it, mine a
data schema, register it to a running Tesserae, and render it, all through a
running Studio server.

This is a thin stdio client. It talks to your Studio server over its local REST
API (`STUDIO_URL`), so the linting, mining, registering, and rendering all run
in your own Studio, which in turn drives your Tesserae.

```
scaffold_widget → write_file → lint_widget → register_widget → faithful_render → mine_data_schema
```

## Prerequisites

A running **Tesserae Studio** server (it serves the API this bridge calls, and
its web UI). See the [Studio README](https://github.com/dmellok/tesserae-studio)
for how to run it. Studio in turn connects to a Tesserae for live data and
faithful (e-ink) render.

## Install

Run this on the machine where your **agent** runs, which may differ from where
Studio runs.

```bash
pip install tesserae-studio-mcp
```

or from source:

```bash
pip install "git+https://github.com/dmellok/tesserae-studio#subdirectory=packages/tesserae-studio-mcp"
```

Either gives you the `tesserae-studio-mcp` command.

## Configure your agent

Point your MCP client at `tesserae-studio-mcp`. Example (Claude Desktop / Claude
Code `mcpServers` config):

```json
{
  "mcpServers": {
    "tesserae-studio": {
      "command": "tesserae-studio-mcp",
      "env": { "STUDIO_URL": "http://localhost:8770" }
    }
  }
}
```

Claude Code one-liner:

```bash
claude mcp add tesserae-studio -e STUDIO_URL=http://localhost:8770 -- tesserae-studio-mcp
```

- `STUDIO_URL` — where your Studio server is reachable (default
  `http://localhost:8770`). For a remote / Home Assistant Studio, use its LAN
  address, e.g. `http://192.168.1.50:8770`.

The build loop and the widget contract rules are sent to the agent
automatically at handshake (FastMCP instructions), so you don't paste a prompt.

## Run without installing

From a clone:

```bash
pip install mcp httpx
STUDIO_URL=http://localhost:8770 python -m tesserae_studio_mcp
```

## License

AGPL-3.0-or-later, matching Tesserae Studio.
