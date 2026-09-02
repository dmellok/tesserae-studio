import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWidgetAdmin,
  getWidgetChoices,
  getWidgetOptions,
  getWidgetSettings,
} from "./api";
import { initConfig, loadWidgetConfig } from "./configForm";
import { render } from "./preview";
import { state } from "./state";

vi.mock("./api", () => ({
  getWidgetAdmin: vi.fn(),
  getWidgetChoices: vi.fn(),
  getWidgetOptions: vi.fn(),
  getWidgetSettings: vi.fn(),
  setWidgetSettings: vi.fn(),
}));
vi.mock("./events", () => ({ markLocalMutation: vi.fn() }));
vi.mock("./preview", () => ({ render: vi.fn() }));

const optionsMock = vi.mocked(getWidgetOptions);
const choicesMock = vi.mocked(getWidgetChoices);
const adminMock = vi.mocked(getWidgetAdmin);
const settingsMock = vi.mocked(getWidgetSettings);
const renderMock = vi.mocked(render);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  document.body.innerHTML = `
    <button id="config-btn"></button>
    <button id="admin-btn"></button>
    <div id="config-panel"></div>
    <iframe id="admin-frame"></iframe>
    <div id="frame"></div>
  `;
  state.options = {};
  adminMock.mockResolvedValue({ key: "history", has_admin: false, url: "/plugins/history/" });
  settingsMock.mockResolvedValue({ key: "history", settings: [], current: {} });
  initConfig();
});

describe("dynamic choices", () => {
  it("removes the previous form while the next widget schema is loading", () => {
    document.getElementById("config-panel")!.innerHTML =
      '<input data-name="old-option" value="stale" />';
    optionsMock.mockReturnValue(new Promise(() => {}));

    void loadWidgetConfig("next");

    const panel = document.getElementById("config-panel")!;
    expect(panel.textContent).toContain("Loading configuration");
    expect(panel.querySelector("[data-name]")).toBeNull();
  });

  it("keeps the current form in place while a manifest save reloads the schema", () => {
    document.getElementById("config-panel")!.innerHTML =
      '<input data-name="entity" value="sensor.room" />';
    optionsMock.mockReturnValue(new Promise(() => {}));

    void loadWidgetConfig("history", { preserveOptions: true });

    const panel = document.getElementById("config-panel")!;
    expect(panel.textContent).not.toContain("Loading configuration");
    expect(panel.querySelector('[data-name="entity"]')).not.toBeNull();
  });

  it("keeps edits made while a preserved schema reload is pending", async () => {
    state.options = { label: "before" };
    document.getElementById("config-panel")!.innerHTML =
      '<input data-name="label" data-type="string" value="before" />';
    let finishOptions!: (value: Awaited<ReturnType<typeof getWidgetOptions>>) => void;
    optionsMock.mockReturnValue(
      new Promise((resolve) => {
        finishOptions = resolve;
      }),
    );

    const loading = loadWidgetConfig("history", { preserveOptions: true });
    const input = document.querySelector<HTMLInputElement>('[data-name="label"]')!;
    input.value = "during";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    finishOptions({
      key: "history",
      options: [{ name: "label", type: "string", default: "default" }],
    });
    await loading;

    expect(state.options.label).toBe("during");
    expect(document.querySelector<HTMLInputElement>('[data-name="label"]')?.value).toBe(
      "during",
    );
  });

  it("keeps the current form and values when a preserved schema reload fails", async () => {
    state.options = { entity: "sensor.room" };
    document.getElementById("config-panel")!.innerHTML =
      '<input data-name="entity" data-type="string" value="sensor.room" />';
    optionsMock.mockRejectedValue(new Error("metadata unavailable"));

    await loadWidgetConfig("history", { preserveOptions: true });

    expect(state.options).toEqual({ entity: "sensor.room" });
    expect(document.querySelector<HTMLInputElement>('[data-name="entity"]')?.value).toBe(
      "sensor.room",
    );
  });

  it("keeps static choices synchronous", async () => {
    optionsMock.mockResolvedValue({
      key: "clock",
      options: [
        {
          name: "mode",
          label: "Mode",
          type: "select",
          default: "compact",
          choices: [
            { value: "compact", label: "Compact" },
            { value: "full", label: "Full" },
          ],
        },
      ],
    });

    await loadWidgetConfig("clock");

    expect(choicesMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLSelectElement>('[data-name="mode"]')?.value).toBe(
      "compact",
    );
  });

  it("does not fetch choices for a non-picker option type", async () => {
    optionsMock.mockResolvedValue({
      key: "clock",
      options: [{ name: "label", type: "string", choices_from: "unsupported" }],
    });

    await loadWidgetConfig("clock");

    expect(choicesMock).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('input[data-name="label"]')).not.toBeNull();
  });

  it("renders a searchable dynamic select from the first page", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    let finishChoices!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    choicesMock.mockReturnValue(
      new Promise((resolve) => {
        finishChoices = resolve;
      }),
    );

    const loading = loadWidgetConfig("history");
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById("config-panel")?.textContent).toContain("Loading choices");

    finishChoices({
      key: "history",
      option: "entity",
      total: 2,
      offset: 0,
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    });
    await loading;

    expect(choicesMock).toHaveBeenCalledWith("history", "entity", "", 0);
    expect(
      document.querySelector<HTMLInputElement>(
        '#config-panel input[data-choice-combobox="entity"]',
      ),
    ).not.toBeNull();
    const choices = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#config-panel [data-choice-list="entity"] [data-choice-option="entity"]',
      ),
    );
    expect(choices.map((choice) => choice.dataset.choiceValue)).toEqual([
      "sensor.room",
      "sensor.outside",
    ]);
    expect(
      choices.find((choice) => choice.getAttribute("aria-selected") === "true")?.dataset
        .choiceValue,
    ).toBe("sensor.room");
  });

  it("renders a dynamic select as one closed editable combobox", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 2,
      offset: 0,
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    });

    await loadWidgetConfig("history");

    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    );
    const popover = document.querySelector<HTMLElement>('[data-choice-popover="entity"]');
    expect(combobox).not.toBeNull();
    expect(popover).not.toBeNull();
    expect(combobox!.value).toBe("Room");
    expect(combobox!.getAttribute("role")).toBe("combobox");
    expect(combobox!.getAttribute("aria-expanded")).toBe("false");
    expect(popover!.hidden).toBe(true);
    expect(popover!.querySelector("input")).toBeNull();
    expect(
      document.querySelector('[data-choice-field="entity"] input[type="radio"]'),
    ).toBeNull();
  });

  it("opens a dynamic select dropdown and focuses its search", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 1,
      offset: 0,
      choices: [{ value: "sensor.room", label: "Room" }],
    });

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();

    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    )!;
    const popover = document.querySelector<HTMLElement>('[data-choice-popover="entity"]')!;
    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    expect(popover.hidden).toBe(false);
    expect(document.activeElement).toBe(combobox);
    expect(combobox.selectionStart).toBe(0);
    expect(combobox.selectionEnd).toBe("Room".length);
  });

  it("walks dynamic select options with the arrow keys and commits with Enter", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 2,
      offset: 0,
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    });

    await loadWidgetConfig("history");
    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    )!;
    combobox.focus();
    combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const active = document.querySelector<HTMLButtonElement>(
      '[data-choice-option="entity"].is-active',
    )!;
    expect(active.dataset.choiceValue).toBe("sensor.outside");
    expect(combobox.getAttribute("aria-activedescendant")).toBe(active.id);

    combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(state.options.entity).toBe("sensor.outside");
    expect(
      document.querySelector<HTMLElement>('[data-choice-popover="entity"]')!.hidden,
    ).toBe(true);
  });

  it("commits one dynamic select option and closes the dropdown", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 2,
      offset: 0,
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    });

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    document
      .querySelector<HTMLButtonElement>(
        '[data-choice-option="entity"][data-choice-value="sensor.outside"]',
      )!
      .click();

    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    )!;
    expect(state.options.entity).toBe("sensor.outside");
    expect(combobox.value).toBe("Outside");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector<HTMLElement>('[data-choice-popover="entity"]')!.hidden).toBe(
      true,
    );
    expect(document.activeElement).toBe(combobox);
    expect(renderMock).toHaveBeenCalledOnce();
  });

  it("dismisses an open dynamic select from outside or with Escape", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 1,
      offset: 0,
      choices: [{ value: "sensor.room", label: "Room" }],
    });

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    document.body.click();

    expect(
      document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
    expect(document.activeElement).not.toBe(
      document.querySelector<HTMLInputElement>('[data-choice-search="entity"]'),
    );

    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    )!;
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(combobox);
    expect(combobox.value).toBe("Room");
    expect(combobox.selectionStart).toBe(0);
    expect(combobox.selectionEnd).toBe("Room".length);
  });

  it("searches a dynamic select while retaining its current value", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockImplementation(async (_key, _option, q) =>
      q
        ? {
            key: "history",
            option: "entity",
            total: 245,
            offset: 0,
            choices: [{ value: "sensor.kitchen", label: "Kitchen" }],
          }
        : {
            key: "history",
            option: "entity",
            total: 2,
            offset: 0,
            choices: [
              { value: "sensor.room", label: "Room" },
              { value: "sensor.outside", label: "Outside" },
            ],
          },
    );

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    const search = document.querySelector<HTMLInputElement>(
      'input[data-choice-combobox="entity"]',
    )!;
    search.value = "kitchen & hall";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    // A burst of keystrokes collapses into the one request the debounce releases.
    expect(choicesMock).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith(
        "history",
        "entity",
        "kitchen & hall",
        0,
      ),
    );
    await vi.waitFor(() => {
      const values = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-choice-list="entity"] [data-choice-option="entity"]',
        ),
      ).map((choice) => choice.dataset.choiceValue);
      expect(values).toEqual(["sensor.room", "sensor.kitchen"]);
    });
    expect(state.options.entity).toBe("sensor.room");
    expect(document.getElementById("config-panel")?.textContent).toContain("245 matches");
    expect(document.getElementById("config-panel")?.textContent).toContain(
      "Refine your search",
    );

    const callCount = choicesMock.mock.calls.length;
    const list = document.querySelector<HTMLElement>('[data-choice-list="entity"]')!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    list.scrollTop = 200;
    list.dispatchEvent(new Event("scroll"));
    expect(choicesMock).toHaveBeenCalledTimes(callCount);
  });

  it("restores and selects the current label when reopening after a search", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockImplementation(async (_key, _option, q) => ({
      key: "history",
      option: "entity",
      total: q ? 1 : 2,
      offset: 0,
      choices: q
        ? [{ value: "sensor.kitchen", label: "Kitchen" }]
        : [
            { value: "sensor.room", label: "Room" },
            { value: "sensor.outside", label: "Outside" },
          ],
    }));

    await loadWidgetConfig("history");
    let combobox = document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!;
    combobox.focus();
    combobox.value = "kit";
    combobox.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith("history", "entity", "kit", 0),
    );

    document.body.click();
    combobox = document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!;
    expect(combobox.value).toBe("Room");
    const callsBeforeReopen = choicesMock.mock.calls.length;

    combobox.focus();
    await vi.waitFor(() => expect(choicesMock).toHaveBeenCalledTimes(callsBeforeReopen + 1));
    expect(choicesMock).toHaveBeenLastCalledWith("history", "entity", "", 0);
    await vi.waitFor(() => {
      combobox = document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!;
      expect(document.activeElement).toBe(combobox);
      expect(combobox.value).toBe("Room");
      expect(combobox.selectionStart).toBe(0);
      expect(combobox.selectionEnd).toBe("Room".length);
    });
  });

  it("preserves spaces and focus while editing after a search with no matches", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [{ name: "entity", type: "select", choices_from: "entity" }],
    });
    choicesMock.mockImplementation(async (_key, _option, q) => ({
      key: "history",
      option: "entity",
      total: !q || q === "kitchen hall" ? 1 : 0,
      offset: 0,
      choices: !q
        ? [{ value: "sensor.initial", label: "Initial" }]
        : q === "kitchen hall"
          ? [{ value: "sensor.kitchen", label: "Kitchen" }]
          : [],
    }));

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    let search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    search.focus();
    search.value = "kitchen";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.getElementById("config-panel")?.textContent).toContain("No matches"),
    );

    search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    expect(document.activeElement).toBe(search);
    const callsBeforeSpace = choicesMock.mock.calls.length;
    search.value = "kitchen ";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')?.value,
    ).toBe("kitchen ");
    expect(choicesMock).toHaveBeenCalledTimes(callsBeforeSpace);

    search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    search.value += "hall";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith(
        "history",
        "entity",
        "kitchen hall",
        0,
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-choice-value="sensor.kitchen"]')).not.toBeNull(),
    );
    search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    expect(search.value).toBe("kitchen hall");
    expect(document.activeElement).toBe(search);
  });

  it("loads the next unfiltered page when the picker reaches the end", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [{ name: "entity", type: "select", choices_from: "entity" }],
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      value: `sensor.${index}`,
      label: `Sensor ${index}`,
    }));
    choicesMock.mockImplementation(async (_key, _option, q, offset) => {
      expect(q).toBe("");
      return offset === 0
        ? {
            key: "history",
            option: "entity",
            total: 101,
            offset: 0,
            choices: firstPage,
          }
        : {
            key: "history",
            option: "entity",
            total: 101,
            offset: 100,
            choices: [{ value: "sensor.100", label: "Sensor 100" }],
          };
    });

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    const list = document.querySelector<HTMLElement>('[data-choice-list="entity"]')!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    list.scrollTop = 200;
    list.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith("history", "entity", "", 100),
    );
    await vi.waitFor(() => {
      const values = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-choice-list="entity"] [data-choice-option="entity"]',
        ),
      ).map((choice) => choice.dataset.choiceValue);
      expect(values).toHaveLength(101);
      expect(values.at(-1)).toBe("sensor.100");
    });
  });

  it("keeps multiselect values available while searching", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entities",
          type: "multiselect",
          choices_from: "entity",
          default: [],
        },
      ],
    });
    choicesMock.mockImplementation(async (_key, _option, q) => ({
      key: "history",
      option: "entities",
      total: 2,
      offset: 0,
      choices: q
        ? [
            { value: "sensor.outside", label: "Outside" },
            { value: "sensor.room", label: "Room" },
          ]
        : [
            { value: "sensor.room", label: "Room" },
            { value: "sensor.outside", label: "Outside" },
          ],
    }));

    await loadWidgetConfig("history");
    const room = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-name="entities"][value="sensor.room"]',
    )!;
    room.checked = true;
    room.dispatchEvent(new Event("input", { bubbles: true }));

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"][data-choice-search="entities"]',
    )!;
    search.value = "sensor";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith("history", "entities", "sensor", 0),
    );
    await vi.waitFor(() => {
      const values = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          '[data-choice-list="entities"] input[data-name="entities"]',
        ),
      );
      expect(values.map((choice) => choice.value)).toEqual([
        "sensor.room",
        "sensor.outside",
      ]);
      expect(values[0].checked).toBe(true);
      expect(values[0].closest("label")?.textContent).toContain("Room");
    });
    expect(state.options.entities).toEqual(["sensor.room"]);

    const selected = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-name="entities"][value="sensor.room"]',
    )!;
    selected.checked = false;
    selected.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.options.entities).toEqual([]);
  });

  it("ignores an older search response for the same field", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [{ name: "entity", type: "select", choices_from: "entity" }],
    });
    let finishOld!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    let finishNew!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    choicesMock.mockImplementation((_key, _option, q) => {
      if (!q) {
        return Promise.resolve({
          key: "history",
          option: "entity",
          total: 1,
          offset: 0,
          choices: [{ value: "sensor.initial", label: "Initial" }],
        });
      }
      return new Promise((resolve) => {
        if (q === "old") finishOld = resolve;
        else finishNew = resolve;
      });
    });

    await loadWidgetConfig("history");
    document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')!.focus();
    let search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    search.value = "old";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith("history", "entity", "old", 0),
    );
    search = document.querySelector<HTMLInputElement>('[data-choice-search="entity"]')!;
    search.value = "new";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(choicesMock).toHaveBeenLastCalledWith("history", "entity", "new", 0),
    );

    finishNew({
      key: "history",
      option: "entity",
      total: 1,
      offset: 0,
      choices: [{ value: "sensor.new", label: "New" }],
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>('[data-choice-value="sensor.new"]'),
      ).not.toBeNull(),
    );
    finishOld({
      key: "history",
      option: "entity",
      total: 1,
      offset: 0,
      choices: [{ value: "sensor.old", label: "Old" }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[data-choice-value="sensor.old"]')).toBeNull();
    expect(document.querySelector('[data-choice-value="sensor.new"]')).not.toBeNull();
  });

  it("uses the existing scalar and array preview update path", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        { name: "entity", type: "select", choices_from: "entity" },
        { name: "entities", type: "multiselect", choices_from: "entity", default: [] },
      ],
    });
    choicesMock.mockImplementation(async (_key, option) => ({
      key: "history",
      option,
      total: 2,
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    }));

    await loadWidgetConfig("history");
    renderMock.mockClear();

    document
      .querySelector<HTMLButtonElement>(
        '[data-choice-option="entity"][data-choice-value="sensor.outside"]',
      )!
      .click();

    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"][data-name="entities"][value="sensor.room"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.options.entity).toBe("sensor.outside");
    expect(state.options.entities).toEqual(["sensor.room"]);
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the current select value when choices fail", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.saved",
        },
      ],
    });
    choicesMock.mockRejectedValue(new Error("widget is not registered"));

    await loadWidgetConfig("history");

    const fallback = document.querySelector<HTMLInputElement>(
      '#config-panel input[type="text"][data-name="entity"]',
    );
    expect(fallback?.value).toBe("sensor.saved");
    expect(document.getElementById("config-panel")?.textContent).toContain(
      "widget is not registered",
    );
  });

  it("keeps the combobox and selected scalar when a later search fails", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.room",
        },
      ],
    });
    choicesMock.mockImplementation(async (_key, _option, query) => {
      if (query === "broken") throw new Error("search failed");
      return {
        key: "history",
        option: "entity",
        total: 1,
        choices: [{ value: "sensor.room", label: "Room" }],
      };
    });

    await loadWidgetConfig("history");

    const initial = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    )!;
    initial.focus();
    initial.value = "broken";
    initial.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.getElementById("config-panel")?.textContent).toContain("search failed"),
    );

    const combobox = document.querySelector<HTMLInputElement>(
      '[data-choice-combobox="entity"]',
    );
    expect(combobox?.value).toBe("broken");
    expect(document.activeElement).toBe(combobox);
    expect(
      document.querySelector<HTMLInputElement>('input[data-name="entity"]'),
    ).toBeNull();
    expect(state.options.entity).toBe("sensor.room");
  });

  it("keeps another dynamic field usable when its sibling fails", async () => {
    optionsMock.mockResolvedValue({
      key: "compare",
      options: [
        { name: "primary", type: "select", choices_from: "entity" },
        { name: "secondary", type: "select", choices_from: "entity" },
      ],
    });
    choicesMock.mockImplementation(async (_key, option) => {
      if (option === "secondary") throw new Error("secondary failed");
      return {
        key: "compare",
        option,
        total: 1,
        choices: [{ value: "sensor.primary", label: "Primary" }],
      };
    });

    await loadWidgetConfig("compare");

    expect(document.querySelector('[data-choice-value="sensor.primary"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('input[type="text"][data-name="secondary"]'),
    ).not.toBeNull();
    expect(document.getElementById("config-panel")?.textContent).toContain("secondary failed");
  });

  it("keeps an open dynamic field focused while a sibling finishes loading", async () => {
    optionsMock.mockResolvedValue({
      key: "compare",
      options: [
        { name: "primary", type: "select", choices_from: "entity" },
        { name: "secondary", type: "select", choices_from: "entity" },
      ],
    });
    let finishPrimary!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    let finishSecondary!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    choicesMock.mockImplementation(
      (_key, option) =>
        new Promise((resolve) => {
          if (option === "primary") finishPrimary = resolve;
          else finishSecondary = resolve;
        }),
    );

    const loading = loadWidgetConfig("compare");
    await vi.waitFor(() => expect(choicesMock).toHaveBeenCalledTimes(2));
    finishPrimary({
      key: "compare",
      option: "primary",
      total: 1,
      choices: [{ value: "sensor.primary", label: "Primary" }],
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-choice-combobox="primary"]')).not.toBeNull(),
    );
    document.querySelector<HTMLInputElement>('[data-choice-combobox="primary"]')!.focus();
    const focusedSearch = document.querySelector<HTMLInputElement>(
      '[data-choice-search="primary"]',
    )!;
    expect(document.activeElement).toBe(focusedSearch);

    finishSecondary({
      key: "compare",
      option: "secondary",
      total: 1,
      choices: [{ value: "sensor.secondary", label: "Secondary" }],
    });
    await loading;

    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>('[data-choice-search="primary"]'),
    );
    expect(
      document.querySelector('[data-choice-combobox="primary"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("keeps the multiselect fallback as an array", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entities",
          label: "Entities",
          type: "multiselect",
          choices_from: "entity",
          default: ["sensor.saved", "sensor.other"],
        },
      ],
    });
    choicesMock.mockRejectedValue(new Error("Connected Tesserae is unavailable"));

    await loadWidgetConfig("history");

    const fallback = document.querySelector<HTMLTextAreaElement>(
      '#config-panel textarea[data-name="entities"]',
    );
    expect(fallback?.value).toBe("sensor.saved\nsensor.other");

    fallback!.value = " sensor.kitchen \n\n sensor.outside ";
    fallback!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(state.options.entities).toEqual(["sensor.kitchen", "sensor.outside"]);
  });

  it("ignores a stale failure after another widget starts loading", async () => {
    optionsMock.mockImplementation(async (key) => ({
      key,
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: `${key}.saved`,
        },
      ],
    }));
    adminMock.mockImplementation(async (key) => ({
      key,
      has_admin: false,
      url: `/plugins/${key}/`,
    }));
    settingsMock.mockImplementation(async (key) => ({ key, settings: [], current: {} }));

    let rejectFirst!: (reason: Error) => void;
    let finishSecond!: (value: Awaited<ReturnType<typeof getWidgetChoices>>) => void;
    choicesMock.mockImplementation((key) => {
      if (key === "first") {
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return new Promise((resolve) => {
        finishSecond = resolve;
      });
    });

    const firstLoad = loadWidgetConfig("first");
    await Promise.resolve();
    await Promise.resolve();
    const secondLoad = loadWidgetConfig("second");
    await Promise.resolve();
    await Promise.resolve();

    rejectFirst(new Error("first widget failed"));
    await firstLoad;

    const panel = document.getElementById("config-panel")!;
    expect(panel.textContent).toContain("Loading choices");
    expect(panel.textContent).not.toContain("first widget failed");

    finishSecond({
      key: "second",
      option: "entity",
      total: 1,
      choices: [{ value: "second.saved", label: "Second" }],
    });
    await secondLoad;

    expect(
      document.querySelector('[data-choice-value="second.saved"][aria-selected="true"]'),
    ).not.toBeNull();
  });

  it("keeps a saved select value that is absent from the loaded choices", async () => {
    state.options = { entity: "sensor.saved" };
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
          default: "sensor.default",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 1,
      choices: [{ value: "sensor.other", label: "Other" }],
    });

    await loadWidgetConfig("history", { preserveOptions: true });

    const choices = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-choice-list="entity"] [data-choice-option="entity"]',
      ),
    );
    expect(choices.map((choice) => choice.dataset.choiceValue)).toEqual([
      "sensor.saved",
      "sensor.other",
    ]);
    expect(
      choices.find((choice) => choice.getAttribute("aria-selected") === "true")?.dataset
        .choiceValue,
    ).toBe("sensor.saved");
  });

  it("can clear a saved select value that is absent from the loaded choices", async () => {
    state.options = { entity: "sensor.saved" };
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 1,
      choices: [{ value: "sensor.other", label: "Other" }],
    });

    await loadWidgetConfig("history", { preserveOptions: true });
    renderMock.mockClear();
    document
      .querySelector<HTMLButtonElement>('[data-choice-clear="entity"]')!
      .click();

    expect(state.options.entity).toBe("");
    expect(document.querySelector('[data-choice-value="sensor.saved"]')).toBeNull();
    expect(document.querySelector('[data-choice-value=""]')).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]'),
    );
    expect(renderMock).toHaveBeenCalledOnce();
  });

  it("keeps saved multiselect values visible when choices no longer contain them", async () => {
    state.options = { entities: ["sensor.saved"] };
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entities",
          label: "Entities",
          type: "multiselect",
          choices_from: "entity",
          default: [],
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entities",
      total: 1,
      choices: [{ value: "sensor.other", label: "Other" }],
    });

    await loadWidgetConfig("history", { preserveOptions: true });

    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '#config-panel input[type="checkbox"][data-name="entities"]',
      ),
    );
    expect(boxes.map((box) => box.value)).toEqual(["sensor.saved", "sensor.other"]);
    expect(boxes[0].checked).toBe(true);
    expect(state.options.entities).toEqual(["sensor.saved"]);
  });

  it("shows an explicit empty state when no dynamic choices exist", async () => {
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 0,
      choices: [],
    });

    await loadWidgetConfig("history");

    const panel = document.getElementById("config-panel")!;
    expect(panel.textContent).toContain("No choices found");
    expect(panel.querySelector('select[data-name="entity"]')).toBeNull();
    expect(panel.querySelector('[data-choice-combobox="entity"]')).toBeNull();
  });

  it("reports an empty dynamic source while preserving a saved value", async () => {
    state.options = { entity: "sensor.saved" };
    optionsMock.mockResolvedValue({
      key: "history",
      options: [
        {
          name: "entity",
          label: "Entity",
          type: "select",
          choices_from: "entity",
        },
      ],
    });
    choicesMock.mockResolvedValue({
      key: "history",
      option: "entity",
      total: 0,
      choices: [],
    });

    await loadWidgetConfig("history", { preserveOptions: true });

    const panel = document.getElementById("config-panel")!;
    expect(panel.querySelector('[data-choice-value="sensor.saved"][aria-selected="true"]')).not.toBeNull();
    expect(panel.querySelector<HTMLInputElement>('[data-choice-combobox="entity"]')?.value).toBe(
      "sensor.saved",
    );
    expect(panel.textContent).toContain("No choices found; keeping the current value");
  });
});
