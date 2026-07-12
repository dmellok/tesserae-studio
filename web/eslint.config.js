import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config, deliberately lean: JS + TypeScript recommended (non type-checked,
// so it stays fast and quiet). tsc --noEmit (via `npm run build`) is the source of
// truth for types; eslint just catches the lint-class mistakes tsc ignores.
export default tseslint.config(
  { ignores: ["dist/", "*.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { window: "readonly", document: "readonly", localStorage: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
