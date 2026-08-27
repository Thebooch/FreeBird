import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "dash/packages/**/*.test.ts",
      "dash/packages/**/*.test.tsx",
      "dash/apps/**/src/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
    // OneDrive's filesystem flakes under parallel workers, and its I/O is slow
    // enough that filesystem-heavy suites trip vitest's default 5s timeout —
    // different tests fail on each run. See dash/AGENTS.md.
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 90_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
