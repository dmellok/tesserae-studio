// Pure presentation logic lifted out of main.ts so it can be unit-tested
// without a DOM, app state, or the network. Nothing here touches the document
// or the module singletons; everything is a plain input -> output function.

import type { Health } from "./types";

export type PillKind = "ok" | "warn" | "bad" | "";

export interface PillState {
  kind: PillKind;
  label: string;
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
  if (h.mode === "disk") mode = { kind: "ok", label: "disk · standalone" };
  else if (h.mode === "live") mode = { kind: "ok", label: "live" };
  else mode = { kind: "bad", label: "no source" };

  let conn: PillState;
  if (h.tesserae !== "ok") {
    conn = { kind: h.mode === "disk" ? "warn" : "bad", label: "Tesserae offline" };
  } else if (h.mcp === "off") {
    conn = { kind: "warn", label: 'enable the "mcp" experiment' };
  } else {
    conn = { kind: "ok", label: h.live_data ? "live data + faithful" : "connected" };
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

// Parse the bundle dialog's "one member per line" textarea into member specs.
export function parseMembers(text: string): Array<{ name: string }> {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => ({ name: n }));
}
