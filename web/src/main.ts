import { getCatalog, getConfig, getHealth, getWidgetData } from "./api";
import { mountWidget } from "./mount";
import type { Config, Fragment, Widget } from "./types";
import "./style.css";

// Default panel (whole display) dims for ctx.panel. The preview cell can be any
// size; the panel only informs ctx.panel.portrait, which few widgets read.
const PANEL = { w: 1200, h: 825 };

interface State {
  config?: Config;
  widgets: Widget[];
  widget?: Widget;
  fragment?: Fragment;
  sizeMode: string; // preset key ("xs".."lg"), "fragment", or "custom"
  w: number;
  h: number;
  dataCache: Map<string, unknown>;
}

const state: State = {
  widgets: [],
  sizeMode: "md",
  w: 640,
  h: 400,
  dataCache: new Map(),
};

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><i class="ph-bold ph-squares-four"></i></span>
      <span class="brand-name">Tesserae <b>Studio</b></span>
    </div>
    <div class="pills">
      <span class="pill" id="mode"><span class="dot"></span><span id="mode-text">·</span></span>
      <span class="pill" id="conn"><span class="dot"></span><span id="conn-text">connecting…</span></span>
    </div>
  </header>
  <div class="controls">
    <div class="field">
      <label for="widget">Widget</label>
      <select id="widget"></select>
    </div>
    <div class="field">
      <label for="fragment">Fragment</label>
      <select id="fragment"></select>
    </div>
    <div class="field">
      <label for="size">Size</label>
      <select id="size">
        <option value="xs">xs (180×180)</option>
        <option value="sm">sm (380×240)</option>
        <option value="md" selected>md (640×400)</option>
        <option value="lg">lg (1200×800)</option>
        <option value="fragment">fragment size</option>
        <option value="custom">custom…</option>
      </select>
    </div>
    <div class="field dim">
      <label for="w">Width</label>
      <input id="w" type="number" min="20" max="2000" value="640" />
    </div>
    <div class="field dim">
      <label for="h">Height</label>
      <input id="h" type="number" min="20" max="2000" value="400" />
    </div>
  </div>
  <main class="stage">
    <div class="stage-head">
      <span class="tier">Interactive preview</span>
      <span class="badge" id="badge"></span>
    </div>
    <div class="cell-frame" id="frame"></div>
    <p class="note" id="note"></p>
  </main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const widgetSel = $<HTMLSelectElement>("widget");
const fragmentSel = $<HTMLSelectElement>("fragment");
const sizeSel = $<HTMLSelectElement>("size");
const wInput = $<HTMLInputElement>("w");
const hInput = $<HTMLInputElement>("h");
const frame = $<HTMLDivElement>("frame");
const badge = $<HTMLSpanElement>("badge");
const note = $<HTMLDivElement>("note");

function setNote(msg: string, kind: "" | "warn" | "err" = "") {
  note.textContent = msg;
  note.className = `note ${kind}`;
}

function setPill(id: string, textId: string, kind: "ok" | "warn" | "bad" | "", label: string) {
  const pill = $<HTMLSpanElement>(id);
  pill.classList.remove("ok", "warn", "bad");
  if (kind) pill.classList.add(kind);
  $<HTMLSpanElement>(textId).textContent = label;
}

async function refreshHealth() {
  try {
    const h = await getHealth();
    // Mode pill: where assets + catalog come from.
    if (h.mode === "disk") setPill("mode", "mode-text", "ok", "disk · standalone");
    else if (h.mode === "live") setPill("mode", "mode-text", "ok", "live");
    else setPill("mode", "mode-text", "bad", "no source");

    // Connection pill: the live instance, needed only for live data + faithful.
    if (h.tesserae !== "ok")
      setPill("conn", "conn-text", h.mode === "disk" ? "warn" : "bad", "Tesserae offline");
    else if (h.mcp === "off")
      setPill("conn", "conn-text", "warn", 'enable the "mcp" experiment');
    else setPill("conn", "conn-text", "ok", h.live_data ? "live data + faithful" : "connected");
  } catch {
    setPill("conn", "conn-text", "bad", "studio server unreachable");
  }
}

function resolveDims(): { w: number; h: number } {
  const mode = state.sizeMode;
  if (mode === "custom") return { w: state.w, h: state.h };
  if (mode === "fragment" && state.fragment) {
    return { w: state.fragment.w, h: state.fragment.h };
  }
  const preset = state.config?.sizes[mode];
  if (preset) return { w: preset.w, h: preset.h };
  return { w: state.w, h: state.h };
}

function syncDimInputs(dims: { w: number; h: number }) {
  wInput.value = String(dims.w);
  hInput.value = String(dims.h);
  const custom = state.sizeMode === "custom";
  wInput.disabled = hInput.disabled = !custom;
}

async function dataFor(widget: Widget): Promise<unknown> {
  if (state.dataCache.has(widget.key)) return state.dataCache.get(widget.key);
  try {
    const res = await getWidgetData(widget.key);
    state.dataCache.set(widget.key, res.data ?? null);
    if (res.source === "sample")
      setNote(`Previewing ${widget.key} with dev-gallery sample data (no live fetch).`, "");
    else if (res.source === "none")
      setNote(`No data for ${widget.key}; previewing its empty state.`, "warn");
    return res.data ?? null;
  } catch {
    state.dataCache.set(widget.key, null);
    setNote(`Could not load data for ${widget.key}; previewing with null data.`, "warn");
    return null;
  }
}

async function render() {
  if (!state.widget || !state.fragment) return;
  const dims = resolveDims();
  syncDimInputs(dims);
  badge.textContent = `${state.fragment.id} · ${dims.w}×${dims.h}`;
  if (!note.classList.contains("warn")) setNote("");

  const data = await dataFor(state.widget);

  // Fresh host each mount: attachShadow can only run once per element.
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
      options: {},
      data,
    });
  } catch (err) {
    setNote(`Mount failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

function populateFragments() {
  fragmentSel.innerHTML = "";
  const frags = state.widget?.fragments ?? [];
  for (const f of frags) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.id === "full" ? "full (whole widget)" : `${f.label} (${f.id})`;
    fragmentSel.appendChild(opt);
  }
  state.fragment = frags[0];
  fragmentSel.value = state.fragment?.id ?? "full";
}

// ---- wiring ----
widgetSel.addEventListener("change", () => {
  state.widget = state.widgets.find((w) => w.key === widgetSel.value);
  populateFragments();
  void render();
});

fragmentSel.addEventListener("change", () => {
  state.fragment = state.widget?.fragments.find((f) => f.id === fragmentSel.value);
  void render();
});

sizeSel.addEventListener("change", () => {
  state.sizeMode = sizeSel.value;
  void render();
});

for (const input of [wInput, hInput]) {
  input.addEventListener("input", () => {
    state.w = Number(wInput.value) || state.w;
    state.h = Number(hInput.value) || state.h;
    if (state.sizeMode === "custom") void render();
  });
}

async function boot() {
  await refreshHealth();
  setInterval(refreshHealth, 10_000);
  try {
    state.config = await getConfig();
  } catch {
    /* non-fatal; presets fall back to hard-coded option labels */
  }
  try {
    const catalog = await getCatalog();
    state.widgets = catalog.widgets ?? [];
  } catch (err) {
    setNote(`Could not load widget catalog: ${err instanceof Error ? err.message : err}`, "err");
    return;
  }
  if (!state.widgets.length) {
    setNote("No widgets installed on the connected Tesserae.", "warn");
    return;
  }
  for (const w of state.widgets) {
    const opt = document.createElement("option");
    opt.value = w.key;
    opt.textContent = w.name;
    widgetSel.appendChild(opt);
  }
  state.widget = state.widgets[0];
  widgetSel.value = state.widget.key;
  populateFragments();
  await render();
}

void boot();
