import { beforeEach, expect, it, vi } from "vitest";
import { getCatalog } from "./api";
import { refreshCatalog, selectWidget } from "./catalog";
import { loadWidgetConfig } from "./configForm";
import { render } from "./preview";
import { state } from "./state";
import { loadEditor } from "./workspace";

vi.mock("./api", () => ({
  deleteWidget: vi.fn(),
  getCatalog: vi.fn(),
  scaffoldBundle: vi.fn(),
  scaffoldWidget: vi.fn(),
}));
vi.mock("./configForm", () => ({ loadWidgetConfig: vi.fn() }));
vi.mock("./events", () => ({ markLocalMutation: vi.fn() }));
vi.mock("./logic", () => ({ parseMembers: vi.fn() }));
vi.mock("./preview", () => ({ render: vi.fn() }));
vi.mock("./workspace", () => ({ loadEditor: vi.fn() }));

const configMock = vi.mocked(loadWidgetConfig);
const editorMock = vi.mocked(loadEditor);
const renderMock = vi.mocked(render);
const catalogMock = vi.mocked(getCatalog);

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = `
    <select id="widget"></select>
    <select id="fragment"></select>
    <button id="delete-widget"></button>
  `;
  state.widgets = [
    { key: "a", name: "A", icon: "", desc: "", fragments: [] },
    { key: "b", name: "B", icon: "", desc: "", fragments: [] },
  ];
  state.widget = undefined;
});

it("does not continue a stale widget selection into editor and preview", async () => {
  let finishA!: () => void;
  configMock.mockImplementation(
    (key) =>
      new Promise<void>((resolve) => {
        if (key === "a") finishA = resolve;
      }),
  );

  const firstSelection = selectWidget("a");
  void selectWidget("b");
  finishA();
  await firstSelection;

  expect(state.widget?.key).toBe("b");
  expect(editorMock).not.toHaveBeenCalled();
  expect(renderMock).not.toHaveBeenCalled();
});

it("does not revive the first selection after selecting the same widget again", async () => {
  let finishFirstA!: () => void;
  let call = 0;
  configMock.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        call += 1;
        if (call === 1) finishFirstA = resolve;
        else if (call === 3) resolve();
      }),
  );

  const firstSelection = selectWidget("a");
  void selectWidget("b");
  await selectWidget("a");
  editorMock.mockClear();
  renderMock.mockClear();

  finishFirstA();
  await firstSelection;

  expect(editorMock).not.toHaveBeenCalled();
  expect(renderMock).not.toHaveBeenCalled();
});

it("preserves a widget selected while the catalog refresh is pending", async () => {
  state.widget = state.widgets[0];
  configMock.mockResolvedValue(undefined);
  let finishCatalog!: (value: Awaited<ReturnType<typeof getCatalog>>) => void;
  catalogMock.mockReturnValue(
    new Promise((resolve) => {
      finishCatalog = resolve;
    }),
  );

  const refreshing = refreshCatalog("a");
  await selectWidget("b");
  finishCatalog({
    widgets: [
      { key: "a", name: "A", icon: "", desc: "", fragments: [] },
      { key: "b", name: "B", icon: "", desc: "", fragments: [] },
    ],
    appearance: {},
  });
  await refreshing;

  expect(state.widget?.key).toBe("b");
  expect(document.querySelector<HTMLSelectElement>("#widget")?.value).toBe("b");
});
