import { defineConfig } from "vite";

// The browser stays single-origin: everything a mounted widget reaches, plus
// Studio's own API, is proxied to the thin FastAPI server on :8770, which in
// turn reverse-proxies the asset/API/render paths to Tesserae. Keep these
// prefixes in sync with studio_server.proxy.PROXY_PREFIXES.
const STUDIO_SERVER = process.env.STUDIO_SERVER_URL || "http://localhost:8770";
const proxied = ["/studio", "/api/mcp", "/static", "/plugins", "/_test"];

export default defineConfig({
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: STUDIO_SERVER, changeOrigin: true }]),
    ),
  },
});
