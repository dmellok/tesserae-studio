import type { Catalog, Config, Health, WidgetData } from "./types";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`${url} -> ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

export const getHealth = () => getJson<Health>("/studio/api/health");
export const getConfig = () => getJson<Config>("/studio/api/config");
export const getCatalog = () => getJson<Catalog>("/studio/api/catalog");

// Live fetch() output for a widget, feeding ctx.data. Options default to the
// manifest defaults server-side when omitted. Reuses Tesserae's flattener, the
// same endpoint mine_data_schema will read in M2.
export const getWidgetData = (key: string, options: Record<string, unknown> = {}) =>
  getJson<WidgetData>(`/api/mcp/widgets/${encodeURIComponent(key)}/data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ options }),
  });
