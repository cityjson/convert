import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// Modules that src/core must never import: it stays pure TypeScript so it can be
// unit-tested in Node and reused by a future CLI with a different Engine.
const CORE_FORBIDDEN = [
  "react",
  "react-dom",
  "react/*",
  "@duckdb/**",
  "@/engine/**",
  "@/features/**",
  "@/components/**",
  "../engine/**",
  "../features/**",
  "../components/**",
];

export default defineConfig({
  // GitHub Pages project site: https://cityjson.github.io/convert/
  base: "/convert/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // duckdb-wasm ships its own worker and .wasm; pre-bundling breaks their ?url imports.
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  fmt: {
    ignorePatterns: ["public/duckdb-ext/**"],
  },
  lint: {
    ignorePatterns: ["dist/**", "public/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    overrides: [
      {
        files: ["src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: CORE_FORBIDDEN,
                  message: "src/core must stay free of React, DuckDB and app layers.",
                },
              ],
            },
          ],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // Integration tests install the native cityjson extension on first run, and the
    // browser smoke test boots duckdb-wasm; both need more than the default timeout.
    testTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts", "tests/integration/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
