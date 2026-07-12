// The authoring pane: the file tabs + editor, Save, the register-to-Tesserae
// control, and the mine-schema panel. All of it operates on the shared editor
// instance and the currently-selected widget's files.

import {
  duplicateWidget,
  getFiles,
  mineSchema,
  readFile,
  registerWidget,
  unregisterWidget,
  writeFile,
} from "./api";
import type { MineResult } from "./api";
import { refreshCatalog, selectWidget } from "./catalog";
import type { OpenFile } from "./editor";
import { getEditor } from "./editorInstance";
import { escapeHtml, mineDiffBits } from "./logic";
import { isWidgetKind, render } from "./preview";
import { runLint } from "./lintPanel";
import { state } from "./state";
import type { Widget } from "./types";
import { $, setNote } from "./ui";

// -- editor + tabs ---------------------------------------------------------
function renderTabs() {
  const tabsEl = $<HTMLDivElement>("tabs");
  const saveBtn = $<HTMLButtonElement>("save");
  const editor = getEditor();
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

export function openFile(path: string) {
  const editor = getEditor();
  if (!editor.has(path)) return;
  state.activeFile = path;
  editor.show(path);
  renderTabs();
  $<HTMLButtonElement>("save").disabled = !editor.isDirty(path);
}

export async function loadEditor(widget: Widget) {
  const editor = getEditor();
  const emptyEl = $<HTMLDivElement>("editor-empty");
  const saveBtn = $<HTMLButtonElement>("save");
  const registerBtn = $<HTMLButtonElement>("register-btn");
  const mineBtn = $<HTMLButtonElement>("mine-btn");
  const minePanel = $<HTMLDivElement>("mine-panel");
  const lintPill = $<HTMLButtonElement>("lint-pill");
  if (!widget.editable) {
    state.files = [];
    state.activeFile = undefined;
    $<HTMLDivElement>("tabs").innerHTML = "";
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
  const editor = getEditor();
  const path = state.activeFile;
  try {
    await writeFile(widget.key, path, editor.value(path));
  } catch (err) {
    setNote(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "err");
    return;
  }
  editor.markSaved(path);
  renderTabs();
  $<HTMLButtonElement>("save").disabled = true;
  state.version = Date.now(); // bust the client.js import + data cache
  // Editing the manifest can change fragments/name; refresh the catalog entry.
  if (path === "plugin.json") await refreshCatalog(widget.key);
  await render();
  await runLint(widget);
  setNote(`Saved ${path}. Preview updated.`, "");
}

// -- register with Tesserae (symlink when local, push over MCP when remote) -
function renderRegister(widget: Widget) {
  const registerBtn = $<HTMLButtonElement>("register-btn");
  const registerText = $<HTMLSpanElement>("register-text");
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
  const registerBtn = $<HTMLButtonElement>("register-btn");
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
  const mineBtn = $<HTMLButtonElement>("mine-btn");
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
  const minePanel = $<HTMLDivElement>("mine-panel");
  const diffBits = mineDiffBits(res.diff);
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
  const editor = getEditor();
  try {
    const res = await mineSchema(w.key, { source: "auto", apply: true });
    // Refresh plugin.json in the editor without losing edits to other files.
    const content = (await readFile(w.key, "plugin.json")).content;
    editor.setValue("plugin.json", content);
    editor.markSaved("plugin.json");
    renderTabs();
    await runLint(w);
    $<HTMLDivElement>("mine-panel").hidden = true;
    setNote(`Applied data_schema (${res.fields.length} fields) to plugin.json.`, "");
  } catch (err) {
    setNote(`Apply failed: ${err instanceof Error ? err.message : String(err)}`, "err");
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

// Wire the editor callbacks and the pane-head action buttons.
export function initWorkspace() {
  const editor = getEditor();
  const saveBtn = $<HTMLButtonElement>("save");
  editor.onDirtyChange(() => {
    renderTabs();
    saveBtn.disabled = !state.activeFile || !editor.isDirty(state.activeFile);
  });
  editor.onSaveRequest(() => void save());
  saveBtn.addEventListener("click", () => void save());
  $<HTMLButtonElement>("register-btn").addEventListener("click", () => void toggleRegister());
  $<HTMLButtonElement>("mine-btn").addEventListener("click", () => void runMine());
}

// Exposed for the dev-only smoke handle in main.ts.
export { save };
