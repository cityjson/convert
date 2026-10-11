import { defineConfig } from "vite-plus";

// What @cityjson/cjconv-core must never import: it stays pure TypeScript, so any
// DuckDB runtime (duckdb-wasm in the web app, @duckdb/node-api in cjconv) can drive it.
const CORE_FORBIDDEN = ["react", "react-dom", "react/*", "@duckdb/**", "node:*", "fs", "path"];

export default defineConfig({
  fmt: {
    ignorePatterns: ["apps/web/public/duckdb-ext/**", "**/dist/**"],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "apps/web/public/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    overrides: [
      {
        files: ["packages/core/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: CORE_FORBIDDEN,
                  message: "@cityjson/cjconv-core must stay free of React, DuckDB and Node APIs.",
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
    projects: ["packages/*", "apps/*"],
  },
  run: {
    cache: true,
  },
});
