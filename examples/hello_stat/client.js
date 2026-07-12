// Hello Stat, a minimal fragment-first widget.
//
// Paints from Spectra tokens only, sizes with container queries (cqmin) so it
// reflows at any cell size, and branches on ctx.cell.fragment so each piece
// stands alone on the Panels canvas. No animations, no fetch, no fixed hex.

export default function (shadow, ctx) {
  const o = (ctx.cell && ctx.cell.options) || {};
  const label = o.label ?? "Widgets shipped";
  const value = o.value ?? 42;
  const caption = o.caption ?? "this week";
  const fragment = (ctx.cell && ctx.cell.fragment) || "full";

  const styles = `
    <link rel="stylesheet" href="/static/style/spectra-widgets.css" />
    <style>
      .w { box-sizing: border-box; width: 100%; height: 100%;
           container-type: size; color: var(--text-primary);
           background: var(--surface); }
      .stat-body { width: 100%; height: 100%; display: flex; flex-direction: column;
                   align-items: center; justify-content: center; gap: 2cqmin;
                   padding: 6cqmin; text-align: center; }
      .icon { color: var(--accent-4); font-size: 14cqmin; line-height: 1; }
      .value { font-size: 34cqmin; font-weight: 700; line-height: 1;
               font-variant-numeric: tabular-nums; }
      .label { font-size: 8cqmin; color: var(--text-secondary); }
      .caption { font-size: 6cqmin; color: var(--text-muted); }
      /* Fragment layouts: each renders legibly at its own drawn size. */
      .frag-value .value { font-size: 46cqmin; }
      .frag-label { flex-direction: row; gap: 4cqmin; }
      .frag-label .icon { font-size: 20cqmin; }
      .frag-label .label { font-size: 16cqmin; }
    </style>`;

  let body;
  if (fragment === "value") {
    body = `<div class="stat-body frag-value"><div class="value">${value}</div></div>`;
  } else if (fragment === "label") {
    body = `<div class="stat-body frag-label">
              <i class="icon ph-bold ph-sparkle"></i>
              <div class="label">${label}</div>
            </div>`;
  } else {
    body = `<div class="stat-body">
              <i class="icon ph-bold ph-sparkle"></i>
              <div class="value">${value}</div>
              <div class="label">${label}</div>
              <div class="caption">${caption}</div>
            </div>`;
  }

  shadow.innerHTML = `${styles}<div class="w">${body}</div>`;
}
