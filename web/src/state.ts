// The single shared app state. Every controller module reads and mutates this
// object; it is the one piece of cross-module coupling we keep deliberate.

import type { Config, FileEntry, Fragment, Widget } from "./types";

// The reference panel the preview mounts against (Tesserae's default portrait).
export const PANEL = { w: 1200, h: 825 };

export interface State {
  config?: Config;
  widgets: Widget[];
  widget?: Widget;
  fragment?: Fragment;
  sizeMode: string;
  w: number;
  h: number;
  dataCache: Map<string, unknown>;
  sourceCache: Map<string, string>; // widget data source per render (live/sample/none)
  tier: "interactive" | "faithful";
  faithful: boolean; // is the faithful render tier available (mcp reachable)
  version: number; // mount cache-bust, bumped on save
  files: FileEntry[];
  activeFile?: string;
  options: Record<string, unknown>; // current widget's cell_option values (config form)
}

export const state: State = {
  widgets: [],
  sizeMode: "md",
  w: 640,
  h: 400,
  dataCache: new Map(),
  sourceCache: new Map(),
  tier: "interactive",
  faithful: false,
  version: 0,
  files: [],
  options: {},
};
