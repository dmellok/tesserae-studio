// Interactive shadow-mount preview. A faithful port of Tesserae's
// static/composer.js (resolveSize + buildCtx + mountCell) so a widget mounts
// here exactly as it does in a real Tesserae page. This is the fast iteration
// tier only; it is NOT the faithful e-ink render (that is /_test/render, M2).

const SIZE_THRESHOLDS = [
  { size: "xs", max: 200 },
  { size: "sm", max: 400 },
  { size: "md", max: 700 },
] as const;

function resolveSize(w: number, h: number): string {
  const longer = Math.max(w, h);
  for (const { size, max } of SIZE_THRESHOLDS) {
    if (longer <= max) return size;
  }
  return "lg";
}

export interface MountSpec {
  pluginId: string;
  fragment: string; // "full" or a fragment id
  w: number;
  h: number;
  panelW: number;
  panelH: number;
  options: Record<string, unknown>;
  data: unknown;
  fontFamily?: string;
  // Bumped on save so the dynamic import re-fetches the edited client.js instead
  // of returning the module cached under the same URL.
  version?: number;
}

const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// The exact ctx shape Tesserae's buildCtx produces (composer.js). Kept
// byte-compatible so widgets that branch on ctx.cell.fragment / ctx.cell.size
// behave identically.
function buildCtx(spec: MountSpec) {
  const fragment = spec.fragment || "full";
  return {
    cell: {
      w: spec.w,
      h: spec.h,
      size: resolveSize(spec.w, spec.h),
      plugin: spec.pluginId,
      plugin_id: spec.pluginId,
      options: spec.options,
      fragment,
    },
    panel: { w: spec.panelW, h: spec.panelH, portrait: spec.panelH > spec.panelW },
    font: { family: spec.fontFamily || DEFAULT_FONT, weight: 400 },
    data: spec.data,
    fragment,
    preview: true,
  };
}

// Mount into `host`: size it to the cell, give it container-type: size so the
// widget's cqw/cqh queries resolve, attach a fresh shadow root, dynamic-import
// the proxied client.js, and call its default export. Idempotent: the caller
// hands a clean host each time (we replace it) and the widget sets
// shadow.innerHTML rather than appending.
export async function mountWidget(host: HTMLElement, spec: MountSpec): Promise<void> {
  host.textContent = "";
  host.style.width = `${spec.w}px`;
  host.style.height = `${spec.h}px`;
  host.style.containerType = "size";
  host.style.overflow = "hidden";

  const shadow = host.attachShadow({ mode: "open" });
  const ctx = buildCtx(spec);

  try {
    // Runtime variable URL, so Vite leaves it as a native dynamic import to the
    // proxied same-origin path. The version query busts the module cache so a
    // re-mount after saving loads the edited client.js.
    const v = spec.version ? `?v=${spec.version}` : "";
    const url = `/plugins/${encodeURIComponent(spec.pluginId)}/client.js${v}`;
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default !== "function") {
      throw new Error("plugin module has no default export");
    }
    await mod.default(shadow, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    shadow.innerHTML = `<div style="font:13px system-ui;color:#b00;padding:8px">${spec.pluginId}: ${msg}</div>`;
    throw err;
  }
}
