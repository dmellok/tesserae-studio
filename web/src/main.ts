import {
  duplicateWidget,
  getCatalog,
  getConfig,
  getFiles,
  getHealth,
  getPluginSchema,
  getWidgetData,
  lintWidget,
  mineSchema,
  readFile,
  registerWidget,
  scaffoldBundle,
  scaffoldWidget,
  unregisterWidget,
  writeFile,
} from "./api";
import type { LintFinding, MineResult } from "./api";
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
  sourceCache: Map<string, string>; // widget data source per render (live/sample/none)
  tier: "interactive" | "faithful";
  faithful: boolean; // is the faithful render tier available (mcp reachable)
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
  sourceCache: new Map(),
  tier: "interactive",
  faithful: false,
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
    <div class="topbar-right">
      <div class="pills">
        <span class="pill" id="mode"><span class="dot"></span><span id="mode-text">·</span></span>
        <span class="pill" id="conn"><span class="dot"></span><span id="conn-text">connecting…</span></span>
      </div>
      <button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle light / dark theme"><i class="ph-bold ph-moon"></i></button>
    </div>
  </header>
  <div class="toolbar">
    <div class="tool-fields">
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
    <div class="tool-actions">
      <button class="btn ghost" id="new-widget"><i class="ph-bold ph-plus"></i> New widget</button>
      <button class="btn ghost" id="new-bundle"><i class="ph-bold ph-stack"></i> New bundle</button>
    </div>
  </div>
  <dialog id="bundle-dialog" class="dialog">
    <form method="dialog" id="bundle-form">
      <h2>New bundle</h2>
      <p class="d-hint">A shared <code>&lt;name&gt;_core</code> companion (with an admin page) plus member widgets that read it.</p>
      <div class="field"><label for="bd-name">Bundle name</label>
        <input id="bd-name" type="text" placeholder="e.g. News" required /></div>
      <div class="field"><label for="bd-members">Members (one per line)</label>
        <textarea id="bd-members" rows="3" placeholder="Headlines&#10;Ticker"></textarea></div>
      <label class="check"><input id="bd-admin" type="checkbox" checked /> Include admin page (blueprint)</label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="bd-cancel">Cancel</button>
        <button type="submit" class="btn" id="bd-create">Create</button>
      </div>
    </form>
  </dialog>
  <dialog id="new-dialog" class="dialog">
    <form method="dialog" id="new-form">
      <h2>New widget</h2>
      <div class="field"><label for="nw-name">Name</label>
        <input id="nw-name" type="text" placeholder="e.g. Air Quality" required /></div>
      <div class="field"><label for="nw-arche">Archetype</label>
        <select id="nw-arche">
          <option value="stat">Stat</option>
          <option value="list">List</option>
          <option value="chart">Chart</option>
          <option value="status">Status</option>
          <option value="weather">Weather</option>
          <option value="calendar">Calendar</option>
          <option value="image">Image</option>
        </select></div>
      <label class="check"><input id="nw-server" type="checkbox" /> Include server.py</label>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" id="nw-cancel">Cancel</button>
        <button type="submit" class="btn" id="nw-create">Create</button>
      </div>
    </form>
  </dialog>
  <div class="workbench">
    <section class="editor-pane">
      <div class="pane-head">
        <div class="pane-id">
          <span class="pane-title" id="editor-widget">—</span>
          <span class="pane-sub" id="editor-sub"></span>
        </div>
        <div class="pane-status">
          <button class="pill register" id="register-btn" hidden><span class="dot"></span><span id="register-text"></span></button>
          <button class="pill" id="lint-pill" hidden><span class="dot"></span><span id="lint-text"></span></button>
        </div>
        <div class="pane-actions">
          <button class="btn ghost" id="mine-btn" hidden><i class="ph-bold ph-magic-wand"></i> Mine schema</button>
          <button class="btn" id="save" disabled>Save <kbd>⌘S</kbd></button>
        </div>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="editor-wrap">
        <div class="monaco" id="monaco"></div>
        <div class="editor-empty" id="editor-empty" hidden></div>
      </div>
      <div class="mine-panel" id="mine-panel" hidden></div>
      <div class="lint-panel" id="lint-panel" hidden></div>
    </section>
    <section class="preview-pane">
      <div class="stage-head">
        <div class="tier-toggle" role="tablist">
          <button class="tier-btn active" id="tier-interactive">Interactive</button>
          <button class="tier-btn" id="tier-faithful" title="True e-ink render through Tesserae">Faithful</button>
        </div>
        <span class="badge" id="badge"></span>
        <span class="src-chip" id="src" hidden></span>
      </div>
      <div class="cell-frame" id="frame"></div>
      <p class="note" id="note"></p>
    </section>
  </div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// -- theme (light / dark), same switch Tesserae's admin uses ---------------
const themeToggle = $<HTMLButtonElement>("theme-toggle");
function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "";
  themeToggle.innerHTML = `<i class="ph-bold ph-${theme === "dark" ? "sun" : "moon"}"></i>`;
  themeToggle.title = theme === "dark" ? "Switch to light" : "Switch to dark";
}
applyTheme((localStorage.getItem("studio-theme") as "light" | "dark") ?? "light");
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("studio-theme", next);
  applyTheme(next);
  editor.setTheme(next === "dark"); // editor exists by click time
});

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
const lintPill = $<HTMLButtonElement>("lint-pill");
const lintText = $<HTMLSpanElement>("lint-text");
const lintPanel = $<HTMLDivElement>("lint-panel");
lintPill.addEventListener("click", () => {
  if (lintPanel.innerHTML) lintPanel.hidden = !lintPanel.hidden;
});
const registerBtn = $<HTMLButtonElement>("register-btn");
const registerText = $<HTMLSpanElement>("register-text");
registerBtn.addEventListener("click", () => void toggleRegister());
const mineBtn = $<HTMLButtonElement>("mine-btn");
const minePanel = $<HTMLDivElement>("mine-panel");
mineBtn.addEventListener("click", () => void runMine());

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
    state.faithful = h.faithful;
    updateTierButtons();
  } catch {
    setPill("conn", "conn-text", "bad", "studio server unreachable");
    state.faithful = false;
    updateTierButtons();
  }
}

// -- preview tiers (interactive shadow-mount vs faithful e-ink PNG) ---------
const tierInteractive = $<HTMLButtonElement>("tier-interactive");
const tierFaithful = $<HTMLButtonElement>("tier-faithful");
tierInteractive.addEventListener("click", () => {
  state.tier = "interactive";
  void render();
});
tierFaithful.addEventListener("click", () => {
  if (tierFaithful.disabled) return;
  state.tier = "faithful";
  void render();
});

function faithfulReady(): boolean {
  return !!(state.faithful && state.widget?.registered);
}

function updateTierButtons() {
  const ok = faithfulReady();
  tierFaithful.disabled = !ok;
  tierFaithful.title = ok
    ? "True e-ink render through Tesserae"
    : !state.faithful
      ? "Connect a Tesserae (mcp experiment on) for the faithful render"
      : "Register this widget to Tesserae first";
  if (!ok && state.tier === "faithful") state.tier = "interactive";
  tierInteractive.classList.toggle("active", state.tier === "interactive");
  tierFaithful.classList.toggle("active", state.tier === "faithful");
}

function faithfulSize(dims: { w: number; h: number }): string {
  if (["xs", "sm", "md", "lg"].includes(state.sizeMode)) return state.sizeMode;
  const longer = Math.max(dims.w, dims.h);
  return longer <= 200 ? "xs" : longer <= 400 ? "sm" : longer <= 700 ? "md" : "lg";
}

function renderFaithful(dims: { w: number; h: number }) {
  setSourceChip("");
  frame.textContent = "";
  const size = faithfulSize(dims);
  const img = document.createElement("img");
  img.className = "cell faithful-img";
  img.alt = `${state.widget!.key} faithful render`;
  // ?t= busts the browser cache after an edit/register so the PNG re-renders.
  img.src = `/studio/api/render/${encodeURIComponent(state.widget!.key)}.png?size=${size}&t=${state.version}`;
  img.onerror = () =>
    setNote("Faithful render failed (needs the widget registered and Tesserae in debug mode).", "err");
  img.onload = () => {
    if (note.classList.contains("err")) setNote("");
  };
  frame.appendChild(img);
  setNote(
    state.fragment && state.fragment.id !== "full"
      ? "Faithful render shows the whole widget (fragments preview interactively only)."
      : "",
    "",
  );
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

function setSourceChip(source: "live" | "sample" | "none" | "") {
  const chip = $<HTMLSpanElement>("src");
  chip.hidden = !source;
  chip.classList.remove("live", "sample", "none");
  if (!source) return;
  chip.classList.add(source);
  chip.textContent =
    source === "live" ? "live data" : source === "sample" ? "sample data" : "no data";
}

async function dataFor(widget: Widget): Promise<unknown> {
  // Invalidate cache when we may have edited the widget (version bumped).
  const cacheKey = `${widget.key}@${state.version}`;
  if (state.dataCache.has(cacheKey)) {
    setSourceChip((state.sourceCache.get(cacheKey) as "live" | "sample" | "none") ?? "");
    return state.dataCache.get(cacheKey);
  }
  try {
    const res = await getWidgetData(widget.key);
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

function isWidgetKind(w: Widget): boolean {
  return !w.kind || w.kind === "widget";
}

async function render() {
  if (!state.widget || !state.fragment) return;

  // Companion plugins (a bundle's _core, kind data) don't render as widgets.
  if (!isWidgetKind(state.widget)) {
    setSourceChip("");
    badge.textContent = state.widget.kind ?? "companion";
    frame.classList.add("is-empty");
    frame.innerHTML = `
      <div class="empty-state">
        <i class="empty-ico ph-bold ph-plugs-connected"></i>
        <p class="empty-title">${escapeHtml(state.widget.name)} is a companion plugin</p>
        <p class="empty-text">Companions have no widget render. Configure it on its admin page in Tesserae, and register it so member widgets can read it.</p>
      </div>`;
    setNote(`Companion plugin (${state.widget.kind}) · configure on its admin page in Tesserae.`, "");
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

// -- register with Tesserae (symlink when local, push over MCP when remote) -
function renderRegister(widget: Widget) {
  const method = state.config?.registration ?? "none";
  if (!widget.editable || method === "none") {
    registerBtn.hidden = true;
    return;
  }
  registerBtn.hidden = false;
  registerBtn.classList.remove("ok", "warn");
  const how = method === "push" ? "Push over MCP" : "Symlink";
  if (widget.registered) {
    registerBtn.classList.add("ok");
    registerText.textContent = "registered · live";
    registerBtn.title = "Live in Tesserae (real data + faithful render). Click to unregister.";
  } else if (widget.synced) {
    registerBtn.classList.add("warn");
    registerText.textContent = "synced · restart Tesserae";
    registerBtn.title = "Symlinked into Tesserae. Restart Tesserae to register it. Click to unregister.";
  } else {
    registerText.textContent = "Register to Tesserae";
    registerBtn.title = `${how} this widget into Tesserae for live data + faithful render.`;
  }
}

async function toggleRegister() {
  const w = state.widget;
  if (!w?.editable) return;
  const registered = w.registered || w.synced;
  registerBtn.disabled = true;
  try {
    const res = registered ? await unregisterWidget(w.key) : await registerWidget(w.key);
    await refreshCatalog(w.key); // pick up fresh registered/synced flags
    if (state.widget) renderRegister(state.widget);
    if (registered) setNote(`Unregistered ${w.key}.`, "");
    else if (res.method === "push")
      setNote(
        res.active
          ? `Pushed ${w.key} to Tesserae over MCP. Live now.`
          : `Pushed ${w.key}; Tesserae is restarting to register it.`,
        res.active ? "" : "warn",
      );
    else if (res.needs_reload)
      setNote(`Synced ${w.key}. Restart Tesserae to register it (then live data + faithful render).`, "warn");
    else setNote(`${w.key} is registered and live.`, "");
    state.version = Date.now(); // re-evaluate the data source (live vs sample)
    await render();
  } catch (err) {
    setNote(`Register failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    registerBtn.disabled = false;
  }
}

// -- mine_data_schema ------------------------------------------------------
async function runMine() {
  const w = state.widget;
  if (!w?.editable) return;
  mineBtn.disabled = true;
  mineBtn.textContent = "Mining…";
  try {
    const res = await mineSchema(w.key, { source: "auto" });
    renderMinePanel(res);
  } catch (err) {
    setNote(`Mine failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    mineBtn.disabled = false;
    mineBtn.innerHTML = '<i class="ph-bold ph-magic-wand"></i> Mine schema';
  }
}

function renderMinePanel(res: MineResult) {
  const d = res.diff;
  const diffBits = [
    d.added.length ? `+${d.added.length}` : "",
    d.changed.length ? `~${d.changed.length}` : "",
    d.removed.length ? `-${d.removed.length}` : "",
  ].filter(Boolean).join(" ");
  const rows = res.fields
    .map(
      (f) =>
        `<div class="mine-row">
           <code class="mine-name">${escapeHtml(f.name)}</code>
           <span class="mine-type t-${f.type}">${f.type}${f.unit ? " " + escapeHtml(f.unit) : ""}</span>
           <span class="mine-disp">${f.chartable ? "chartable" : f.display}</span>
         </div>`,
    )
    .join("");
  const warns = res.warnings.map((w) => `<div class="mine-warn">${escapeHtml(w)}</div>`).join("");
  minePanel.innerHTML = `
    <div class="mine-head">
      <span>Mined <b>${res.fields.length}</b> fields from <b>${res.data_source}</b> data${diffBits ? ` · <span class="mine-diff">${diffBits}</span> vs declared` : ""}</span>
      <button class="btn" id="mine-apply">Apply to plugin.json</button>
      <button class="pill" id="mine-close">Dismiss</button>
    </div>
    ${rows}${warns}`;
  minePanel.hidden = false;
  minePanel.querySelector("#mine-apply")?.addEventListener("click", () => void applyMine());
  minePanel.querySelector("#mine-close")?.addEventListener("click", () => {
    minePanel.hidden = true;
  });
}

async function applyMine() {
  const w = state.widget;
  if (!w?.editable) return;
  try {
    const res = await mineSchema(w.key, { source: "auto", apply: true });
    // Refresh plugin.json in the editor without losing edits to other files.
    const content = (await readFile(w.key, "plugin.json")).content;
    editor.setValue("plugin.json", content);
    editor.markSaved("plugin.json");
    renderTabs();
    await runLint(w);
    minePanel.hidden = true;
    setNote(`Applied data_schema (${res.fields.length} fields) to plugin.json.`, "");
  } catch (err) {
    setNote(`Apply failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

// -- lint ------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function openFile(path: string) {
  if (!editor.has(path)) return;
  state.activeFile = path;
  editor.show(path);
  renderTabs();
  saveBtn.disabled = !editor.isDirty(path);
}

async function runLint(widget: Widget) {
  if (!widget.editable) {
    lintPill.hidden = true;
    lintPanel.hidden = true;
    lintPanel.innerHTML = "";
    return;
  }
  try {
    const res = await lintWidget(widget.key);
    renderLint(res.findings, res.errors, res.warnings);
  } catch {
    lintPill.hidden = true;
  }
}

function renderLint(findings: LintFinding[], errors: number, warnings: number) {
  lintPill.hidden = false;
  lintPill.classList.remove("ok", "warn", "bad");
  if (errors) {
    lintPill.classList.add("bad");
    lintText.textContent = `${errors} error${errors > 1 ? "s" : ""}${warnings ? ` · ${warnings} warn` : ""}`;
  } else if (warnings) {
    lintPill.classList.add("warn");
    lintText.textContent = `${warnings} warning${warnings > 1 ? "s" : ""}`;
  } else {
    lintPill.classList.add("ok");
    lintText.textContent = "lint clean";
  }
  lintPanel.innerHTML =
    `<div class="lint-head"><i class="ph-bold ph-list-magnifying-glass"></i>` +
    `<span>${findings.length} finding${findings.length > 1 ? "s" : ""}</span></div>`;
  for (const f of findings) {
    const row = document.createElement("button");
    row.className = `lint-row ${f.level}`;
    row.innerHTML =
      `<i class="lint-ico ph-bold ${f.level === "error" ? "ph-x-circle" : "ph-warning"}"></i>` +
      `<span class="lint-msg">${escapeHtml(f.message)}</span>` +
      `<span class="lint-loc">${f.file}${f.line ? `:${f.line}` : ""}</span>`;
    row.addEventListener("click", () => {
      openFile(f.file);
      editor.reveal(f.file, f.line);
    });
    lintPanel.appendChild(row);
  }
  lintPanel.hidden = findings.length === 0;
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
    emptyEl.innerHTML = `
      <div class="empty-state">
        <i class="empty-ico ph-bold ph-book-open-text"></i>
        <p class="empty-title">${escapeHtml(widget.name)} is a reference widget</p>
        <p class="empty-text">Read-only — it lives outside your workspace. Duplicate it to edit and preview your own copy.</p>
        <button class="btn" id="dup-btn"><i class="ph-bold ph-copy"></i> Duplicate to workspace</button>
      </div>`;
    emptyEl.querySelector("#dup-btn")?.addEventListener("click", () => void duplicate(widget));
    $<HTMLSpanElement>("editor-widget").textContent = widget.name;
    $<HTMLSpanElement>("editor-sub").textContent = "read-only";
    void runLint(widget); // hides the pill for read-only widgets
    registerBtn.hidden = true;
    mineBtn.hidden = true;
    minePanel.hidden = true;
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
  renderRegister(widget); // cores register too, so members can read them
  minePanel.hidden = true;
  // Lint + mine are widget-only; a companion core is edited as plain files.
  const widgetKind = isWidgetKind(widget);
  mineBtn.hidden = !widgetKind;
  if (widgetKind) void runLint(widget);
  else lintPill.hidden = true;
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
  await runLint(widget);
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

// -- scaffold + duplicate --------------------------------------------------
const newDialog = $<HTMLDialogElement>("new-dialog");
$<HTMLButtonElement>("new-widget").addEventListener("click", () => newDialog.showModal());
$<HTMLButtonElement>("nw-cancel").addEventListener("click", () => newDialog.close());
$<HTMLFormElement>("new-form").addEventListener("submit", () => {
  // method="dialog" closes the dialog; create after it closes.
  const name = $<HTMLInputElement>("nw-name").value.trim();
  if (!name) return;
  const archetype = $<HTMLSelectElement>("nw-arche").value;
  const server = $<HTMLInputElement>("nw-server").checked;
  void createWidget({ name, archetype, server });
});

async function createWidget(spec: { name: string; archetype: string; server: boolean }) {
  try {
    const res = await scaffoldWidget(spec);
    await refreshCatalog(res.key);
    await selectWidget(res.key);
    $<HTMLInputElement>("nw-name").value = "";
    setNote(`Created ${res.key} (${res.files.length} files). Edit and save to preview.`, "");
  } catch (err) {
    setNote(`Scaffold failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

// -- new bundle ------------------------------------------------------------
const bundleDialog = $<HTMLDialogElement>("bundle-dialog");
$<HTMLButtonElement>("new-bundle").addEventListener("click", () => bundleDialog.showModal());
$<HTMLButtonElement>("bd-cancel").addEventListener("click", () => bundleDialog.close());
$<HTMLFormElement>("bundle-form").addEventListener("submit", () => {
  const name = $<HTMLInputElement>("bd-name").value.trim();
  if (!name) return;
  const members = $<HTMLTextAreaElement>("bd-members").value
    .split("\n").map((s) => s.trim()).filter(Boolean).map((n) => ({ name: n }));
  const admin = $<HTMLInputElement>("bd-admin").checked;
  void createBundle({ name, members: members.length ? members : [{ name: "Items" }], admin });
});

async function createBundle(spec: { name: string; members: Array<{ name: string }>; admin: boolean }) {
  try {
    const res = await scaffoldBundle(spec);
    await refreshCatalog(res.members[0] ?? res.core);
    await selectWidget(res.members[0] ?? res.core);
    $<HTMLInputElement>("bd-name").value = "";
    $<HTMLTextAreaElement>("bd-members").value = "";
    setNote(
      `Created bundle: ${res.core} + ${res.members.join(", ")}. Register the core and each member with Tesserae for the family to work.`,
      "",
    );
  } catch (err) {
    setNote(`Bundle scaffold failed: ${err instanceof Error ? err.message : String(err)}`, "err");
  }
}

async function duplicate(widget: Widget) {
  const name = window.prompt(`Duplicate "${widget.name}" into your workspace as:`, `${widget.name} copy`);
  if (!name) return;
  try {
    const res = await duplicateWidget(widget.key, name);
    await refreshCatalog(res.key);
    await selectWidget(res.key);
    setNote(`Duplicated ${widget.key} → ${res.key}. Now editable.`, "");
  } catch (err) {
    setNote(`Duplicate failed: ${err instanceof Error ? err.message : String(err)}`, "err");
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
