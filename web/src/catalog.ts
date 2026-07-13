// The widget catalog + picker: load the merged workspace/reference catalog,
// populate the widget and fragment selects, drive selection, and the toolbar's
// "New widget" / "New bundle" scaffold dialogs.

import { getCatalog, scaffoldBundle, scaffoldWidget } from "./api";
import { loadWidgetConfig } from "./configForm";
import { markLocalMutation } from "./events";
import { parseMembers } from "./logic";
import { render } from "./preview";
import { state } from "./state";
import { $, setNote } from "./ui";
import { loadEditor } from "./workspace";

function populateFragments() {
  const fragmentSel = $<HTMLSelectElement>("fragment");
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

export async function selectWidget(key: string) {
  state.widget = state.widgets.find((w) => w.key === key);
  if (!state.widget) return;
  $<HTMLSelectElement>("widget").value = key;
  populateFragments();
  await loadWidgetConfig(key); // sets state.options (defaults) before first render
  await Promise.all([loadEditor(state.widget), render()]);
}

export async function refreshCatalog(keepKey?: string) {
  const widgetSel = $<HTMLSelectElement>("widget");
  const catalog = await getCatalog();
  state.widgets = catalog.widgets ?? [];
  widgetSel.innerHTML = "";
  for (const w of state.widgets) {
    const opt = document.createElement("option");
    opt.value = w.key;
    opt.textContent = w.editable ? `${w.name}  ·  editable` : w.name;
    widgetSel.appendChild(opt);
  }
  const key =
    keepKey && state.widgets.some((w) => w.key === keepKey) ? keepKey : state.widgets[0]?.key;
  if (key) {
    state.widget = state.widgets.find((w) => w.key === key);
    widgetSel.value = key;
    populateFragments();
  }
}

async function createWidget(spec: { name: string; archetype: string; server: boolean }) {
  markLocalMutation();
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

async function createBundle(spec: {
  name: string;
  members: Array<{ name: string }>;
  admin: boolean;
}) {
  markLocalMutation();
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

// Wire the widget/fragment selects and the two scaffold dialogs.
export function initCatalog() {
  const widgetSel = $<HTMLSelectElement>("widget");
  const fragmentSel = $<HTMLSelectElement>("fragment");
  widgetSel.addEventListener("change", () => void selectWidget(widgetSel.value));
  fragmentSel.addEventListener("change", () => {
    state.fragment = state.widget?.fragments.find((f) => f.id === fragmentSel.value);
    void render();
  });

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

  const bundleDialog = $<HTMLDialogElement>("bundle-dialog");
  $<HTMLButtonElement>("new-bundle").addEventListener("click", () => bundleDialog.showModal());
  $<HTMLButtonElement>("bd-cancel").addEventListener("click", () => bundleDialog.close());
  $<HTMLFormElement>("bundle-form").addEventListener("submit", () => {
    const name = $<HTMLInputElement>("bd-name").value.trim();
    if (!name) return;
    const members = parseMembers($<HTMLTextAreaElement>("bd-members").value);
    const admin = $<HTMLInputElement>("bd-admin").checked;
    void createBundle({ name, members: members.length ? members : [{ name: "Items" }], admin });
  });
}
