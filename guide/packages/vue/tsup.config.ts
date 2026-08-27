import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["vue", "@freebirdai/core", "@freebirdai/core-state"],
  splitting: false,
  treeshake: true,
});
