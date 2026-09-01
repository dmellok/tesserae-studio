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

  it("shows loading and then fills the existing select", async () => {
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
      choices: [
        { value: "sensor.room", label: "Room" },
        { value: "sensor.outside", label: "Outside" },
      ],
    });
    await loading;

    const select = document.querySelector<HTMLSelectElement>(
      '#config-panel select[data-name="entity"]',
    );
    expect(Array.from(select?.options || []).map((option) => option.value)).toEqual([
      "sensor.room",
      "sensor.outside",
    ]);
    expect(select?.value).toBe("sensor.room");
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

    const select = document.querySelector<HTMLSelectElement>('[data-name="entity"]')!;
    select.value = "sensor.outside";
    select.dispatchEvent(new Event("input", { bubbles: true }));

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

    expect(document.querySelector<HTMLSelectElement>('[data-name="primary"]')?.value).toBe(
      "sensor.primary",
    );
    expect(
      document.querySelector<HTMLInputElement>('input[type="text"][data-name="secondary"]'),
    ).not.toBeNull();
    expect(document.getElementById("config-panel")?.textContent).toContain("secondary failed");
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

    expect(document.querySelector<HTMLSelectElement>('[data-name="entity"]')?.value).toBe(
      "second.saved",
    );
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

    const select = document.querySelector<HTMLSelectElement>('[data-name="entity"]')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "sensor.saved",
      "sensor.other",
    ]);
    expect(select.value).toBe("sensor.saved");
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
    expect(panel.querySelector<HTMLSelectElement>('[data-name="entity"]')?.value).toBe(
      "sensor.saved",
    );
    expect(panel.textContent).toContain("No choices found; keeping the current value");
  });
});
