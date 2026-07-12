// The "Add an MCP client" modal: shows the copy-paste details for pointing an
// agent (Claude Code / Desktop) at this Studio's MCP server, derived from the
// current origin so they are correct wherever Studio is deployed.

import { mcpClientConfig } from "./logic";
import { $ } from "./ui";

export function initSettings() {
  const dialog = $<HTMLDialogElement>("mcp-dialog");
  const cfg = mcpClientConfig(window.location.origin);
  $<HTMLElement>("mcp-url").textContent = cfg.studioUrl;
  $<HTMLElement>("mcp-cli").textContent = cfg.cli;
  $<HTMLElement>("mcp-json").textContent = cfg.desktopJson;

  $<HTMLButtonElement>("mcp-settings").addEventListener("click", () => dialog.showModal());
  $<HTMLButtonElement>("mcp-close").addEventListener("click", () => dialog.close());

  for (const btn of dialog.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const source = $<HTMLElement>(btn.dataset.copy!);
      try {
        await navigator.clipboard.writeText(source.textContent ?? "");
        const label = btn.textContent;
        btn.textContent = "Copied";
        window.setTimeout(() => {
          btn.textContent = label;
        }, 1200);
      } catch {
        /* clipboard blocked (e.g. non-secure context); leave the text selectable */
      }
    });
  }
}
