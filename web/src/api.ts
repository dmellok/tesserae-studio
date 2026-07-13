import type { Catalog, Config, FileEntry, Health, WidgetData } from "./types";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`${url} -> ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

export const getHealth = () => getJson<Health>("/studio/api/health");
export const getConfig = () => getJson<Config>("/studio/api/config");
export const getCatalog = () => getJson<Catalog>("/studio/api/catalog");

// ctx.data for the preview. Studio resolves the source: a live fetch() through
// the connected Tesserae (with the cell options so the data reflects the
// config), or the dev-gallery sample from the disk checkout.
export const getWidgetData = (key: string, options?: Record<string, unknown>) => {
  const q =
    options && Object.keys(options).length
      ? `?options=${encodeURIComponent(JSON.stringify(options))}`
      : "";
  return getJson<WidgetData>(`/studio/api/widgets/${encodeURIComponent(key)}/data${q}`);
};

// -- workspace file API (M1) ------------------------------------------------
export const getFiles = (widget: string) =>
  getJson<{ widget: string; files: FileEntry[] }>(
    `/studio/api/files/${encodeURIComponent(widget)}`,
  );

export const readFile = (widget: string, path: string) =>
  getJson<{ content: string }>(
    `/studio/api/files/${encodeURIComponent(widget)}/${path}`,
  );

export const writeFile = (widget: string, path: string, content: string) =>
  getJson<{ ok: boolean; size: number }>(
    `/studio/api/files/${encodeURIComponent(widget)}/${path}`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) },
  );

export interface ScaffoldSpec {
  name: string;
  archetype?: string;
  server?: boolean;
  fragments?: Array<{ id: string; label?: string }>;
}

export const scaffoldWidget = (spec: ScaffoldSpec) =>
  getJson<{ ok: boolean; key: string; files: string[] }>("/studio/api/scaffold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });

export const scaffoldBundle = (spec: {
  name: string;
  members: Array<{ name: string }>;
  admin: boolean;
}) =>
  getJson<{ ok: boolean; core: string; members: string[]; folders: string[] }>(
    "/studio/api/scaffold-bundle",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) },
  );

export const duplicateWidget = (source: string, name?: string) =>
  getJson<{ ok: boolean; key: string; files: string[] }>("/studio/api/duplicate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, name }),
  });

export interface RegisterState {
  ok: boolean;
  method: "symlink" | "push";
  // symlink path
  synced?: boolean;
  registered?: boolean;
  needs_reload?: boolean;
  // push path
  id?: string;
  version?: string;
  active?: boolean;
  restarting?: boolean;
}

// Register a workspace widget with the connected Tesserae. The server picks the
// method: a local symlink when co-located, an HTTP push (MCP) when remote / HA.
export const registerWidget = (widget: string) =>
  getJson<RegisterState>(`/studio/api/register/${encodeURIComponent(widget)}`, { method: "POST" });

export const unregisterWidget = (widget: string) =>
  getJson<RegisterState>(`/studio/api/register/${encodeURIComponent(widget)}`, { method: "DELETE" });

export interface LintFinding {
  rule: string;
  level: "error" | "warning";
  message: string;
  file: string;
  line: number | null;
}

export interface MineField {
  name: string;
  type: "num" | "str" | "arr";
  label: string;
  unit?: string;
  format?: string;
  display: string;
  chartable: boolean;
  sample: unknown;
}

export interface MineResult {
  ok: boolean;
  source: string;
  data_source: "live" | "sample" | "error";
  fields: MineField[];
  data_schema: { fields: unknown[]; sample: unknown };
  diff: { added: string[]; removed: string[]; changed: string[] };
  applied: boolean;
  warnings: string[];
}

export const mineSchema = (widget: string, opts: { source?: string; apply?: boolean } = {}) =>
  getJson<MineResult>(`/studio/api/mine/${encodeURIComponent(widget)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });

export const lintWidget = (widget: string) =>
  getJson<{ widget: string; findings: LintFinding[]; errors: number; warnings: number }>(
    `/studio/api/lint/${encodeURIComponent(widget)}`,
  );

export interface WidgetOption {
  name: string;
  type: string;
  label?: string;
  default?: unknown;
  choices?: Array<{ value: string; label?: string }>;
  choices_from?: string;
  min?: number;
  max?: number;
  step?: number;
}

// The widget's cell_options, from its manifest, for the config form.
export const getWidgetOptions = (key: string) =>
  getJson<{ key: string; options: WidgetOption[] }>(
    `/studio/api/widgets/${encodeURIComponent(key)}/options`,
  );

// Whether the widget/companion ships an admin page (server.py blueprint()) and
// the URL Studio proxies it at (live only, once registered).
export const getWidgetAdmin = (key: string) =>
  getJson<{ key: string; has_admin: boolean; url: string }>(
    `/studio/api/widgets/${encodeURIComponent(key)}/admin`,
  );

export interface WidgetSetting {
  name: string;
  type: string;
  label?: string;
  secret?: boolean;
  default?: unknown;
}

// The widget's declared settings (e.g. an API key), plus current values from the
// connected Tesserae (secrets redacted there).
export const getWidgetSettings = (key: string) =>
  getJson<{ key: string; settings: WidgetSetting[]; current: Record<string, unknown> }>(
    `/studio/api/widgets/${encodeURIComponent(key)}/settings`,
  );

// Push settings to the connected Tesserae so the widget's fetch() runs with real
// credentials. Throws if Tesserae has no settings endpoint (older versions).
export const setWidgetSettings = (key: string, values: Record<string, unknown>) =>
  getJson<{ ok: boolean }>(`/studio/api/widgets/${encodeURIComponent(key)}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });

// The manifest JSON schema for live plugin.json validation. Null when no disk
// checkout is available.
export const getPluginSchema = async (): Promise<object | null> => {
  const resp = await fetch("/studio/api/schema/plugin");
  return resp.ok ? ((await resp.json()) as object) : null;
};
