import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // GitHub Pages project site: https://cityjson.github.io/convert/
  base: "/convert/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": here("./src"),
      // In the repo the core is used from source; published, it resolves to its dist.
      "@cityjson/cjconv-core": here("../../packages/core/src/index.ts"),
    },
  },
  // duckdb-wasm ships its own worker and .wasm; pre-bundling breaks their ?url imports.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  test: {
    name: "web",
    include: ["tests/browser/**/*.test.ts"],
    // The browser smoke test boots duckdb-wasm.
    testTimeout: 60_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
