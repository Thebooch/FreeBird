import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.tsx"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    external: ["react", "react-dom", "@freebirdai/react", "@freebirdai/core", "tailwindcss"],
    splitting: false,
  },
  {
    entry: ["src/plugin.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    external: ["tailwindcss"],
    splitting: false,
  },
]);
