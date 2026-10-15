import { expect, it, vi } from "vitest";
import { mountWidget } from "./mount";

const render = vi.fn();
vi.mock("/plugins/probe/client.js", () => ({ default: render }));

it("passes the locale contract of Tesserae's ctx to the widget", async () => {
  await mountWidget(document.createElement("div"), {
    pluginId: "probe",
    fragment: "full",
    w: 300,
    h: 200,
    panelW: 800,
    panelH: 480,
    options: {},
    data: {},
  });

  const ctx = render.mock.calls[0][1];
  expect(ctx.locale).toBe("en");
  expect(ctx.t("some.key", "fallback")).toBe("fallback");
  expect(ctx.t("some.key")).toBe("some.key");
});
