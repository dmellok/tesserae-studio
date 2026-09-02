// Widget config: render a form from the widget's cell_options, keep the values
// in state.options, and re-render the preview on change. Plus the embedded admin
// page (a companion's blueprint()) shown in an iframe proxied through Studio.

import {
  getWidgetAdmin,
  getWidgetChoices,
  getWidgetOptions,
  getWidgetSettings,
  setWidgetSettings,
} from "./api";
import type { WidgetChoice, WidgetOption, WidgetSetting } from "./api";
import { markLocalMutation } from "./events";
import { escapeHtml, optionDefaults } from "./logic";
import { render } from "./preview";
import { state } from "./state";
import { $, setNote } from "./ui";

let schema: WidgetOption[] = [];
let adminUrl = "";
let settingsSchema: WidgetSetting[] = [];
let settingsValues: Record<string, unknown> = {};
interface DynamicChoiceState {
  input: string;
  query: string;
  total: number;
  hasLoaded: boolean;
  mode: "closed" | "browse" | "search";
  status: "loading" | "ready" | "error";
  error: string;
  requestId: number;
  known: Map<string, WidgetChoice>;
  pendingQuery: string | null;
  searchTimer: ReturnType<typeof setTimeout> | null;
}
// Each search round-trips Studio to Tesserae; a short trailing debounce turns
// a burst of keystrokes into one request without making the picker feel slow.
const SEARCH_DEBOUNCE_MS = 150;
let dynamicChoiceStates = new Map<string, DynamicChoiceState>();
let configKey = "";
let configGeneration = 0;
let dynamicChoiceDocumentHandlersBound = false;
let suppressDynamicSelectFocus = false;

function choicesWithCurrent(opt: WidgetOption, value: unknown): WidgetChoice[] {
  const choices = opt.choices || [];
  if (!opt.choices_from || value == null || (!Array.isArray(value) && String(value) === "")) {
    return choices;
  }
  const selected = (Array.isArray(value) ? value : [value]).map(String);
  const choicesByValue = new Map(choices.map((choice) => [choice.value, choice]));
  const selectedSet = new Set(selected);
  // Search results are transient, while selection is persistent. Pinning every
  // selected row keeps it available for removal even when a query or page changes.
  const pinned = selected.map(
    (item) =>
      choicesByValue.get(item) ||
      dynamicChoiceStates.get(opt.name)?.known.get(item) || { value: item, label: item },
  );
  return [...pinned, ...choices.filter((choice) => !selectedSet.has(choice.value))];
}

function dynamicChoiceHint(opt: WidgetOption, choiceState: DynamicChoiceState | undefined): string {
  const resultCount = opt.choices?.length || 0;
  if (choiceState?.status === "loading") return "Loading choices…";
  if (choiceState?.query && resultCount === 0) return "No matches.";
  if (choiceState?.query && choiceState.total > resultCount) {
    return `${choiceState.total} matches. Showing first ${resultCount}. Refine your search.`;
  }
  if (!choiceState?.query && choiceState && choiceState.total > resultCount) {
    return `Showing ${resultCount} of ${choiceState.total}. Scroll for more.`;
  }
  return "";
}

function dynamicMultiselectHtml(opt: WidgetOption, value: unknown): string {
  const name = escapeHtml(opt.name);
  const selected = new Set(value == null ? [] : (Array.isArray(value) ? value : [value]).map(String));
  const choiceState = dynamicChoiceStates.get(opt.name);
  const rows = choicesWithCurrent(opt, value)
    .map(
      (choice, index) =>
        `<label class="multiselect-opt multiselect-choice" for="cfg-${name}-${index}">` +
        `<input type="checkbox" id="cfg-${name}-${index}" name="cfg-${name}" ` +
        `data-name="${name}" data-type="multiselect" value="${escapeHtml(choice.value)}" ` +
        `${selected.has(choice.value) ? "checked" : ""} />` +
        '<span class="multiselect-tick" aria-hidden="true"><i class="ph ph-check"></i></span>' +
        `<span class="multiselect-label">${escapeHtml(choice.label || choice.value)}</span></label>`,
    )
    .join("");
  const hint = dynamicChoiceHint(opt, choiceState);
  return (
    '<div class="multiselect">' +
    '<div class="multiselect-search"><i class="ph ph-magnifying-glass" aria-hidden="true"></i>' +
    `<input type="search" data-choice-search="${name}" value="${escapeHtml(choiceState?.input || "")}" placeholder="Search choices…" ` +
    `autocomplete="off" spellcheck="false" aria-label="Search ${escapeHtml(opt.label || opt.name)}" />` +
    "</div>" +
    `<div class="multiselect-list" data-choice-list="${name}">${rows}</div>` +
    (hint ? `<div class="multiselect-hint">${escapeHtml(hint)}</div>` : "") +
    "</div>"
  );
}

function dynamicSelectHtml(opt: WidgetOption, value: unknown): string {
  const name = escapeHtml(opt.name);
  const choiceState = dynamicChoiceStates.get(opt.name);
  const selectedValue = value == null ? "" : String(value);
  const selectedChoice = choicesWithCurrent(opt, value).find(
    (choice) => choice.value === selectedValue,
  );
  const selectedLabel = selectedChoice?.label || selectedValue || "Select…";
  // One input alternates presentation without conflating state: the closed
  // value is the persisted label, while active editing shows only the query.
  const inputValue =
    choiceState?.mode === "search" ? choiceState.input : selectedValue ? selectedLabel : "";
  const open = choiceState?.mode === "browse" || choiceState?.mode === "search";
  const listId = `cfg-${name}-choices`;
  const rows = choicesWithCurrent(opt, value)
    .map((choice, index) => {
      const selected = choice.value === selectedValue;
      return (
        `<button type="button" id="${listId}-${index}" ` +
        `class="dynamic-select-option${selected ? " is-selected" : ""}" ` +
        `data-choice-option="${name}" data-choice-value="${escapeHtml(choice.value)}" ` +
        `role="option" aria-selected="${selected}">` +
        `<span>${escapeHtml(choice.label || choice.value)}</span>` +
        (selected ? '<i class="ph ph-check" aria-hidden="true"></i>' : "") +
        "</button>"
      );
    })
    .join("");
  const hint = dynamicChoiceHint(opt, choiceState);
  const clear = selectedValue
    ? `<button type="button" class="icon-btn dynamic-select-clear" data-choice-clear="${name}" aria-label="Clear ${escapeHtml(opt.label || opt.name)}" title="Clear selection"><i class="ph ph-x" aria-hidden="true"></i></button>`
    : "";
  return (
    `<div class="dynamic-select${open ? " is-open" : ""}" data-dynamic-select="${name}">` +
    '<div class="dynamic-select-control">' +
    '<div class="dynamic-select-input-wrap">' +
    `<input type="text" id="cfg-${name}" class="dynamic-select-input" data-choice-combobox="${name}" ` +
    `data-choice-search="${name}" value="${escapeHtml(inputValue)}" placeholder="Select…" autocomplete="off" spellcheck="false" ` +
    `role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="${open}" ` +
    `aria-controls="${listId}" aria-label="${escapeHtml(opt.label || opt.name)}" />` +
    '<i class="ph ph-caret-down dynamic-select-caret" aria-hidden="true"></i></div>' +
    clear +
    "</div>" +
    `<div class="dynamic-select-popover" data-choice-popover="${name}" ${open ? "" : "hidden"}>` +
    `<div class="dynamic-select-list" id="${listId}" data-choice-list="${name}" role="listbox">${rows}</div>` +
    (hint ? `<div class="dynamic-select-hint">${escapeHtml(hint)}</div>` : "") +
    "</div></div>"
  );
}

function dynamicChoicesHtml(opt: WidgetOption, value: unknown): string {
  return opt.type === "select"
    ? dynamicSelectHtml(opt, value)
    : dynamicMultiselectHtml(opt, value);
}

function controlHtml(opt: WidgetOption): string {
  const name = opt.name;
  const val = state.options[name];
  const label = escapeHtml(opt.label || name);
  const dn = escapeHtml(name);
  const id = `cfg-${dn}`;
  const dynamicState = dynamicChoiceStates.get(name);

  if (dynamicState?.status === "loading" && !dynamicState.hasLoaded) {
    return `<div class="field" data-choice-field="${dn}"><label>${label}</label><div class="cfg-empty">Loading choices…</div></div>`;
  }
  const choiceError = dynamicState?.status === "error" ? dynamicState.error : "";
  if (choiceError && !dynamicState?.hasLoaded && opt.type === "select") {
    return (
      `<div class="field" data-choice-field="${dn}"><label for="${id}">${label}</label>` +
      `<input type="text" id="${id}" data-name="${dn}" data-type="string" value="${escapeHtml(String(val ?? ""))}" />` +
      `<div class="cfg-empty">${escapeHtml(choiceError)}</div></div>`
    );
  }
  if (choiceError && opt.type === "multiselect") {
    const lines = Array.isArray(val) ? val.map(String).join("\n") : String(val ?? "");
    return (
      `<div class="field" data-choice-field="${dn}"><label for="${id}">${label}</label>` +
      `<textarea id="${id}" data-name="${dn}" data-type="multiselect-fallback" rows="4">${escapeHtml(lines)}</textarea>` +
      `<div class="cfg-empty">${escapeHtml(choiceError)}</div></div>`
    );
  }
  const hasCurrent = Array.isArray(val) ? val.length > 0 : val != null && String(val) !== "";
  const emptyDynamic = Boolean(
    opt.choices_from &&
      dynamicState?.status === "ready" &&
      !dynamicState.query &&
      dynamicState.total === 0,
  );
  if (emptyDynamic && !hasCurrent) {
    return `<div class="field"><label>${label}</label><div class="cfg-empty">No choices found.</div></div>`;
  }
  const choiceHint = choiceError
    ? `<div class="cfg-empty">${escapeHtml(choiceError)}</div>`
    : emptyDynamic
      ? '<div class="cfg-empty">No choices found; keeping the current value.</div>'
      : "";

  if (opt.choices_from && (opt.type === "select" || opt.type === "multiselect")) {
    const dynamicLabel =
      opt.type === "select" ? `<label for="${id}">${label}</label>` : `<label>${label}</label>`;
    return `<div class="field" data-choice-field="${dn}">${dynamicLabel}${dynamicChoicesHtml(opt, val)}${choiceHint}</div>`;
  }

  if (opt.type === "boolean") {
    return (
      `<label class="cfg-check"><span>${label}</span>` +
      `<input type="checkbox" data-name="${dn}" data-type="boolean" ${val ? "checked" : ""} /></label>`
    );
  }
  if (opt.type === "multiselect") {
    const boxes = choicesWithCurrent(opt, val)
      .map((c) => {
        const on = Array.isArray(val) && (val as unknown[]).map(String).includes(c.value);
        return (
          `<label class="cfg-multi"><input type="checkbox" data-name="${dn}" data-type="multiselect" ` +
          `value="${escapeHtml(c.value)}" ${on ? "checked" : ""}/> ${escapeHtml(c.label || c.value)}</label>`
        );
      })
      .join("");
    return `<div class="field"><label>${label}</label><div class="cfg-multiset">${boxes}</div>${choiceHint}</div>`;
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
      const rows = choicesWithCurrent(opt, val)
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
  return `<div class="field"><label for="${id}">${label}</label>${control}${choiceHint}</div>`;
}

function settingsHtml(): string {
  if (!settingsSchema.length) return "";
  const rows = settingsSchema
    .map((s) => {
      const dn = escapeHtml(s.name);
      const label = escapeHtml(s.label || s.name);
      const type = s.secret ? "password" : s.type === "number" ? "number" : "text";
      const val = settingsValues[s.name];
      // A stored secret comes back redacted; show a placeholder and keep it if
      // left blank rather than overwriting with an empty value.
      const ph = s.secret ? ' placeholder="•••• stored (leave blank to keep)"' : "";
      const value = s.secret ? "" : escapeHtml(val == null ? "" : String(val));
      return `<div class="field"><label for="set-${dn}">${label}</label><input type="${type}" id="set-${dn}" data-sname="${dn}"${ph} value="${value}" /></div>`;
    })
    .join("");
  return (
    `<div class="cfg-head cfg-settings-head"><span>Settings → Tesserae</span>` +
    `<button type="button" class="btn" id="set-apply">Apply</button></div>${rows}` +
    `<div class="cfg-empty">Pushed to the connected Tesserae so fetch() runs with real credentials.</div>`
  );
}

function renderForm() {
  const panel = $<HTMLDivElement>("config-panel");
  const optionsHtml = schema.length
    ? `<div class="cfg-head"><span>Options</span><button type="button" class="btn ghost" id="cfg-reset">Reset</button></div>` +
      schema.map(controlHtml).join("")
    : `<div class="cfg-empty">This widget declares no cell_options.</div>`;
  panel.innerHTML = optionsHtml + settingsHtml();

  panel.querySelector("#cfg-reset")?.addEventListener("click", () => {
    state.options = optionDefaults(schema);
    renderForm();
    void render();
  });
  panel.querySelector("#set-apply")?.addEventListener("click", () => void applySettings());
}

async function applySettings() {
  const key = state.widget?.key;
  if (!key) return;
  const payload: Record<string, unknown> = {};
  for (const s of settingsSchema) {
    const v = settingsValues[s.name];
    if (s.secret && (v === "" || v == null)) continue; // blank secret keeps the stored one
    payload[s.name] = v ?? "";
  }
  markLocalMutation();
  const btn = $<HTMLButtonElement>("set-apply");
  btn.disabled = true;
  try {
    await setWidgetSettings(key, payload);
    state.version = Date.now(); // re-fetch live data with the new settings
    await render();
    setNote(`Applied settings to Tesserae for ${key}.`, "");
  } catch (err) {
    setNote(
      `Settings push failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Tesserae may not expose the settings endpoint yet.`,
      "err",
    );
  } finally {
    btn.disabled = false;
  }
}

function onFormChange(e: Event) {
  const el = e.target as HTMLInputElement & HTMLSelectElement;
  // Settings fields update their value only; they're pushed on Apply, not live.
  if (el.dataset.sname) {
    settingsValues[el.dataset.sname] = el.value;
    return;
  }
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
  } else if (type === "multiselect-fallback") {
    state.options[name] = el.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } else {
    state.options[name] = el.value;
  }
  void render();
}

function renderDynamicChoiceField(name: string, preserveScroll: boolean) {
  // Replacing only this field preserves edits in the rest of the form while
  // remote results arrive, and the explicit restoration keeps typing continuous.
  const field = schema.find((item) => item.name === name);
  const current = $<HTMLDivElement>("config-panel").querySelector<HTMLElement>(
    `[data-choice-field="${CSS.escape(name)}"]`,
  );
  if (!field || !current) return;
  const oldSearch = current.querySelector<HTMLInputElement>("[data-choice-search]");
  const oldList = current.querySelector<HTMLElement>("[data-choice-list]");
  const mode = dynamicChoiceStates.get(name)?.mode;
  const searchStaysVisible =
    field.type === "multiselect" || mode === "browse" || mode === "search";
  const restoreFocus = searchStaysVisible && document.activeElement === oldSearch;
  const selectionStart = oldSearch?.selectionStart ?? null;
  const selectionEnd = oldSearch?.selectionEnd ?? null;
  const selectionDirection = oldSearch?.selectionDirection || undefined;
  const scrollTop = preserveScroll ? oldList?.scrollTop || 0 : 0;
  const template = document.createElement("template");
  template.innerHTML = controlHtml(field);
  const replacement = template.content.firstElementChild as HTMLElement | null;
  if (!replacement) return;
  current.replaceWith(replacement);
  const newList = replacement.querySelector<HTMLElement>("[data-choice-list]");
  if (newList) newList.scrollTop = scrollTop;
  if (restoreFocus) {
    const newSearch = replacement.querySelector<HTMLInputElement>("[data-choice-search]");
    newSearch?.focus();
    if (newSearch && selectionStart != null && selectionEnd != null) {
      newSearch.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }
  }
}

async function requestDynamicChoices(
  key: string,
  field: WidgetOption,
  input: string,
  offset: number,
  generation: number,
) {
  const choiceState = dynamicChoiceStates.get(field.name);
  if (!choiceState) return;
  cancelPendingSearch(choiceState);
  const requestId = ++choiceState.requestId;
  // Keep the user's exact text for continuous editing, but use one normalized
  // query for remote matching and for deciding whether pagination is allowed.
  const query = input.trim();
  // Form generation protects cross-widget ownership; requestId independently
  // protects rapid searches and a search overtaking an in-flight scroll page.
  const ownsRequest = () =>
    generation === configGeneration &&
    dynamicChoiceStates.get(field.name) === choiceState &&
    choiceState.requestId === requestId;
  choiceState.input = input;
  choiceState.query = query;
  choiceState.status = "loading";
  choiceState.error = "";
  try {
    const result = await getWidgetChoices(key, field.name, query, offset);
    if (!ownsRequest()) return;
    for (const choice of result.choices) choiceState.known.set(choice.value, choice);
    const rows = offset > 0 && !query ? [...(field.choices || []), ...result.choices] : result.choices;
    field.choices = rows;
    choiceState.total = result.total;
    choiceState.hasLoaded = true;
    choiceState.status = "ready";
    renderDynamicChoiceField(field.name, offset > 0 && !query);
  } catch (err) {
    if (!ownsRequest()) return;
    // Preserve whether a usable page ever loaded so an initial select failure
    // can offer manual fallback without replacing a working combobox on refresh.
    choiceState.status = "error";
    choiceState.error = err instanceof Error ? err.message : String(err);
    renderDynamicChoiceField(field.name, true);
  }
}

function cancelPendingSearch(choiceState: DynamicChoiceState) {
  if (choiceState.searchTimer != null) clearTimeout(choiceState.searchTimer);
  choiceState.searchTimer = null;
  choiceState.pendingQuery = null;
}

function onChoiceSearch(e: Event) {
  const input = e.target as HTMLInputElement;
  const name = input.dataset.choiceSearch;
  if (!name) return;
  const field = schema.find((item) => item.name === name);
  if (!field) return;
  const choiceState = dynamicChoiceStates.get(name);
  if (input.dataset.choiceCombobox && choiceState) {
    openDynamicSelect(name, input, "search");
  }
  const query = input.value.trim();
  if (!choiceState) {
    void requestDynamicChoices(configKey, field, input.value, 0, configGeneration);
    return;
  }
  choiceState.input = input.value;
  // Compare against whichever query runs next, in flight or still waiting on
  // the debounce, so retyping the same text or a trailing space does not
  // queue a duplicate request.
  if ((choiceState.pendingQuery ?? choiceState.query) === query) return;
  cancelPendingSearch(choiceState);
  choiceState.pendingQuery = query;
  const generation = configGeneration;
  choiceState.searchTimer = setTimeout(() => {
    choiceState.searchTimer = null;
    choiceState.pendingQuery = null;
    if (generation !== configGeneration || dynamicChoiceStates.get(name) !== choiceState) return;
    void requestDynamicChoices(configKey, field, choiceState.input, 0, generation);
  }, SEARCH_DEBOUNCE_MS);
}

function closeDynamicSelects(exceptName = ""): string[] {
  const closed: string[] = [];
  for (const [name, choiceState] of dynamicChoiceStates) {
    if (name === exceptName || choiceState.mode === "closed") continue;
    choiceState.mode = "closed";
    renderDynamicChoiceField(name, true);
    closed.push(name);
  }
  return closed;
}

function openDynamicSelect(
  name: string,
  input: HTMLInputElement,
  mode: "browse" | "search",
) {
  const choiceState = dynamicChoiceStates.get(name);
  if (!choiceState) return;
  if (choiceState.mode === "closed") {
    const resetResults = mode === "browse" && Boolean(choiceState.input || choiceState.query);
    closeDynamicSelects(name);
    choiceState.mode = mode;
    input.closest("[data-dynamic-select]")?.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    const popover = input
      .closest("[data-dynamic-select]")
      ?.querySelector<HTMLElement>("[data-choice-popover]");
    if (popover) popover.hidden = false;
    if (resetResults) {
      const field = schema.find((item) => item.name === name);
      if (field) void requestDynamicChoices(configKey, field, "", 0, configGeneration);
    }
  } else if (mode === "search") {
    choiceState.mode = "search";
  }
  if (choiceState.mode === "browse") input.select();
}

function onChoiceComboboxFocus(e: FocusEvent) {
  const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-choice-combobox]");
  const name = input?.dataset.choiceCombobox;
  if (!name || !input || suppressDynamicSelectFocus) return;
  openDynamicSelect(name, input, "browse");
}

function dynamicSelectOptions(name: string): { options: HTMLButtonElement[]; active: number } {
  const options = Array.from(
    $<HTMLDivElement>("config-panel").querySelectorAll<HTMLButtonElement>(
      `[data-choice-list="${CSS.escape(name)}"] [data-choice-option]`,
    ),
  );
  return { options, active: options.findIndex((option) => option.classList.contains("is-active")) };
}

function moveActiveOption(name: string, input: HTMLInputElement, step: number) {
  const { options, active } = dynamicSelectOptions(name);
  if (!options.length) return;
  // The first arrow press lands on the current selection so the list reads
  // from where the value is; later presses walk from there and wrap.
  const selected = options.findIndex((option) => option.classList.contains("is-selected"));
  let next: number;
  if (active >= 0) next = (active + step + options.length) % options.length;
  else if (selected >= 0) next = selected;
  else next = step > 0 ? 0 : options.length - 1;
  options.forEach((option, index) => option.classList.toggle("is-active", index === next));
  input.setAttribute("aria-activedescendant", options[next].id);
  if (typeof options[next].scrollIntoView === "function") {
    options[next].scrollIntoView({ block: "nearest" });
  }
}

function onChoiceComboboxKeydown(e: KeyboardEvent) {
  const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-choice-combobox]");
  const name = input?.dataset.choiceCombobox;
  if (!name || !input) return;
  const choiceState = dynamicChoiceStates.get(name);
  if (!choiceState) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (choiceState.mode === "closed") openDynamicSelect(name, input, "browse");
    moveActiveOption(name, input, e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && choiceState.mode !== "closed") {
    const { options, active } = dynamicSelectOptions(name);
    if (active < 0) return;
    e.preventDefault();
    options[active].click();
  }
}

function focusClosedDynamicSelect(name: string) {
  const input = $<HTMLDivElement>("config-panel").querySelector<HTMLInputElement>(
    `[data-choice-combobox="${CSS.escape(name)}"]`,
  );
  if (!input) return;
  // Selection and clearing replace the input node. Suppress the focus handler
  // once so restoring keyboard focus does not immediately reopen the popup.
  suppressDynamicSelectFocus = true;
  input.focus();
  input.select();
  suppressDynamicSelectFocus = false;
}

function onChoiceSelectClick(e: Event) {
  const target = e.target as HTMLElement;
  const option = target.closest<HTMLButtonElement>("[data-choice-option]");
  const optionName = option?.dataset.choiceOption;
  const optionValue = option?.dataset.choiceValue;
  if (optionName && optionValue != null) {
    state.options[optionName] = optionValue;
    const choiceState = dynamicChoiceStates.get(optionName);
    if (choiceState) {
      choiceState.mode = "closed";
    }
    renderDynamicChoiceField(optionName, false);
    focusClosedDynamicSelect(optionName);
    void render();
    return;
  }
  const input = target.closest<HTMLInputElement>("[data-choice-combobox]");
  const name = input?.dataset.choiceCombobox;
  if (name && input) openDynamicSelect(name, input, "browse");
}

function onChoiceDocumentClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("[data-dynamic-select]")) return;
  closeDynamicSelects();
}

function onChoiceDocumentKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const [name] = closeDynamicSelects();
  if (name) focusClosedDynamicSelect(name);
}

function onChoiceClear(e: Event) {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-choice-clear]");
  const name = button?.dataset.choiceClear;
  if (!name) return;
  state.options[name] = "";
  const choiceState = dynamicChoiceStates.get(name);
  if (choiceState) {
    choiceState.mode = "closed";
  }
  renderDynamicChoiceField(name, true);
  focusClosedDynamicSelect(name);
  void render();
}

function onChoiceScroll(e: Event) {
  const list = e.target as HTMLElement;
  const name = list.dataset.choiceList;
  if (!name || Math.ceil(list.scrollTop + list.clientHeight) < list.scrollHeight) return;
  const field = schema.find((item) => item.name === name);
  const choiceState = dynamicChoiceStates.get(name);
  const loaded = field?.choices?.length || 0;
  // Empty-query browsing may walk the whole catalog lazily. Search stays on
  // one bounded page and asks the user to refine broad matches instead.
  if (
    !field ||
    !choiceState ||
    choiceState.query ||
    choiceState.status !== "ready" ||
    loaded >= choiceState.total
  ) {
    return;
  }
  void requestDynamicChoices(configKey, field, choiceState.input, loaded, configGeneration);
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

// Load a widget's config schema + admin availability. Called on widget select,
// and again after a plugin.json save (with preserveOptions, so editing the
// manifest refreshes the cell_option form without discarding values already set).
export async function loadWidgetConfig(key: string, opts: { preserveOptions?: boolean } = {}) {
  const generation = ++configGeneration;
  configKey = key;
  const prev = opts.preserveOptions ? { ...state.options } : null;
  schema = [];
  adminUrl = "";
  hideAdmin();
  const adminBtn = $<HTMLButtonElement>("admin-btn");
  adminBtn.hidden = true;
  settingsSchema = [];
  settingsValues = {};
  for (const choiceState of dynamicChoiceStates.values()) cancelPendingSearch(choiceState);
  dynamicChoiceStates = new Map();
  // On a manifest save (preserveOptions) the same widget's form is already on
  // screen; leaving it in place until the new schema arrives avoids a flash.
  if (!opts.preserveOptions) {
    $<HTMLDivElement>("config-panel").innerHTML =
      '<div class="cfg-empty">Loading configuration…</div>';
  }
  try {
    const [optsRes, admin, settings] = await Promise.all([
      getWidgetOptions(key),
      getWidgetAdmin(key),
      getWidgetSettings(key),
    ]);
    if (generation !== configGeneration) return;
    schema = optsRes.options || [];
    const defaults = optionDefaults(schema);
    // Keep any value the user already set for an option that still exists.
    if (prev) for (const f of schema) if (f.name in prev) defaults[f.name] = prev[f.name];
    state.options = defaults;
    adminUrl = admin.url;
    adminBtn.hidden = !admin.has_admin;
    settingsSchema = settings.settings || [];
    settingsValues = { ...settings.current };
    const dynamic = schema.filter(
      (field) => field.choices_from && (field.type === "select" || field.type === "multiselect"),
    );
    for (const field of dynamic) {
      // Search results and the persisted selection are independent. The
      // manifest's static fallback must not leak into a dynamic result page.
      field.choices = [];
      dynamicChoiceStates.set(field.name, {
        input: "",
        query: "",
        total: 0,
        hasLoaded: false,
        mode: "closed",
        status: "loading",
        error: "",
        requestId: 0,
        known: new Map(),
        pendingQuery: null,
        searchTimer: null,
      });
    }
    if (dynamic.length) {
      renderForm();
      await Promise.all(
        dynamic.map((field) => requestDynamicChoices(key, field, "", 0, generation)),
      );
      if (generation !== configGeneration) return;
      // Every dynamic field committed its own result. A full render here would
      // discard focus and scroll in a sibling that became usable earlier.
      return;
    }
  } catch {
    if (generation !== configGeneration) return;
    state.options = {};
  }
  if (generation !== configGeneration) return;
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
  panel.addEventListener("input", onChoiceSearch);
  panel.addEventListener("input", onFormChange);
  panel.addEventListener("focusin", onChoiceComboboxFocus);
  panel.addEventListener("keydown", onChoiceComboboxKeydown);
  panel.addEventListener("click", onChoiceSelectClick);
  panel.addEventListener("click", onChoiceClear);
  panel.addEventListener("scroll", onChoiceScroll, true);
  if (!dynamicChoiceDocumentHandlersBound) {
    // Choice fields are replaced as remote pages arrive. Delegated document
    // handlers keep dismissal independent of those short-lived DOM nodes.
    document.addEventListener("click", onChoiceDocumentClick);
    document.addEventListener("keydown", onChoiceDocumentKeydown);
    dynamicChoiceDocumentHandlersBound = true;
  }
}
