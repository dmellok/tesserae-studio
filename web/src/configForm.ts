// Widget config: render a form from the widget's cell_options, keep the values
// in state.options, and re-render the preview on change. Plus the embedded admin
// page (a companion's blueprint()) shown in an iframe proxied through Studio.

import { getWidgetAdmin, getWidgetOptions } from "./api";
import type { WidgetOption } from "./api";
import { escapeHtml, optionDefaults } from "./logic";
import { render } from "./preview";
import { state } from "./state";
import { $ } from "./ui";

let schema: WidgetOption[] = [];
let adminUrl = "";

function controlHtml(opt: WidgetOption): string {
  const name = opt.name;
  const val = state.options[name];
  const label = escapeHtml(opt.label || name);
  const dn = escapeHtml(name);
  const id = `cfg-${dn}`;

  if (opt.type === "boolean") {
    return (
      `<label class="cfg-check"><span>${label}</span>` +
      `<input type="checkbox" data-name="${dn}" data-type="boolean" ${val ? "checked" : ""} /></label>`
    );
  }
  if (opt.type === "multiselect") {
    const boxes = (opt.choices || [])
      .map((c) => {
        const on = Array.isArray(val) && (val as unknown[]).map(String).includes(c.value);
        return (
          `<label class="cfg-multi"><input type="checkbox" data-name="${dn}" data-type="multiselect" ` +
          `value="${escapeHtml(c.value)}" ${on ? "checked" : ""}/> ${escapeHtml(c.label || c.value)}</label>`
        );
      })
      .join("");
    return `<div class="field"><label>${label}</label><div class="cfg-multiset">${boxes}</div></div>`;
  }

  let control: string;
  switch (opt.type) {
    case "number":
    case "slider": {
      const t = opt.type === "slider" ? "range" : "number";
      const min = opt.min ?? 0;
      const max = opt.max ?? 100;
      const step = opt.step ?? 1;
      control = `<input type="${t}" id="${id}" data-name="${dn}" data-type="number" value="${val ?? ""}" min="${min}" max="${max}" step="${step}" />`;
      break;
    }
    case "color":
      control = `<input type="color" id="${id}" data-name="${dn}" data-type="string" value="${escapeHtml(String(val ?? "#000000"))}" />`;
      break;
    case "textarea":
    case "variables_textarea":
      control = `<textarea id="${id}" data-name="${dn}" data-type="string" rows="3">${escapeHtml(String(val ?? ""))}</textarea>`;
      break;
    case "select": {
      const rows = (opt.choices || [])
        .map(
          (c) =>
            `<option value="${escapeHtml(c.value)}" ${String(val) === c.value ? "selected" : ""}>${escapeHtml(c.label || c.value)}</option>`,
        )
        .join("");
      control = `<select id="${id}" data-name="${dn}" data-type="string">${rows}</select>`;
      break;
    }
    default: {
      // string / location_search / entity / entity_overrides / unknown -> text.
      const ph = opt.choices_from ? ` placeholder="dynamic: ${escapeHtml(opt.choices_from)}"` : "";
      control = `<input type="text" id="${id}" data-name="${dn}" data-type="string" value="${escapeHtml(String(val ?? ""))}"${ph} />`;
    }
  }
  return `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
}

function renderForm() {
  const panel = $<HTMLDivElement>("config-panel");
  if (!schema.length) {
    panel.innerHTML = `<div class="cfg-empty">This widget declares no cell_options.</div>`;
    return;
  }
  panel.innerHTML =
    `<div class="cfg-head"><span>Options</span><button type="button" class="btn ghost" id="cfg-reset">Reset</button></div>` +
    schema.map(controlHtml).join("");
  panel.querySelector("#cfg-reset")?.addEventListener("click", () => {
    state.options = optionDefaults(schema);
    renderForm();
    void render();
  });
}

function onFormChange(e: Event) {
  const el = e.target as HTMLInputElement & HTMLSelectElement;
  const name = el.dataset.name;
  if (!name) return;
  const type = el.dataset.type;
  if (type === "boolean") {
    state.options[name] = el.checked;
  } else if (type === "number") {
    state.options[name] = Number(el.value);
  } else if (type === "multiselect") {
    const on = $<HTMLDivElement>("config-panel").querySelectorAll<HTMLInputElement>(
      `input[data-name="${CSS.escape(name)}"]:checked`,
    );
    state.options[name] = Array.from(on).map((b) => b.value);
  } else {
    state.options[name] = el.value;
  }
  void render();
}

// -- admin page (iframe) ---------------------------------------------------
function hideAdmin() {
  const frame = $<HTMLIFrameElement>("admin-frame");
  frame.hidden = true;
  frame.removeAttribute("src");
  $<HTMLDivElement>("frame").hidden = false;
  $<HTMLButtonElement>("admin-btn").classList.remove("active");
}

function toggleAdmin() {
  const frame = $<HTMLIFrameElement>("admin-frame");
  if (frame.hidden) {
    frame.src = adminUrl;
    frame.hidden = false;
    $<HTMLDivElement>("frame").hidden = true;
    $<HTMLButtonElement>("admin-btn").classList.add("active");
  } else {
    hideAdmin();
  }
}

// Load a widget's config schema + admin availability. Called on widget select.
export async function loadWidgetConfig(key: string) {
  schema = [];
  adminUrl = "";
  hideAdmin();
  const adminBtn = $<HTMLButtonElement>("admin-btn");
  adminBtn.hidden = true;
  try {
    const [opts, admin] = await Promise.all([getWidgetOptions(key), getWidgetAdmin(key)]);
    schema = opts.options || [];
    state.options = optionDefaults(schema);
    adminUrl = admin.url;
    adminBtn.hidden = !admin.has_admin;
  } catch {
    state.options = {};
  }
  renderForm();
}

export function initConfig() {
  const panel = $<HTMLDivElement>("config-panel");
  const configBtn = $<HTMLButtonElement>("config-btn");
  configBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    configBtn.classList.toggle("active", !panel.hidden);
  });
  $<HTMLButtonElement>("admin-btn").addEventListener("click", toggleAdmin);
  panel.addEventListener("input", onFormChange);
}
