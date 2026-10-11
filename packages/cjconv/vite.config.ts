import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    // In the repo the core is used from source; published, it resolves to its dist.
    alias: {
      "@cityjson/cjconv-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    dts: true,
    exports: true,
    platform: "node",
  },
  test: {
    name: "cjconv",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Installs the native cityjson extension on first run.
    testTimeout: 60_000,
  },
});
