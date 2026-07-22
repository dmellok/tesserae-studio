// Shared DOM chrome helpers used across the controller modules: element lookup
// and the two small status write-outs (the preview note and the header pills).

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setNote(msg: string, kind: "" | "warn" | "err" = "") {
  const note = $<HTMLDivElement>("note");
  note.textContent = msg;
  note.className = `note ${kind}`;
  // Warnings and errors are easy to miss at the foot of a scrolled preview pane;
  // pull them into view so the user actually sees the failure.
  if (msg && (kind === "warn" || kind === "err")) {
    note.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

export function setPill(
  id: string,
  textId: string,
  kind: "ok" | "warn" | "bad" | "",
  label: string,
  title = "",
) {
  const pill = $<HTMLSpanElement>(id);
  pill.classList.remove("ok", "warn", "bad");
  if (kind) pill.classList.add(kind);
  if (title) pill.title = title;
  else pill.removeAttribute("title");
  $<HTMLSpanElement>(textId).textContent = label;
}
