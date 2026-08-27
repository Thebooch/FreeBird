import { defineConfig } from "tsup";

export default defineConfig([
  // ESM build for bundler users (deps stay external).
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    splitting: false,
    treeshake: true,
  },
  // Self-contained IIFE for the script tag / CDN. Everything is inlined so a
  // plain <script src=".../freebird.js"> works with zero build step.
  {
    entry: { freebird: "src/index.ts" },
    format: ["iife"],
    outExtension: () => ({ js: ".js" }),
    dts: false,
    sourcemap: true,
    clean: false,
    target: "es2019",
    minify: true,
    platform: "browser",
    noExternal: [/.*/],
  },
]);
