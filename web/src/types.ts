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
  editable?: boolean; // true for widgets in the workspace
  origin?: string; // "workspace" | "disk" | "live" | ...
  synced?: boolean; // symlinked into Tesserae's marketplace
  registered?: boolean; // live in the running Tesserae registry
}

export interface FileEntry {
  path: string;
  size: number;
  editable: boolean;
  language: string;
}

export interface Catalog {
  widgets: Widget[];
  appearance?: unknown;
}

export interface Health {
  studio: string;
  tesserae: "ok" | "unreachable";
  // "off" = Tesserae is up but the `mcp` experiment is disabled.
  mcp: "ok" | "off" | "unreachable";
  mode: "disk" | "live" | "none"; // where assets + catalog come from
  interactive: boolean; // can we preview at all
  faithful: boolean; // is faithful (e-ink) render available
  live_data: boolean; // real fetch() data vs sample
  url: string;
  path: string | null;
}

export interface SizePreset {
  w: number;
  h: number;
}

export interface Config {
  tesserae_url: string;
  tesserae_path: string | null;
  tesserae_data_root: string | null;
  mcp_token_set: boolean;
  // How a workspace widget registers with the connected Tesserae right now.
  registration: "symlink" | "push" | "none";
  sizes: Record<string, SizePreset>;
}

// GET /studio/api/widgets/<key>/data (mode-agnostic: live fetch or disk sample)
export interface WidgetData {
  data: unknown;
  source: "live" | "sample" | "none";
  fields?: Array<{ path: string; type: string; sample: unknown }>;
}
