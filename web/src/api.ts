import type { Catalog, Config, Health, WidgetData } from "./types";

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
