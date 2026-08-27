import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/express.ts",
    "src/fastify.ts",
    "src/next.ts",
    "src/middleware.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["express", "fastify", "@freebirdai/core"],
  splitting: false,
  treeshake: true,
});
