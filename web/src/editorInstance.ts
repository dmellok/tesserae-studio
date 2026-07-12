// The single Monaco editor instance, created after the shell markup exists (the
// WidgetEditor constructor mounts onto #monaco). Modules reach it via getEditor()
// so none of them capture it at import time, before initEditor() has run.

import { WidgetEditor } from "./editor";
import { $ } from "./ui";

let editor: WidgetEditor | null = null;

export function initEditor(): WidgetEditor {
  editor = new WidgetEditor($<HTMLDivElement>("monaco"));
  return editor;
}

export function getEditor(): WidgetEditor {
  if (!editor) throw new Error("editor used before initEditor()");
  return editor;
}
