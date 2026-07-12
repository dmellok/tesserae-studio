// The lint pill + findings panel: run the widget linter, summarise it on the
// pill, and list clickable findings that jump the editor to the offending line.

import { lintWidget } from "./api";
import type { LintFinding } from "./api";
import { getEditor } from "./editorInstance";
import { escapeHtml, lintSummary } from "./logic";
import type { Widget } from "./types";
import { $ } from "./ui";
import { openFile } from "./workspace";

export async function runLint(widget: Widget) {
  const lintPill = $<HTMLButtonElement>("lint-pill");
  const lintPanel = $<HTMLDivElement>("lint-panel");
  if (!widget.editable) {
    lintPill.hidden = true;
    lintPanel.hidden = true;
    lintPanel.innerHTML = "";
    return;
  }
  try {
    const res = await lintWidget(widget.key);
    renderLint(res.findings, res.errors, res.warnings);
  } catch {
    lintPill.hidden = true;
  }
}

function renderLint(findings: LintFinding[], errors: number, warnings: number) {
  const lintPill = $<HTMLButtonElement>("lint-pill");
  const lintPanel = $<HTMLDivElement>("lint-panel");
  lintPill.hidden = false;
  lintPill.classList.remove("ok", "warn", "bad");
  const summary = lintSummary(errors, warnings);
  if (summary.kind) lintPill.classList.add(summary.kind);
  $<HTMLSpanElement>("lint-text").textContent = summary.label;
  lintPanel.innerHTML =
    `<div class="lint-head"><i class="ph-bold ph-list-magnifying-glass"></i>` +
    `<span>${findings.length} finding${findings.length > 1 ? "s" : ""}</span></div>`;
  for (const f of findings) {
    const row = document.createElement("button");
    row.className = `lint-row ${f.level}`;
    row.innerHTML =
      `<i class="lint-ico ph-bold ${f.level === "error" ? "ph-x-circle" : "ph-warning"}"></i>` +
      `<span class="lint-msg">${escapeHtml(f.message)}</span>` +
      `<span class="lint-loc">${f.file}${f.line ? `:${f.line}` : ""}</span>`;
    row.addEventListener("click", () => {
      openFile(f.file);
      getEditor().reveal(f.file, f.line);
    });
    lintPanel.appendChild(row);
  }
  lintPanel.hidden = findings.length === 0;
}

// The lint pill toggles the findings panel open/closed.
export function initLint() {
  const lintPill = $<HTMLButtonElement>("lint-pill");
  const lintPanel = $<HTMLDivElement>("lint-panel");
  lintPill.addEventListener("click", () => {
    if (lintPanel.innerHTML) lintPanel.hidden = !lintPanel.hidden;
  });
}
