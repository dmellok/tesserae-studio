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
// the connected Tesserae, or the dev-gallery sample from the disk checkout.
export const getWidgetData = (key: string) =>
  getJson<WidgetData>(`/studio/api/widgets/${encodeURIComponent(key)}/data`);

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

// The manifest JSON schema for live plugin.json validation. Null when no disk
// checkout is available.
export const getPluginSchema = async (): Promise<object | null> => {
  const resp = await fetch("/studio/api/schema/plugin");
  return resp.ok ? ((await resp.json()) as object) : null;
};
