import {
  getCatalog,
  getConfig,
  getFiles,
  getHealth,
  getPluginSchema,
  getWidgetData,
  readFile,
  writeFile,
} from "./api";
import { mountWidget } from "./mount";
import { WidgetEditor, type OpenFile } from "./editor";
import type { Config, FileEntry, Fragment, Widget } from "./types";
import "./style.css";

const PANEL = { w: 1200, h: 825 };

interface State {
  config?: Config;
  widgets: Widget[];
  widget?: Widget;
  fragment?: Fragment;
  sizeMode: string;
  w: number;
  h: number;
  dataCache: Map<string, unknown>;
  version: number; // mount cache-bust, bumped on save
  files: FileEntry[];
  activeFile?: string;
}

const state: State = {
  widgets: [],
  sizeMode: "md",
  w: 640,
  h: 400,
  dataCache: new Map(),
  version: 0,
  files: [],
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
  <div class="toolbar">
    <div class="field"><label for="widget">Widget</label><select id="widget"></select></div>
    <div class="field"><label for="fragment">Fragment</label><select id="fragment"></select></div>
    <div class="field"><label for="size">Size</label>
      <select id="size">
        <option value="xs">xs (180×180)</option>
        <option value="sm">sm (380×240)</option>
        <option value="md" selected>md (640×400)</option>
        <option value="lg">lg (1200×800)</option>
        <option value="fragment">fragment size</option>
        <option value="custom">custom…</option>
      </select>
    </div>
    <div class="field dim"><label for="w">Width</label><input id="w" type="number" min="20" max="2000" value="640" /></div>
    <div class="field dim"><label for="h">Height</label><input id="h" type="number" min="20" max="2000" value="400" /></div>
  </div>
  <div class="workbench">
    <section class="editor-pane">
      <div class="pane-head">
        <span class="pane-title" id="editor-widget">—</span>
        <span class="pane-sub" id="editor-sub"></span>
        <button class="btn" id="save" disabled>Save <kbd>⌘S</kbd></button>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="editor-wrap">
        <div class="monaco" id="monaco"></div>
        <div class="editor-empty" id="editor-empty" hidden></div>
      </div>
    </section>
    <section class="preview-pane">
      <div class="stage-head">
        <span class="tier">Interactive preview</span>
        <span class="badge" id="badge"></span>
      </div>
      <div class="cell-frame" id="frame"></div>
      <p class="note" id="note"></p>
    </section>
  </div>
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
const tabsEl = $<HTMLDivElement>("tabs");
const saveBtn = $<HTMLButtonElement>("save");
const emptyEl = $<HTMLDivElement>("editor-empty");

const editor = new WidgetEditor($<HTMLDivElement>("monaco"));
editor.onDirtyChange(() => {
  renderTabs();
  saveBtn.disabled = !state.activeFile || !editor.isDirty(state.activeFile);
});
editor.onSaveRequest(() => void save());
saveBtn.addEventListener("click", () => void save());

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
    if (h.mode === "disk") setPill("mode", "mode-text", "ok", "disk · standalone");
    else if (h.mode === "live") setPill("mode", "mode-text", "ok", "live");
    else setPill("mode", "mode-text", "bad", "no source");
    if (h.tesserae !== "ok")
      setPill("conn", "conn-text", h.mode === "disk" ? "warn" : "bad", "Tesserae offline");
    else if (h.mcp === "off") setPill("conn", "conn-text", "warn", 'enable the "mcp" experiment');
    else setPill("conn", "conn-text", "ok", h.live_data ? "live data + faithful" : "connected");
  } catch {
    setPill("conn", "conn-text", "bad", "studio server unreachable");
  }
}

// -- preview ---------------------------------------------------------------
function resolveDims(): { w: number; h: number } {
  const mode = state.sizeMode;
  if (mode === "custom") return { w: state.w, h: state.h };
  if (mode === "fragment" && state.fragment) return { w: state.fragment.w, h: state.fragment.h };
  const preset = state.config?.sizes[mode];
  return preset ? { w: preset.w, h: preset.h } : { w: state.w, h: state.h };
}

function syncDimInputs(dims: { w: number; h: number }) {
  wInput.value = String(dims.w);
  hInput.value = String(dims.h);
  const custom = state.sizeMode === "custom";
  wInput.disabled = hInput.disabled = !custom;
}

async function dataFor(widget: Widget): Promise<unknown> {
  // Invalidate cache when we may have edited the widget (version bumped).
  const cacheKey = `${widget.key}@${state.version}`;
  if (state.dataCache.has(cacheKey)) return state.dataCache.get(cacheKey);
  try {
    const res = await getWidgetData(widget.key);
    state.dataCache.set(cacheKey, res.data ?? null);
    if (res.source === "sample")
      setNote(`Previewing ${widget.key} with dev-gallery sample data (no live fetch).`, "");
    else if (res.source === "none" && !widget.editable)
      setNote(`No data for ${widget.key}; previewing its empty state.`, "warn");
    return res.data ?? null;
  } catch {
    state.dataCache.set(cacheKey, null);
    return null;
  }
}

async function render() {
  if (!state.widget || !state.fragment) return;
  const dims = resolveDims();
  syncDimInputs(dims);
  badge.textContent = `${state.fragment.id} · ${dims.w}×${dims.h}`;
  const data = await dataFor(state.widget);

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
      version: state.version,
    });
  } catch (err) {
    setNote(`Mount failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

// -- editor ----------------------------------------------------------------
function renderTabs() {
  tabsEl.innerHTML = "";
  for (const f of state.files) {
    const tab = document.createElement("button");
    tab.className = "tab" + (f.path === state.activeFile ? " active" : "");
    tab.textContent = f.path;
    if (editor.isDirty(f.path)) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      tab.appendChild(dot);
    }
    tab.addEventListener("click", () => {
      state.activeFile = f.path;
      editor.show(f.path);
      renderTabs();
      saveBtn.disabled = !editor.isDirty(f.path);
    });
    tabsEl.appendChild(tab);
  }
}

async function loadEditor(widget: Widget) {
  if (!widget.editable) {
    state.files = [];
    state.activeFile = undefined;
    tabsEl.innerHTML = "";
    saveBtn.disabled = true;
    emptyEl.hidden = false;
    emptyEl.textContent = `${widget.name} is a read-only reference widget (not in your workspace). Previewing only.`;
    $<HTMLSpanElement>("editor-widget").textContent = widget.name;
    $<HTMLSpanElement>("editor-sub").textContent = "read-only";
    return;
  }
  emptyEl.hidden = true;
  $<HTMLSpanElement>("editor-widget").textContent = widget.name;
  $<HTMLSpanElement>("editor-sub").textContent = widget.key;

  const listing = await getFiles(widget.key);
  state.files = listing.files.filter((f) => f.editable);
  const contents = await Promise.all(
    state.files.map((f) => readFile(widget.key, f.path).then((r) => r.content)),
  );
  const open: OpenFile[] = state.files.map((f, i) => ({
    path: f.path,
    content: contents[i],
    language: f.language,
    editable: true,
  }));
  // Open plugin.json first if present, else client.js, else first file.
  const preferred =
    open.find((f) => f.path === "plugin.json")?.path ??
    open.find((f) => f.path === "client.js")?.path ??
    open[0]?.path;
  editor.setReadOnly(false);
  editor.open(widget.key, open, preferred);
  state.activeFile = preferred;
  renderTabs();
  saveBtn.disabled = true;
}

async function save() {
  const widget = state.widget;
  if (!widget?.editable || !state.activeFile) return;
  const path = state.activeFile;
  try {
    await writeFile(widget.key, path, editor.value(path));
  } catch (err) {
    setNote(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
    return;
  }
  editor.markSaved(path);
  renderTabs();
  saveBtn.disabled = true;
  state.version = Date.now(); // bust the client.js import + data cache
  // Editing the manifest can change fragments/name; refresh the catalog entry.
  if (path === "plugin.json") await refreshCatalog(widget.key);
  await render();
  setNote(`Saved ${path}. Preview updated.`, "");
}

// -- catalog + selection ---------------------------------------------------
function populateFragments() {
  fragmentSel.innerHTML = "";
  const frags = state.widget?.fragments ?? [];
  for (const f of frags) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.id === "full" ? "full (whole widget)" : `${f.label} (${f.id})`;
    fragmentSel.appendChild(opt);
  }
  // Keep current fragment if it still exists, else fall back to the first.
  const keep = frags.find((f) => f.id === state.fragment?.id) ?? frags[0];
  state.fragment = keep;
  fragmentSel.value = keep?.id ?? "full";
}

async function selectWidget(key: string) {
  state.widget = state.widgets.find((w) => w.key === key);
  if (!state.widget) return;
  widgetSel.value = key;
  populateFragments();
  await Promise.all([loadEditor(state.widget), render()]);
}

async function refreshCatalog(keepKey?: string) {
  const catalog = await getCatalog();
  state.widgets = catalog.widgets ?? [];
  widgetSel.innerHTML = "";
  for (const w of state.widgets) {
    const opt = document.createElement("option");
    opt.value = w.key;
    opt.textContent = w.editable ? `${w.name}  ·  editable` : w.name;
    widgetSel.appendChild(opt);
  }
  const key = keepKey && state.widgets.some((w) => w.key === keepKey) ? keepKey : state.widgets[0]?.key;
  if (key) {
    state.widget = state.widgets.find((w) => w.key === key);
    widgetSel.value = key;
    populateFragments();
  }
}

// -- wiring ----------------------------------------------------------------
widgetSel.addEventListener("change", () => void selectWidget(widgetSel.value));
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
    /* presets fall back to option labels */
  }
  try {
    editor.setSchema(await getPluginSchema());
  } catch {
    /* schema optional; validation just won't run */
  }
  try {
    await refreshCatalog();
  } catch (err) {
    setNote(`Could not load widget catalog: ${err instanceof Error ? err.message : err}`, "err");
    return;
  }
  if (!state.widgets.length) {
    setNote("No widgets found. Add one to the workspace or connect a Tesserae.", "warn");
    return;
  }
  // Prefer opening an editable workspace widget first.
  const first = state.widgets.find((w) => w.editable) ?? state.widgets[0];
  await selectWidget(first.key);
}

// Dev-only handle for automated smoke tests (driving Monaco through the DOM is
// unreliable). Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __studio: unknown }).__studio = { editor, save, state };
}

void boot();
