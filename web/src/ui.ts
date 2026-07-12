// Shared DOM chrome helpers used across the controller modules: element lookup
// and the two small status write-outs (the preview note and the header pills).

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setNote(msg: string, kind: "" | "warn" | "err" = "") {
  const note = $<HTMLDivElement>("note");
  note.textContent = msg;
  note.className = `note ${kind}`;
}

export function setPill(
  id: string,
  textId: string,
  kind: "ok" | "warn" | "bad" | "",
  label: string,
) {
  const pill = $<HTMLSpanElement>(id);
  pill.classList.remove("ok", "warn", "bad");
  if (kind) pill.classList.add(kind);
  $<HTMLSpanElement>(textId).textContent = label;
}
