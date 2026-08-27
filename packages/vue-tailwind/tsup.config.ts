import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    external: ["vue", "@freebirdai/core", "@freebirdai/vue"],
    splitting: false,
    treeshake: true,
  },
  {
    entry: ["src/plugin.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    target: "es2022",
    external: ["tailwindcss", "tailwindcss/plugin"],
    splitting: false,
  },
]);
