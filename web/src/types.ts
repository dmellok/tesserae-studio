// Shapes returned by Tesserae's /api/mcp/catalog (via app/panels_schema.py)
// and Studio's own /studio/api endpoints.

export interface Fragment {
  id: string; // "full" for the whole widget
  label: string;
  w: number;
  h: number;
  icon?: string;
}

export interface Widget {
  key: string; // plugin id
  name: string;
  icon: string;
  desc: string;
  fragments: Fragment[];
}

export interface Catalog {
  widgets: Widget[];
  appearance?: unknown;
}

export interface Health {
  studio: string;
  tesserae: "ok" | "unreachable";
  // "off" = Tesserae is up but the `mcp` experiment is disabled, so the
  // catalog/preview data won't load until it's switched on.
  mcp: "ok" | "off" | "unreachable";
  url: string;
}

export interface SizePreset {
  w: number;
  h: number;
}

export interface Config {
  tesserae_url: string;
  sizes: Record<string, SizePreset>;
  features: Record<string, boolean>;
}

// POST /api/mcp/widgets/<key>/data
export interface WidgetData {
  data: unknown;
  data_source?: string;
  fields?: Array<{ path: string; type: string; sample: unknown }>;
}
