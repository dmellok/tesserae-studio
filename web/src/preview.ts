// The preview stage: the two render tiers (interactive shadow-mount vs faithful
// e-ink PNG), the size/dimension controls that drive them, the data-source chip,
// and the render() entry point every other module calls after a change.

import { getWidgetData } from "./api";
import { getEditor } from "./editorInstance";
import { escapeHtml, faithfulSize } from "./logic";
import { mountWidget } from "./mount";
import { PANEL, state } from "./state";
import type { Widget } from "./types";
import { $, setNote } from "./ui";

function faithfulReady(): boolean {
  return !!(state.faithful && state.widget?.registered);
}

export function updateTierButtons() {
  const tierInteractive = $<HTMLButtonElement>("tier-interactive");
  const tierFaithful = $<HTMLButtonElement>("tier-faithful");
  const ok = faithfulReady();
  tierFaithful.disabled = !ok;
  tierFaithful.title = ok
    ? "The e-ink render of the version registered in Tesserae, at true panel resolution (fonts and dither differ from the interactive preview). Save and re-register to reflect your latest edits."
    : !state.faithful
      ? "Connect a Tesserae (data API on) for the faithful render"
      : "Register this widget to Tesserae first";
  if (!ok && state.tier === "faithful") state.tier = "interactive";
  tierInteractive.classList.toggle("active", state.tier === "interactive");
  tierFaithful.classList.toggle("active", state.tier === "faithful");
}

function renderFaithful(dims: { w: number; h: number }) {
  setSourceChip("");
  const frame = $<HTMLDivElement>("frame");
  frame.textContent = "";
  const size = faithfulSize(state.sizeMode, dims);
  const img = document.createElement("img");
  img.className = "cell faithful-img";
  img.alt = `${state.widget!.key} faithful render`;
  // ?t= busts the browser cache after an edit/register so the PNG re-renders.
  img.src = `/studio/api/render/${encodeURIComponent(state.widget!.key)}.png?size=${size}&t=${state.version}`;
  img.onerror = () =>
    setNote("Faithful render failed (needs the widget registered and Tesserae in debug mode).", "err");
  img.onload = () => {
    if ($<HTMLDivElement>("note").classList.contains("err")) setNote("");
  };
  frame.appendChild(img);
  setNote(
    state.fragment && state.fragment.id !== "full"
      ? "Faithful render shows the whole widget (fragments preview interactively only)."
      : "",
    "",
  );
}

export function resolveDims(): { w: number; h: number } {
  const mode = state.sizeMode;
  if (mode === "custom") return { w: state.w, h: state.h };
  if (mode === "fragment" && state.fragment) return { w: state.fragment.w, h: state.fragment.h };
  const preset = state.config?.sizes[mode];
  return preset ? { w: preset.w, h: preset.h } : { w: state.w, h: state.h };
}

function syncDimInputs(dims: { w: number; h: number }) {
  const wInput = $<HTMLInputElement>("w");
  const hInput = $<HTMLInputElement>("h");
  wInput.value = String(dims.w);
  hInput.value = String(dims.h);
  const custom = state.sizeMode === "custom";
  wInput.disabled = hInput.disabled = !custom;
}

export function setSourceChip(source: "live" | "sample" | "none" | "") {
  const chip = $<HTMLSpanElement>("src");
  chip.hidden = !source;
  chip.classList.remove("live", "sample", "none");
  if (!source) return;
  chip.classList.add(source);
  chip.textContent =
    source === "live" ? "live data" : source === "sample" ? "sample data" : "no data";
}

async function dataFor(widget: Widget, fresh = false): Promise<unknown> {
  // Cache per (widget, version, options) so an edit or an options change both
  // re-fetch, and the live data reflects the config. `fresh` skips both this
  // cache and Tesserae's, so a server.py edit shows immediately after a save.
  const cacheKey = `${widget.key}@${state.version}@${JSON.stringify(state.options)}`;
  if (!fresh && state.dataCache.has(cacheKey)) {
    setSourceChip((state.sourceCache.get(cacheKey) as "live" | "sample" | "none") ?? "");
    return state.dataCache.get(cacheKey);
  }
  try {
    const res = await getWidgetData(widget.key, state.options, fresh);
    state.dataCache.set(cacheKey, res.data ?? null);
    state.sourceCache.set(cacheKey, res.source);
    setSourceChip(res.source);
    return res.data ?? null;
  } catch {
    state.dataCache.set(cacheKey, null);
    state.sourceCache.set(cacheKey, "none");
    setSourceChip("none");
    return null;
  }
}

export function isWidgetKind(w: Widget): boolean {
  return !w.kind || w.kind === "widget";
}

export async function render(opts: { fresh?: boolean } = {}) {
  if (!state.widget || !state.fragment) return;
  const badge = $<HTMLSpanElement>("badge");
  const frame = $<HTMLDivElement>("frame");

  // Companion plugins (a bundle's _core) and services don't render as widgets.
  if (!isWidgetKind(state.widget)) {
    setSourceChip("");
    const kind = state.widget.kind ?? "companion";
    badge.textContent = kind;
    frame.classList.add("is-empty");
    const isService = kind === "service";
    const title = isService
      ? `${escapeHtml(state.widget.name)} is a service`
      : `${escapeHtml(state.widget.name)} is a companion plugin`;
    const text = isService
      ? "A service is a non-placeable data source (server.py fetch() only). It has no render; a canvas code/data element sources it by key. Probe it with empty options to see its scopes."
      : "Companions have no widget render. Configure it on its admin page in Tesserae, and register it so member widgets can read it.";
    frame.innerHTML = `
      <div class="empty-state">
        <i class="empty-ico ph-bold ${isService ? "ph-cloud" : "ph-plugs-connected"}"></i>
        <p class="empty-title">${title}</p>
        <p class="empty-text">${text}</p>
      </div>`;
    setNote(
      isService
        ? `Service (non-placeable data source) · edit server.py and register it.`
        : `Companion plugin (${kind}) · configure on its admin page in Tesserae.`,
      "",
    );
    return;
  }
  frame.classList.remove("is-empty");

  const dims = resolveDims();
  syncDimInputs(dims);
  badge.textContent = `${state.fragment.id} · ${dims.w}×${dims.h}`;
  updateTierButtons(); // may fall faithful back to interactive if unavailable

  if (state.tier === "faithful") {
    renderFaithful(dims);
    return;
  }

  const data = await dataFor(state.widget, opts.fresh);
  frame.textContent = "";
  const host = document.createElement("div");
  host.className = "cell";
  frame.appendChild(host);
  try {
    await mountWidget(host, {
      pluginId: state.widget.key,
      fragment: state.fragment.id,
      w: dims.w,
      h: dims.h,
      panelW: PANEL.w,
      panelH: PANEL.h,
      options: state.options,
      data,
      version: state.version,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A reference (non-editable) widget's source lives on the connected Tesserae.
    // If it won't serve client.js (not installed there, or served elsewhere), the
    // raw dynamic-import error is opaque; explain the actual situation.
    if (!state.widget.editable && /dynamically imported module|import/i.test(msg)) {
      setNote(
        `Can't load ${state.widget.key}'s source from the connected Tesserae (it isn't served there). Duplicate it to your workspace to view and preview it.`,
        "warn",
      );
    } else {
      setNote(`Mount failed: ${msg}`, "err");
    }
  }
}

// Wire the tier toggle and the size / dimension controls.
export function initPreview() {
  const tierInteractive = $<HTMLButtonElement>("tier-interactive");
  const tierFaithful = $<HTMLButtonElement>("tier-faithful");
  tierInteractive.addEventListener("click", () => {
    state.tier = "interactive";
    void render();
  });
  tierFaithful.addEventListener("click", () => {
    if (tierFaithful.disabled) return;
    state.tier = "faithful";
    // Faithful renders the registered version, so unsaved edits won't appear.
    if (getEditor().anyDirty()) {
      setNote(
        "Faithful shows the version registered in Tesserae. Save and re-register to include your unsaved edits.",
        "warn",
      );
    }
    void render();
  });

  $<HTMLSelectElement>("size").addEventListener("change", (e) => {
    state.sizeMode = (e.target as HTMLSelectElement).value;
    void render();
  });
  const wInput = $<HTMLInputElement>("w");
  const hInput = $<HTMLInputElement>("h");
  for (const input of [wInput, hInput]) {
    input.addEventListener("input", () => {
      state.w = Number(wInput.value) || state.w;
      state.h = Number(hInput.value) || state.h;
      if (state.sizeMode === "custom") void render();
    });
  }
}
