import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  duplicateWidget,
  getCatalog,
  getConfig,
  getHealth,
  getPluginSchema,
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
    await mineSchema("wx", { source: "auto", apply: true });
    expect(JSON.parse(lastCall()[1]?.body as string)).toEqual({ source: "auto", apply: true });
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
