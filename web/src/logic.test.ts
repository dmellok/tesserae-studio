import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  faithfulSize,
  healthPills,
  lintSummary,
  mcpClientConfig,
  mineDiffBits,
  optionDefaults,
  parseMembers,
} from "./logic";
import type { Health } from "./types";

describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml('<a href="x">Tom & Jerry</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Air Quality")).toBe("Air Quality");
  });
});

describe("faithfulSize", () => {
  it("passes named sizes through", () => {
    for (const s of ["xs", "sm", "md", "lg"]) {
      expect(faithfulSize(s, { w: 9999, h: 1 })).toBe(s);
    }
  });

  it("buckets custom sizes by the longer edge", () => {
    expect(faithfulSize("custom", { w: 180, h: 120 })).toBe("xs");
    expect(faithfulSize("custom", { w: 380, h: 200 })).toBe("sm");
    expect(faithfulSize("custom", { w: 640, h: 400 })).toBe("md");
    expect(faithfulSize("custom", { w: 1200, h: 800 })).toBe("lg");
  });

  it("uses the height when it is the longer edge", () => {
    expect(faithfulSize("fragment", { w: 100, h: 800 })).toBe("lg");
  });

  it("puts bucket boundaries on the lower size", () => {
    expect(faithfulSize("custom", { w: 200, h: 200 })).toBe("xs");
    expect(faithfulSize("custom", { w: 400, h: 400 })).toBe("sm");
    expect(faithfulSize("custom", { w: 700, h: 700 })).toBe("md");
  });
});

function health(over: Partial<Health>): Health {
  return {
    studio: "ok",
    tesserae: "ok",
    mcp: "ok",
    mode: "live",
    interactive: true,
    faithful: true,
    live_data: true,
    url: "http://x",
    path: null,
    ...over,
  };
}

describe("healthPills", () => {
  it("marks a standalone disk source ok", () => {
    const { mode } = healthPills(health({ mode: "disk" }));
    expect(mode).toEqual({ kind: "ok", label: "disk · standalone" });
  });

  it("flags no source as bad", () => {
    const { mode } = healthPills(health({ mode: "none" }));
    expect(mode).toEqual({ kind: "bad", label: "no source" });
  });

  it("warns (not bad) when Tesserae is offline but disk still works", () => {
    const { conn } = healthPills(health({ mode: "disk", tesserae: "unreachable" }));
    expect(conn).toEqual({ kind: "warn", label: "Tesserae offline" });
  });

  it("goes bad when Tesserae is offline and there is no disk source", () => {
    const { conn } = healthPills(health({ mode: "none", tesserae: "unreachable" }));
    expect(conn).toEqual({ kind: "bad", label: "Tesserae offline" });
  });

  it("nudges to enable the mcp experiment", () => {
    const { conn } = healthPills(health({ mcp: "off" }));
    expect(conn).toEqual({ kind: "warn", label: 'enable the "mcp" experiment' });
  });

  it("reports connected without live data", () => {
    const { conn } = healthPills(health({ live_data: false }));
    expect(conn).toEqual({ kind: "ok", label: "connected" });
  });

  it("reports live data + faithful when fully connected", () => {
    const { conn } = healthPills(health({}));
    expect(conn).toEqual({ kind: "ok", label: "live data + faithful" });
  });
});

describe("lintSummary", () => {
  it("is clean with no findings", () => {
    expect(lintSummary(0, 0)).toEqual({ kind: "ok", label: "lint clean" });
  });

  it("pluralises warnings", () => {
    expect(lintSummary(0, 1)).toEqual({ kind: "warn", label: "1 warning" });
    expect(lintSummary(0, 3)).toEqual({ kind: "warn", label: "3 warnings" });
  });

  it("leads with errors and appends the warn count", () => {
    expect(lintSummary(2, 0)).toEqual({ kind: "bad", label: "2 errors" });
    expect(lintSummary(1, 2)).toEqual({ kind: "bad", label: "1 error · 2 warn" });
  });
});

describe("mineDiffBits", () => {
  it("is empty when nothing changed", () => {
    expect(mineDiffBits({ added: [], changed: [], removed: [] })).toBe("");
  });

  it("summarises added / changed / removed in order", () => {
    expect(mineDiffBits({ added: ["a", "b"], changed: ["c"], removed: ["d", "e", "f"] })).toBe(
      "+2 ~1 -3",
    );
  });

  it("omits empty buckets", () => {
    expect(mineDiffBits({ added: ["a"], changed: [], removed: [] })).toBe("+1");
  });
});

describe("optionDefaults", () => {
  it("collects declared defaults, skipping options without one", () => {
    expect(
      optionDefaults([
        { name: "face", default: "swiss" },
        { name: "show_seconds", default: true },
        { name: "label" },
      ]),
    ).toEqual({ face: "swiss", show_seconds: true });
  });

  it("keeps falsy defaults like false and 0", () => {
    expect(optionDefaults([{ name: "b", default: false }, { name: "n", default: 0 }])).toEqual({
      b: false,
      n: 0,
    });
  });
});

describe("mcpClientConfig", () => {
  it("builds the CLI and desktop config from the origin", () => {
    const cfg = mcpClientConfig("http://homeassistant.local:8770");
    expect(cfg.studioUrl).toBe("http://homeassistant.local:8770");
    expect(cfg.cli).toBe(
      "claude mcp add tesserae-studio -e STUDIO_URL=http://homeassistant.local:8770 -- tesserae-studio-mcp",
    );
    const parsed = JSON.parse(cfg.desktopJson);
    expect(parsed.mcpServers["tesserae-studio"]).toEqual({
      command: "tesserae-studio-mcp",
      env: { STUDIO_URL: "http://homeassistant.local:8770" },
    });
  });

  it("strips a trailing slash from the origin", () => {
    expect(mcpClientConfig("http://localhost:8770/").studioUrl).toBe("http://localhost:8770");
  });
});

describe("parseMembers", () => {
  it("splits, trims, and drops blank lines", () => {
    expect(parseMembers("Headlines\n  Ticker \n\n")).toEqual([
      { name: "Headlines" },
      { name: "Ticker" },
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseMembers("")).toEqual([]);
    expect(parseMembers("   \n  ")).toEqual([]);
  });
});
