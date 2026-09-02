import { beforeEach, expect, it, vi } from "vitest";
import {
  getWidgetAdmin,
  getWidgetChoices,
  getWidgetOptions,
  getWidgetSettings,
  registerWidget,
  unregisterWidget,
} from "./api";
import { refreshCatalog } from "./catalog";
import { state } from "./state";
import { initWorkspace } from "./workspace";

vi.mock("./api", () => ({
  duplicateWidget: vi.fn(),
  getFiles: vi.fn(),
  getWidgetAdmin: vi.fn(),
  getWidgetChoices: vi.fn(),
  getWidgetOptions: vi.fn(),
  getWidgetSettings: vi.fn(),
  mineSchema: vi.fn(),
  readFile: vi.fn(),
  registerWidget: vi.fn(),
  setWidgetSettings: vi.fn(),
  unregisterWidget: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("./catalog", () => ({
  refreshCatalog: vi.fn(),
  selectWidget: vi.fn(),
}));
vi.mock("./editorInstance", () => ({
  getEditor: vi.fn(() => ({
    onDirtyChange: vi.fn(),
    onSaveRequest: vi.fn(),
  })),
}));
vi.mock("./events", () => ({ markLocalMutation: vi.fn() }));
vi.mock("./lintPanel", () => ({ runLint: vi.fn() }));
vi.mock("./preview", () => ({
  isWidgetKind: vi.fn(() => true),
  render: vi.fn(),
}));

const registerMock = vi.mocked(registerWidget);
const unregisterMock = vi.mocked(unregisterWidget);
const refreshCatalogMock = vi.mocked(refreshCatalog);
const optionsMock = vi.mocked(getWidgetOptions);
const choicesMock = vi.mocked(getWidgetChoices);
const adminMock = vi.mocked(getWidgetAdmin);
const settingsMock = vi.mocked(getWidgetSettings);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <button id="save"></button>
    <button id="register-btn"><span id="register-text"></span></button>
    <button id="mine-btn"></button>
    <div id="note"></div>
    <button id="admin-btn"></button>
    <div id="config-panel"><div class="cfg-empty">widget has no option 'test_entities'</div></div>
    <iframe id="admin-frame"></iframe>
    <div id="frame"></div>
  `;
  state.config = {
    tesserae_url: "http://tesserae:8765",
    tesserae_path: null,
    tesserae_data_root: null,
    mcp_token_set: true,
    registration: "push",
    sizes: {},
  };
  state.widget = {
    key: "ha_dual_history",
    name: "Dual History",
    icon: "",
    desc: "",
    fragments: [],
    editable: true,
  };
  state.widgets = [state.widget];
  state.options = { test_entities: ["sensor.existing"] };

  registerMock.mockResolvedValue({
    ok: true,
    method: "push",
    id: "ha_dual_history",
    version: "0.1.0",
    active: true,
    restarting: false,
  });
  refreshCatalogMock.mockImplementation(async (key) => {
    const selected = state.widgets.find((widget) => widget.key === key);
    state.widget = selected ? { ...selected, registered: selected.key === "ha_dual_history" } : undefined;
  });
  optionsMock.mockResolvedValue({
    key: "ha_dual_history",
    options: [
      {
        name: "test_entities",
        label: "Test entities",
        type: "multiselect",
        default: [],
        choices_from: "entity",
      },
    ],
  });
  choicesMock.mockResolvedValue({
    key: "ha_dual_history",
    option: "test_entities",
    total: 2,
    offset: 0,
    choices: [
      { value: "sensor.existing", label: "Existing sensor" },
      { value: "sensor.kitchen", label: "Kitchen sensor" },
    ],
  });
  adminMock.mockResolvedValue({
    key: "ha_dual_history",
    has_admin: false,
    url: "/plugins/ha_dual_history/",
  });
  settingsMock.mockResolvedValue({
    key: "ha_dual_history",
    settings: [],
    current: {},
  });
});

it("refreshes dynamic Options after an active remote push", async () => {
  let finishCatalog!: () => void;
  refreshCatalogMock.mockImplementationOnce(
    (key) =>
      new Promise((resolve) => {
        finishCatalog = () => {
          const selected = state.widgets.find((widget) => widget.key === key);
          state.widget = selected ? { ...selected, registered: true } : undefined;
          resolve();
        };
      }),
  );
  initWorkspace();

  document.getElementById("register-btn")!.click();

  await vi.waitFor(() => expect(refreshCatalogMock).toHaveBeenCalled());
  expect(optionsMock).not.toHaveBeenCalled();
  finishCatalog();
  await vi.waitFor(() => {
    expect(document.getElementById("config-panel")?.textContent).toContain("Kitchen sensor");
  });
  expect(state.options.test_entities).toEqual(["sensor.existing"]);
});

it("keeps the current Options form when the pushed widget is not active", async () => {
  registerMock.mockResolvedValue({
    ok: true,
    method: "push",
    id: "ha_dual_history",
    version: "0.1.0",
    active: false,
    restarting: true,
  });
  initWorkspace();

  document.getElementById("register-btn")!.click();

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toContain("restarting");
  });
  expect(document.getElementById("config-panel")?.textContent).toContain(
    "widget has no option 'test_entities'",
  );
});

it("keeps the current Options form when push fails", async () => {
  registerMock.mockRejectedValue(new Error("Tesserae unavailable"));
  initWorkspace();

  document.getElementById("register-btn")!.click();

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toBe(
      "Register failed: Tesserae unavailable",
    );
  });
  expect(document.getElementById("config-panel")?.textContent).toContain(
    "widget has no option 'test_entities'",
  );
});

it("keeps the current Options form after symlink registration", async () => {
  registerMock.mockResolvedValue({
    ok: true,
    method: "symlink",
    synced: true,
    registered: false,
    needs_reload: true,
  });
  initWorkspace();

  document.getElementById("register-btn")!.click();

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toContain("Synced");
  });
  expect(document.getElementById("config-panel")?.textContent).toContain(
    "widget has no option 'test_entities'",
  );
});

it("keeps the current Options form after unregistering", async () => {
  state.widget = { ...state.widget!, registered: true };
  state.widgets = [state.widget];
  unregisterMock.mockResolvedValue({
    ok: true,
    method: "push",
    id: "ha_dual_history",
    version: "0.1.0",
    active: false,
    restarting: false,
  });
  refreshCatalogMock.mockImplementationOnce(async (key) => {
    const selected = state.widgets.find((widget) => widget.key === key);
    state.widget = selected ? { ...selected, registered: false } : undefined;
  });
  initWorkspace();

  document.getElementById("register-btn")!.click();

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toContain("Unregistered");
  });
  expect(document.getElementById("config-panel")?.textContent).toContain(
    "widget has no option 'test_entities'",
  );
});

it("does not replace Options when another widget is selected during push", async () => {
  let finishPush!: (value: Awaited<ReturnType<typeof registerWidget>>) => void;
  registerMock.mockReturnValue(
    new Promise((resolve) => {
      finishPush = resolve;
    }),
  );
  initWorkspace();
  document.getElementById("register-btn")!.click();

  const otherWidget = {
    key: "weather",
    name: "Weather",
    icon: "",
    desc: "",
    fragments: [],
    editable: true,
  };
  state.widgets.push(otherWidget);
  state.widget = otherWidget;
  state.options = { location: "Kyiv" };
  document.getElementById("config-panel")!.textContent = "Weather options";
  finishPush({
    ok: true,
    method: "push",
    id: "ha_dual_history",
    version: "0.1.0",
    active: true,
    restarting: false,
  });

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toContain("Live now");
  });
  expect(state.widget?.key).toBe("weather");
  expect(state.options).toEqual({ location: "Kyiv" });
  expect(document.getElementById("config-panel")?.textContent).toBe("Weather options");
});

it("does not replace Options when selection changes during catalog refresh", async () => {
  let finishCatalog!: () => void;
  refreshCatalogMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCatalog = resolve;
      }),
  );
  initWorkspace();
  document.getElementById("register-btn")!.click();
  await vi.waitFor(() => expect(refreshCatalogMock).toHaveBeenCalled());

  const otherWidget = {
    key: "weather",
    name: "Weather",
    icon: "",
    desc: "",
    fragments: [],
    editable: true,
  };
  state.widget = otherWidget;
  state.options = { location: "Kyiv" };
  document.getElementById("config-panel")!.textContent = "Weather options";
  finishCatalog();

  await vi.waitFor(() => {
    expect(document.getElementById("note")?.textContent).toContain("Live now");
  });
  expect(state.widget?.key).toBe("weather");
  expect(state.options).toEqual({ location: "Kyiv" });
  expect(document.getElementById("config-panel")?.textContent).toBe("Weather options");
});
