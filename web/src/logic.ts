// Pure presentation logic lifted out of main.ts so it can be unit-tested
// without a DOM, app state, or the network. Nothing here touches the document
// or the module singletons; everything is a plain input -> output function.

import type { Health } from "./types";

export type PillKind = "ok" | "warn" | "bad" | "";

export interface PillState {
  kind: PillKind;
  label: string;
  title?: string; // hover tooltip explaining what the state means
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

// Which built-in size bucket a faithful (e-ink) render should use. A named size
// passes through; a custom / fragment size maps to the nearest bucket by its
// longer edge.
export function faithfulSize(sizeMode: string, dims: { w: number; h: number }): string {
  if (["xs", "sm", "md", "lg"].includes(sizeMode)) return sizeMode;
  const longer = Math.max(dims.w, dims.h);
  return longer <= 200 ? "xs" : longer <= 400 ? "sm" : longer <= 700 ? "md" : "lg";
}

// Map a health snapshot to the mode + connection status pills.
export function healthPills(h: Health): { mode: PillState; conn: PillState } {
  let mode: PillState;
  if (h.mode === "disk")
    mode = {
      kind: "ok",
      label: "disk · standalone",
      title: "Studio is sourcing widgets from a local folder on disk. Register a widget to also get live data and faithful render from Tesserae.",
    };
  else if (h.mode === "live")
    mode = {
      kind: "ok",
      label: "live",
      title: "Studio is sourcing widgets from the connected Tesserae.",
    };
  else
    mode = {
      kind: "bad",
      label: "no source",
      title: "Studio has no widget source yet: connect a Tesserae (set tesserae_url) or point it at a local widget folder.",
    };

  let conn: PillState;
  if (h.tesserae !== "ok") {
    conn = {
      kind: h.mode === "disk" ? "warn" : "bad",
      label: "Tesserae offline",
      title: "Studio can't reach the configured Tesserae. Live data and faithful render are unavailable. Check tesserae_url and that Tesserae is running.",
    };
  } else if (h.mcp === "off") {
    conn = {
      kind: "warn",
      label: "data API off",
      title: "Tesserae is reachable but its data API is disabled. Studio needs it for live data and faithful render. In Tesserae, enable the \"mcp\" experiment (Settings, System), then restart Tesserae. (It gates the API Studio reads; you don't need to run an MCP agent.)",
    };
  } else {
    conn = {
      kind: "ok",
      label: h.live_data ? "live data + faithful" : "connected",
      title: h.live_data
        ? "Connected to Tesserae: real fetch() data and faithful e-ink render are available."
        : "Connected to Tesserae. Register a widget to get its live data and faithful render.",
    };
  }
  return { mode, conn };
}

// Lint pill severity + summary text.
export function lintSummary(errors: number, warnings: number): PillState {
  if (errors) {
    const warn = warnings ? ` · ${warnings} warn` : "";
    return { kind: "bad", label: `${errors} error${errors > 1 ? "s" : ""}${warn}` };
  }
  if (warnings) {
    return { kind: "warn", label: `${warnings} warning${warnings > 1 ? "s" : ""}` };
  }
  return { kind: "ok", label: "lint clean" };
}

// The "+added ~changed -removed" summary for a mined-schema diff.
export function mineDiffBits(diff: {
  added: string[];
  changed: string[];
  removed: string[];
}): string {
  return [
    diff.added.length ? `+${diff.added.length}` : "",
    diff.changed.length ? `~${diff.changed.length}` : "",
    diff.removed.length ? `-${diff.removed.length}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Seed config-form values from each option's declared default. Options without
// a default are simply absent (the widget falls back to its own default).
export function optionDefaults(
  options: Array<{ name: string; default?: unknown }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of options) {
    if (o.default !== undefined) out[o.name] = o.default;
  }
  return out;
}

export interface McpClientConfig {
  studioUrl: string;
  install: string;
  cli: string;
  desktopJson: string;
}

const MCP_PKG = "git+https://github.com/dmellok/tesserae-studio.git#subdirectory=server";

// The details for pointing an MCP client (Claude Code / Desktop) at this Studio.
// Studio's MCP server is a thin client over the backend, so it just needs the
// backend URL, derived here from the browser origin so it is correct wherever
// Studio is deployed.
export function mcpClientConfig(origin: string): McpClientConfig {
  const studioUrl = origin.replace(/\/+$/, "");
  // pipx puts the tesserae-studio-mcp command on PATH; the uvx line runs it with
  // no install if you have uv.
  const install =
    `pipx install "${MCP_PKG}"\n` +
    `# or, no install (needs uv):  uvx --from "${MCP_PKG}" tesserae-studio-mcp`;
  const cli = `claude mcp add tesserae-studio -e STUDIO_URL=${studioUrl} -- tesserae-studio-mcp`;
  const desktopJson = JSON.stringify(
    {
      mcpServers: {
        "tesserae-studio": {
          command: "tesserae-studio-mcp",
          env: { STUDIO_URL: studioUrl },
        },
      },
    },
    null,
    2,
  );
  return { studioUrl, install, cli, desktopJson };
}

// Parse the bundle dialog's "one member per line" textarea into member specs.
export function parseMembers(text: string): Array<{ name: string }> {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => ({ name: n }));
}
