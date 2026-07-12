// Monaco integration. Multi-file models per widget, a Tesserae-tinted theme,
// JSON-schema validation for plugin.json, and Cmd/Ctrl+S to save. Workers are
// wired through Vite's ?worker imports.

import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// A light theme aligned to Tesserae's surfaces (base.css literals; Monaco themes
// can't read CSS vars, so the paper-warm neutrals are inlined here).
monaco.editor.defineTheme("tesserae", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#faf9f6",
    "editorLineNumber.foreground": "#a1a09a",
    "editorLineNumber.activeForeground": "#52524f",
    "editor.selectionBackground": "#dcefe8",
    "editor.lineHighlightBackground": "#faf9f6",
    "editorIndentGuide.background1": "#ebeae4",
    "focusBorder": "#0d8c7e",
  },
});

// Dark editor theme, mirroring Tesserae's base.css :root[data-theme="dark"]
// token values (Monaco themes take hex, not CSS vars, same as the light theme).
monaco.editor.defineTheme("tesserae-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#181b22", // --t-surface
    "editorGutter.background": "#13161c", // --t-surface-sunk
    "editorLineNumber.foreground": "#8b93a1", // --t-muted
    "editorLineNumber.activeForeground": "#b6bcc7", // --t-fg-soft
    "editor.foreground": "#e7e9ee", // --t-fg
    "editor.selectionBackground": "#143029", // --t-accent-tint
    "editor.lineHighlightBackground": "#1f232b", // --t-surface-soft
    "editorIndentGuide.background1": "#2a2f38", // --t-border
    "focusBorder": "#2dd4bf", // --t-accent
  },
});

function editorThemeName(): string {
  return document.documentElement.dataset.theme === "dark" ? "tesserae-dark" : "tesserae";
}

export interface OpenFile {
  path: string;
  content: string;
  language: string;
  editable: boolean;
}

export class WidgetEditor {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private models = new Map<string, monaco.editor.ITextModel>();
  private schema: object | null = null;
  private dirty = new Set<string>();
  private onDirtyCb: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.editor = monaco.editor.create(container, {
      theme: editorThemeName(),
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "none",
      padding: { top: 12 },
    });
  }

  onDirtyChange(cb: () => void) {
    this.onDirtyCb = cb;
  }

  onSaveRequest(cb: () => void) {
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, cb);
  }

  setTheme(dark: boolean) {
    monaco.editor.setTheme(dark ? "tesserae-dark" : "tesserae");
  }

  setSchema(schema: object | null) {
    this.schema = schema;
    this.applySchema();
  }

  // Replace all models with this widget's files and show `active`.
  open(widget: string, files: OpenFile[], active?: string) {
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.dirty.clear();

    for (const f of files) {
      const uri = monaco.Uri.parse(`inmemory://${widget}/${f.path}`);
      const model = monaco.editor.createModel(f.content, f.language, uri);
      model.onDidChangeContent(() => {
        this.dirty.add(f.path);
        this.onDirtyCb?.();
      });
      this.models.set(f.path, model);
    }
    this.applySchema();
    const first = active && this.models.has(active) ? active : files[0]?.path;
    if (first) this.show(first);
  }

  show(path: string) {
    const model = this.models.get(path);
    if (model) this.editor.setModel(model);
  }

  has(path: string): boolean {
    return this.models.has(path);
  }

  // Jump to a file + line (used by the lint panel).
  reveal(path: string, line: number | null) {
    if (!this.models.has(path)) return;
    this.show(path);
    if (line && line > 0) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
      this.editor.focus();
    }
  }

  value(path: string): string {
    return this.models.get(path)?.getValue() ?? "";
  }

  // Programmatic edit (used by tests; normal edits go through the UI).
  setValue(path: string, content: string) {
    this.models.get(path)?.setValue(content);
  }

  markSaved(path: string) {
    this.dirty.delete(path);
    this.onDirtyCb?.();
  }

  isDirty(path: string): boolean {
    return this.dirty.has(path);
  }

  anyDirty(): boolean {
    return this.dirty.size > 0;
  }

  // Diagnostics for a file (schema/syntax markers), used by tests + a future
  // inline error list.
  markers(path: string): monaco.editor.IMarker[] {
    const model = this.models.get(path);
    return model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
  }

  setReadOnly(ro: boolean) {
    this.editor.updateOptions({ readOnly: ro });
  }

  // Point the JSON validator at plugin.json models by their exact URIs.
  private applySchema() {
    if (!this.schema) return;
    const manifestUris = [...this.models.keys()]
      .filter((p) => p === "plugin.json" || p.endsWith("/plugin.json"))
      .map((p) => this.models.get(p)!.uri.toString());
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      enableSchemaRequest: false,
      schemas: [
        {
          uri: "https://tesserae/plugin.schema.json",
          fileMatch: manifestUris.length ? manifestUris : ["*/plugin.json"],
          schema: this.schema,
        },
      ],
    });
  }
}
