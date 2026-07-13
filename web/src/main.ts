// Entry point: build the shell markup, create the editor, wire every controller
// module's listeners, then boot. All behaviour lives in the modules below; this
// file is orchestration only.

import { getConfig, getPluginSchema } from "./api";
import { initCatalog, refreshCatalog, selectWidget } from "./catalog";
import { initConfig } from "./configForm";
import { refreshHealth } from "./connection";
import { getEditor, initEditor } from "./editorInstance";
import { initEvents } from "./events";
import { initLint } from "./lintPanel";
import { initPreview } from "./preview";
import { initSettings } from "./settings";
import { state } from "./state";
import { APP_HTML } from "./template";
import { initTheme } from "./theme";
import { setNote } from "./ui";
import { initWorkspace, save } from "./workspace";
import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = APP_HTML;

initEditor();
initTheme();
initSettings();
initPreview();
initConfig();
initWorkspace();
initLint();
initCatalog();
initEvents(); // live-reload on workspace changes (agent or UI)

async function boot() {
  await refreshHealth();
  setInterval(refreshHealth, 10_000);
  try {
    state.config = await getConfig();
  } catch {
    /* presets fall back to option labels */
  }
  try {
    getEditor().setSchema(await getPluginSchema());
  } catch {
    /* schema optional; validation just won't run */
  }
  try {
    await refreshCatalog();
  } catch (err) {
    setNote(`Could not load widget catalog: ${err instanceof Error ? err.message : err}`, "err");
    return;
  }
  if (!state.widgets.length) {
    setNote("No widgets found. Add one to the workspace or connect a Tesserae.", "warn");
    return;
  }
  // Prefer opening an editable workspace widget first.
  const first = state.widgets.find((w) => w.editable) ?? state.widgets[0];
  await selectWidget(first.key);
}

// Dev-only handle for automated smoke tests (driving Monaco through the DOM is
// unreliable). Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __studio: unknown }).__studio = { editor: getEditor(), save, state };
}

void boot();
