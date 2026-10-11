import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    dts: true,
    exports: true,
  },
  test: {
    name: "core",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
