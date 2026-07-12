// Light / dark theme toggle, the same <html data-theme> switch Tesserae's admin
// uses, persisted to localStorage and mirrored into the Monaco editor theme.

import { getEditor } from "./editorInstance";
import { $ } from "./ui";

function applyTheme(theme: "light" | "dark") {
  const themeToggle = $<HTMLButtonElement>("theme-toggle");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "";
  themeToggle.innerHTML = `<i class="ph-bold ph-${theme === "dark" ? "sun" : "moon"}"></i>`;
  themeToggle.title = theme === "dark" ? "Switch to light" : "Switch to dark";
}

export function initTheme() {
  const themeToggle = $<HTMLButtonElement>("theme-toggle");
  applyTheme((localStorage.getItem("studio-theme") as "light" | "dark") ?? "light");
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("studio-theme", next);
    applyTheme(next);
    getEditor().setTheme(next === "dark");
  });
}
