import { defineConfig } from "vitest/config";

// jsdom gives the api tests a DOM-ish global (and a place to stub fetch); the
// logic tests are pure and don't need it, but one environment keeps config lean.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
