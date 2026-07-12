# Parked: WYSIWYG visual editor

A structured visual editor (a fragment-aware tree of Spectra-styled flex containers +
elements) that generates lint-clean, container-query `client.js` and round-trips via an
embedded model comment.

It is **parked**: not wired into the app (`web/src/main.ts`), not bundled, not shipped. The
authoring path is the **MCP server** (`server/studio_server/mcp_server.py`) driving an agent.

Kept for reference. To revive, move back under `web/src/` and re-add the Design-mode wiring
in `main.ts` (imports, mode toggle, design surface, and the regenerate/persist handlers).
