// The visual design surface: fragment tabs, an element palette, an outline tree,
// and a property panel for the selected node. Pure rendering + event wiring;
// main.ts owns the model + codegen + persistence via the handlers.

import {
  BG_TOKENS,
  TEXT_TOKENS,
  findNode,
  type IconNode,
  type Layout,
  type LayoutNode,
  type StackNode,
  type StatNode,
  type TextNode,
} from "./model";

export interface DesignHandlers {
  layout: Layout;
  fragment: string;
  selectedId: string | null;
  bindOptions: string[];
  setFragment(id: string): void;
  select(id: string | null): void;
  add(type: LayoutNode["type"]): void;
  remove(id: string): void;
  move(id: string, d: -1 | 1): void;
  changed(): void; // a node was mutated in place; regenerate + re-render
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function field(label: string, control: HTMLElement) {
  const f = el("label", "d-field");
  f.appendChild(el("span", "d-flabel", label));
  f.appendChild(control);
  return f;
}

function selectEl(value: string, options: [string, string][], on: (v: string) => void) {
  const s = el("select");
  for (const [v, lbl] of options) {
    const o = el("option");
    o.value = v;
    o.textContent = lbl;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener("change", () => on(s.value));
  return s;
}

function numEl(value: number, on: (v: number) => void, min = 0, max = 100) {
  const i = el("input") as HTMLInputElement;
  i.type = "number";
  i.value = String(value);
  i.min = String(min);
  i.max = String(max);
  i.addEventListener("input", () => on(Number(i.value)));
  return i;
}

function textEl(value: string, on: (v: string) => void) {
  const i = el("input") as HTMLInputElement;
  i.type = "text";
  i.value = value;
  i.addEventListener("input", () => on(i.value));
  return i;
}

const tokenOpts = (): [string, string][] => TEXT_TOKENS.map((t) => [t, t.replace("--", "")]);
const bgOpts = (): [string, string][] => BG_TOKENS.map((t) => [t, t === "none" ? "none" : t.replace("--", "")]);

export function renderDesign(root: HTMLElement, h: DesignHandlers) {
  root.innerHTML = "";

  // Fragment tabs.
  const tabs = el("div", "d-frags");
  for (const id of Object.keys(h.layout.fragments)) {
    const b = el("button", "d-frag" + (id === h.fragment ? " active" : ""), id);
    b.addEventListener("click", () => h.setFragment(id));
    tabs.appendChild(b);
  }
  root.appendChild(tabs);

  // Palette.
  const pal = el("div", "d-palette");
  pal.appendChild(el("span", "d-plabel", "Add:"));
  for (const [t, lbl, icon] of [
    ["stack", "Stack", "ph-stack"],
    ["text", "Text", "ph-text-t"],
    ["stat", "Stat", "ph-number-square-four"],
    ["icon", "Icon", "ph-sticker"],
  ] as [LayoutNode["type"], string, string][]) {
    const b = el("button", "d-add");
    b.innerHTML = `<i class="ph-bold ${icon}"></i> ${lbl}`;
    b.addEventListener("click", () => h.add(t));
    pal.appendChild(b);
  }
  root.appendChild(pal);

  // Body: outline + props.
  const body = el("div", "d-body");
  const outline = el("div", "d-outline");
  renderOutline(outline, h.layout.fragments[h.fragment], h, 0);
  body.appendChild(outline);
  body.appendChild(renderProps(h));
  root.appendChild(body);
}

const NODE_ICON: Record<LayoutNode["type"], string> = {
  stack: "ph-stack",
  text: "ph-text-t",
  stat: "ph-number-square-four",
  icon: "ph-sticker",
};

function nodeLabel(n: LayoutNode): string {
  if (n.type === "stack") return `Stack (${n.dir})`;
  if (n.type === "text") return n.bind ? `Text · ${n.bind}` : `Text "${n.content.slice(0, 16)}"`;
  if (n.type === "stat") return n.bind ? `Stat · ${n.bind}` : `Stat "${n.content}"`;
  return `Icon ${n.icon}`;
}

function renderOutline(container: HTMLElement, node: LayoutNode, h: DesignHandlers, depth: number) {
  const row = el("div", "d-node" + (node.id === h.selectedId ? " sel" : ""));
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.innerHTML = `<i class="ph-bold ${NODE_ICON[node.type]}"></i><span class="d-nlabel">${nodeLabel(node)}</span>`;
  const ctrls = el("span", "d-nctrls");
  const up = el("button", "d-nbtn", "↑");
  up.addEventListener("click", (e) => { e.stopPropagation(); h.move(node.id, -1); });
  const dn = el("button", "d-nbtn", "↓");
  dn.addEventListener("click", (e) => { e.stopPropagation(); h.move(node.id, 1); });
  const del = el("button", "d-nbtn", "✕");
  del.addEventListener("click", (e) => { e.stopPropagation(); h.remove(node.id); });
  ctrls.append(up, dn, del);
  row.appendChild(ctrls);
  row.addEventListener("click", () => h.select(node.id));
  container.appendChild(row);
  if (node.type === "stack") {
    for (const c of node.children) renderOutline(container, c, h, depth + 1);
  }
}

function renderProps(h: DesignHandlers): HTMLElement {
  const panel = el("div", "d-props");
  const node = h.selectedId ? findNode(h.layout.fragments[h.fragment], h.selectedId) : null;
  if (!node) {
    panel.appendChild(el("p", "d-hint", "Select an element in the outline to edit it, or add one from the palette."));
    return panel;
  }
  panel.appendChild(el("div", "d-ptitle", nodeLabel(node)));
  const m = (fn: () => void) => { fn(); h.changed(); };
  const bindOpts: [string, string][] = [["", "(static)"], ...h.bindOptions.map((p) => [p, p] as [string, string])];

  if (node.type === "stack") {
    const s = node as StackNode;
    panel.append(
      field("Direction", selectEl(s.dir, [["col", "column"], ["row", "row"]], (v) => m(() => (s.dir = v as "row" | "col")))),
      field("Gap", numEl(s.gap, (v) => m(() => (s.gap = v)), 0, 40)),
      field("Padding", numEl(s.padding, (v) => m(() => (s.padding = v)), 0, 40)),
      field("Align", selectEl(s.align, [["start", "start"], ["center", "center"], ["end", "end"], ["stretch", "stretch"]], (v) => m(() => (s.align = v as StackNode["align"])))),
      field("Justify", selectEl(s.justify, [["start", "start"], ["center", "center"], ["end", "end"], ["between", "between"]], (v) => m(() => (s.justify = v as StackNode["justify"])))),
      field("Background", selectEl(s.bg, bgOpts(), (v) => m(() => (s.bg = v as StackNode["bg"])))),
      field("Grow", checkEl(s.grow, (v) => m(() => (s.grow = v)))),
    );
  } else if (node.type === "text") {
    const t = node as TextNode;
    panel.append(
      field("Bind", selectEl(t.bind || "", bindOpts, (v) => m(() => (t.bind = v || undefined)))),
      field("Text", textEl(t.content, (v) => m(() => (t.content = v)))),
      field("Size", numEl(t.size, (v) => m(() => (t.size = v)), 2, 60)),
      field("Weight", selectEl(String(t.weight), [["400", "regular"], ["600", "semibold"], ["700", "bold"]], (v) => m(() => (t.weight = Number(v) as TextNode["weight"])))),
      field("Colour", selectEl(t.color, tokenOpts(), (v) => m(() => (t.color = v as TextNode["color"])))),
      field("Align", selectEl(t.align, [["left", "left"], ["center", "center"], ["right", "right"]], (v) => m(() => (t.align = v as TextNode["align"])))),
    );
  } else if (node.type === "stat") {
    const s = node as StatNode;
    panel.append(
      field("Bind", selectEl(s.bind || "", bindOpts, (v) => m(() => (s.bind = v || undefined)))),
      field("Value", textEl(s.content, (v) => m(() => (s.content = v)))),
      field("Unit", textEl(s.unit || "", (v) => m(() => (s.unit = v || undefined)))),
      field("Size", numEl(s.size, (v) => m(() => (s.size = v)), 4, 80)),
      field("Colour", selectEl(s.color, tokenOpts(), (v) => m(() => (s.color = v as StatNode["color"])))),
    );
  } else {
    const i = node as IconNode;
    panel.append(
      field("Icon (ph-*)", textEl(i.icon, (v) => m(() => (i.icon = v)))),
      field("Size", numEl(i.size, (v) => m(() => (i.size = v)), 4, 60)),
      field("Colour", selectEl(i.color, tokenOpts(), (v) => m(() => (i.color = v as IconNode["color"])))),
    );
  }
  return panel;
}

function checkEl(value: boolean, on: (v: boolean) => void) {
  const i = el("input") as HTMLInputElement;
  i.type = "checkbox";
  i.checked = value;
  i.addEventListener("change", () => on(i.checked));
  return i;
}
