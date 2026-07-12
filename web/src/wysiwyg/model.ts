// The WYSIWYG document model: a fragment-aware tree of Spectra-styled flex
// containers and leaf elements. This is the source of truth the visual editor
// edits and codegen turns into lint-clean client.js. Structured flex (not
// absolute positioning) so generated widgets reflow at any cell size via
// container queries, per the widget contract.

// Spectra text/icon colour tokens (never hex).
export const TEXT_TOKENS = [
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--icon",
  "--accent-1",
  "--accent-2",
  "--accent-3",
  "--accent-4",
  "--accent-5",
  "--accent-6",
] as const;
export type TextToken = (typeof TEXT_TOKENS)[number];

export const BG_TOKENS = ["none", "--surface", "--surface-sunken", "--bg"] as const;
export type BgToken = (typeof BG_TOKENS)[number];

export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "between";
export type TextAlign = "left" | "center" | "right";

export interface StackNode {
  id: string;
  type: "stack";
  dir: "row" | "col";
  gap: number; // cqmin
  padding: number; // cqmin
  align: Align;
  justify: Justify;
  bg: BgToken;
  grow: boolean; // flex:1 within its parent
  children: LayoutNode[];
}

export interface TextNode {
  id: string;
  type: "text";
  content: string;
  bind?: string; // dotted data path; overrides content when set
  size: number; // cqmin
  weight: 400 | 600 | 700;
  color: TextToken;
  align: TextAlign;
}

export interface StatNode {
  id: string;
  type: "stat";
  content: string;
  bind?: string;
  unit?: string;
  size: number; // cqmin
  color: TextToken;
}

export interface IconNode {
  id: string;
  type: "icon";
  icon: string; // e.g. "ph-cloud-sun"
  size: number; // cqmin
  color: TextToken;
}

export type LayoutNode = StackNode | TextNode | StatNode | IconNode;

export interface Layout {
  version: 1;
  fragments: Record<string, LayoutNode>; // root node per fragment id ("full", ...)
}

let _seq = 0;
export function nid(prefix = "n"): string {
  _seq += 1;
  return `${prefix}${_seq.toString(36)}${Math.floor(performance.now()).toString(36)}`;
}

export function newStack(dir: "row" | "col" = "col", grow = false): StackNode {
  return {
    id: nid("s"),
    type: "stack",
    dir,
    gap: 3,
    padding: dir === "col" && grow ? 6 : 0,
    align: "center",
    justify: "center",
    bg: "none",
    grow,
    children: [],
  };
}

export function newNode(type: LayoutNode["type"]): LayoutNode {
  switch (type) {
    case "stack":
      return newStack("col");
    case "text":
      return { id: nid("t"), type: "text", content: "Label", size: 8, weight: 400, color: "--text-secondary", align: "center" };
    case "stat":
      return { id: nid("v"), type: "stat", content: "42", size: 30, color: "--text-primary" };
    case "icon":
      return { id: nid("i"), type: "icon", icon: "ph-sparkle", size: 14, color: "--accent-4" };
  }
}

/** A sensible starter layout for a new fragment: icon + stat + label, centered. */
export function starterFragment(): StackNode {
  const root = newStack("col", true);
  root.children = [
    { ...(newNode("icon") as IconNode) },
    { ...(newNode("stat") as StatNode) },
    { ...(newNode("text") as TextNode) },
  ];
  return root;
}

export function starterLayout(fragmentIds: string[]): Layout {
  const fragments: Record<string, LayoutNode> = {};
  for (const id of fragmentIds.length ? fragmentIds : ["full"]) {
    fragments[id] = starterFragment();
  }
  if (!fragments.full) fragments.full = starterFragment();
  return { version: 1, fragments };
}

// -- tree helpers ----------------------------------------------------------
export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === "stack") {
    for (const c of root.children) {
      const hit = findNode(c, id);
      if (hit) return hit;
    }
  }
  return null;
}

export function findParent(root: LayoutNode, id: string): StackNode | null {
  if (root.type !== "stack") return null;
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = findParent(c, id);
    if (hit) return hit;
  }
  return null;
}

export function removeNode(root: LayoutNode, id: string): void {
  const parent = findParent(root, id);
  if (parent) parent.children = parent.children.filter((c) => c.id !== id);
}

export function moveNode(root: LayoutNode, id: string, delta: -1 | 1): void {
  const parent = findParent(root, id);
  if (!parent) return;
  const i = parent.children.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= parent.children.length) return;
  [parent.children[i], parent.children[j]] = [parent.children[j], parent.children[i]];
}
