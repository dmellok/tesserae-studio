import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateWidget,
  getCatalog,
  getConfig,
  getHealth,
  getPluginSchema,
  getWidgetChoices,
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

// A minimal ok Response stand-in; json() hands back whatever the test supplies.
function ok(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(ok({}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The (url, init) pair the last fetch was called with.
function lastCall(): [string, RequestInit | undefined] {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return [url as string, init as RequestInit | undefined];
}

describe("GET endpoints hit the right URL", () => {
  it("getHealth", async () => {
    await getHealth();
    expect(lastCall()[0]).toBe("/studio/api/health");
  });

  it("getConfig", async () => {
    await getConfig();
    expect(lastCall()[0]).toBe("/studio/api/config");
  });

  it("getCatalog", async () => {
    await getCatalog();
    expect(lastCall()[0]).toBe("/studio/api/catalog");
  });

  it("lintWidget", async () => {
    await lintWidget("hello_stat");
    expect(lastCall()[0]).toBe("/studio/api/lint/hello_stat");
  });

  it("returns the parsed JSON body", async () => {
    fetchMock.mockResolvedValueOnce(ok({ studio: "ok", mode: "disk" }));
    const h = await getHealth();
    expect(h).toEqual({ studio: "ok", mode: "disk" });
  });
});

describe("URL encoding of keys", () => {
  it("encodes the widget key in getWidgetData", async () => {
    await getWidgetData("news core");
    expect(lastCall()[0]).toBe("/studio/api/widgets/news%20core/data");
  });

  it("encodes the widget key in registerWidget", async () => {
    await registerWidget("a/b");
    expect(lastCall()[0]).toBe("/studio/api/register/a%2Fb");
  });

  it("encodes the widget in mineSchema", async () => {
    await mineSchema("wx&co");
    expect(lastCall()[0]).toBe("/studio/api/mine/wx%26co");
  });

  it("encodes the widget and option in getWidgetChoices", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        key: "history widget",
        option: "primary entity",
        total: 1,
        choices: [{ value: "sensor.room", label: "Room" }],
      }),
    );

    const result = await getWidgetChoices("history widget", "primary entity");

    expect(lastCall()[0]).toBe(
      "/studio/api/widgets/history%20widget/choices?option=primary%20entity",
    );
    expect(result.choices).toEqual([{ value: "sensor.room", label: "Room" }]);
  });

  it("encodes a dynamic choices search page", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        key: "history widget",
        option: "primary entity",
        total: 245,
        offset: 100,
        choices: [{ value: "sensor.kitchen", label: "Kitchen" }],
      }),
    );

    const result = await getWidgetChoices(
      "history widget",
      "primary entity",
      "kitchen & hall",
      100,
    );

    expect(lastCall()[0]).toBe(
      "/studio/api/widgets/history%20widget/choices" +
        "?option=primary%20entity&q=kitchen%20%26%20hall&offset=100",
    );
    expect(result).toMatchObject({ total: 245, offset: 100 });
  });
});

describe("request shapes", () => {
  it("writeFile PUTs the content as a JSON body", async () => {
    await writeFile("hello_stat", "client.js", "export default () => {}");
    const [url, init] = lastCall();
    expect(url).toBe("/studio/api/files/hello_stat/client.js");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ content: "export default () => {}" });
  });

  it("readFile GETs (no method)", async () => {
    await readFile("hello_stat", "plugin.json");
    const [url, init] = lastCall();
    expect(url).toBe("/studio/api/files/hello_stat/plugin.json");
    expect(init).toBeUndefined();
  });

  it("scaffoldWidget POSTs the spec", async () => {
    await scaffoldWidget({ name: "Air Quality", archetype: "stat", server: true });
    const [url, init] = lastCall();
    expect(url).toBe("/studio/api/scaffold");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "Air Quality",
      archetype: "stat",
      server: true,
    });
  });

  it("scaffoldBundle POSTs the spec", async () => {
    await scaffoldBundle({ name: "News", members: [{ name: "Headlines" }], admin: true });
    const [url, init] = lastCall();
    expect(url).toBe("/studio/api/scaffold-bundle");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "News",
      members: [{ name: "Headlines" }],
      admin: true,
    });
  });

  it("duplicateWidget POSTs source + name", async () => {
    await duplicateWidget("hello_stat", "My Copy");
    expect(JSON.parse(lastCall()[1]?.body as string)).toEqual({
      source: "hello_stat",
      name: "My Copy",
    });
  });

  it("registerWidget POSTs, unregisterWidget DELETEs", async () => {
    await registerWidget("w");
    expect(lastCall()[1]?.method).toBe("POST");
    await unregisterWidget("w");
    expect(lastCall()[1]?.method).toBe("DELETE");
  });

  it("mineSchema POSTs its options", async () => {
    await mineSchema("wx", {
      source: "auto",
      apply: true,
      options: {
        entities: "media_player.living_room",
        show_ratings: false,
      },
    });
    expect(JSON.parse(lastCall()[1]?.body as string)).toEqual({
      source: "auto",
      apply: true,
      options: {
        entities: "media_player.living_room",
        show_ratings: false,
      },
    });
  });

  it("mineSchema defaults to an empty options body", async () => {
    await mineSchema("wx");
    expect(JSON.parse(lastCall()[1]?.body as string)).toEqual({});
  });
});

describe("error handling", () => {
  it("throws with url + status + statusText on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    } as Response);
    await expect(lintWidget("missing")).rejects.toThrow(
      "/studio/api/lint/missing -> 404 Not Found",
    );
  });

  it("propagates a network rejection", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(getHealth()).rejects.toThrow("offline");
  });

  it("surfaces the Studio error when dynamic choices cannot load", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "widget is not registered" }),
    } as Response);

    await expect(getWidgetChoices("history", "entities")).rejects.toThrow(
      "widget is not registered",
    );
  });
});

describe("getPluginSchema", () => {
  it("returns the parsed schema when present", async () => {
    fetchMock.mockResolvedValueOnce(ok({ type: "object" }));
    expect(await getPluginSchema()).toEqual({ type: "object" });
  });

  it("returns null when the schema is unavailable (non-ok)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    expect(await getPluginSchema()).toBeNull();
  });
});
