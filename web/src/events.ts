// Live-reload: subscribe to Studio's SSE stream and refresh the UI when the
// workspace changes. The main point is agent-driven changes (the MCP tools go
// through the same API), but any mutation emits an event. A short suppression
// window ignores the echo of this browser's own mutations so it never clobbers
// the editor you're actively typing in.

import { refreshCatalog, selectWidget } from "./catalog";
import { getEditor } from "./editorInstance";
import { runLint } from "./lintPanel";
import { render } from "./preview";
import { state } from "./state";
import { setNote } from "./ui";
import { loadEditor } from "./workspace";

const SUPPRESS_MS = 2500;
let lastLocal = 0;

// UI-originated mutations call this so the echoed event is ignored below.
export function markLocalMutation() {
  lastLocal = Date.now();
}

async function handle(ev: { action: string; widget?: string }) {
  if (Date.now() - lastLocal < SUPPRESS_MS) return; // our own change; already handled
  state.version = Date.now(); // bust the mount + data caches
  await refreshCatalog(state.widget?.key);

  if (ev.action === "scaffold") {
    // A new widget appeared. Jump to it, unless you have unsaved edits open.
    if (ev.widget && !getEditor().anyDirty()) await selectWidget(ev.widget);
    setNote(`Agent created ${ev.widget ?? "a widget"}.`, "");
    return;
  }

  if (ev.widget && ev.widget === state.widget?.key) {
    // The widget on screen changed. Reload its files only when you have no
    // unsaved edits, so live-reload never overwrites what you're typing.
    if (state.widget?.editable && !getEditor().anyDirty()) {
      await loadEditor(state.widget);
    }
    await render();
    if (state.widget?.editable) await runLint(state.widget);
    setNote(
      getEditor().anyDirty()
        ? `${ev.widget} changed externally, preview updated (your unsaved edits are kept).`
        : `Reloaded ${ev.widget} (external change).`,
      getEditor().anyDirty() ? "warn" : "",
    );
  } else {
    await render();
  }
}

export function initEvents() {
  let es: EventSource | null = null;
  const connect = () => {
    es = new EventSource("/studio/api/events");
    es.onmessage = (e) => {
      try {
        void handle(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      es?.close();
      window.setTimeout(connect, 3000); // reconnect after a drop
    };
  };
  connect();
}
