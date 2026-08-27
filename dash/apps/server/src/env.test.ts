import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFile } from "./env.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("reads plain assignments, ignoring comments and blank lines", () => {
    expect(
      parseEnvFile(["# a comment", "", "ANTHROPIC_API_KEY=sk-ant-123", "PORT=4600"].join("\n")),
    ).toEqual({ ANTHROPIC_API_KEY: "sk-ant-123", PORT: "4600" });
  });

  it("tolerates the shapes people actually paste", () => {
    const parsed = parseEnvFile(
      [
        "export OPENAI_API_KEY=sk-oai",
        "  SPACED   =   value  ",
        'QUOTED="hello world"',
        "SINGLE='raw $notexpanded'",
        "TRAILING=value # inline comment",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      OPENAI_API_KEY: "sk-oai",
      SPACED: "value",
      QUOTED: "hello world",
      SINGLE: "raw $notexpanded",
      TRAILING: "value",
    });
  });

  it("keeps a '#' that is part of the value rather than a comment", () => {
    // Keys genuinely contain '#'; only " #" starts a comment.
    expect(parseEnvFile("DASH_MASTER_KEY=abc#def").DASH_MASTER_KEY).toBe("abc#def");
  });

  it("expands escapes in double quotes only", () => {
    expect(parseEnvFile('A="one\\ntwo"').A).toBe("one\ntwo");
    expect(parseEnvFile("B='one\\ntwo'").B).toBe("one\\ntwo");
  });

  it("skips a malformed line instead of throwing away the whole file", () => {
    expect(parseEnvFile(["this is not an assignment", "GOOD=yes"].join("\n"))).toEqual({
      GOOD: "yes",
    });
  });

  it("allows an empty value", () => {
    expect(parseEnvFile("ANTHROPIC_API_KEY=")).toEqual({ ANTHROPIC_API_KEY: "" });
  });
});

describe("loadEnvFile", () => {
  it("reports no file rather than failing when there is none", () => {
    const env: NodeJS.ProcessEnv = {};
    // A directory with no .env anywhere above it inside the temp root.
    expect(loadEnvFile({ startDir: dir, fileName: ".env.absent", env })).toEqual({
      path: null,
      applied: [],
      skipped: [],
    });
  });

  it("never overwrites a variable already set in the environment", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-file\nPORT=4600", "utf8");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "from-shell" };

    const result = loadEnvFile({ startDir: dir, env });

    // The exported value is a deliberate act; the file is a convenience.
    expect(env.ANTHROPIC_API_KEY).toBe("from-shell");
    expect(env.PORT).toBe("4600");
    expect(result.applied).toEqual(["PORT"]);
    expect(result.skipped).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("treats an exported empty string as set, not as absent", () => {
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=from-file", "utf8");
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "" };

    loadEnvFile({ startDir: dir, env });

    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("searches upward, so a root .env is found from a nested package", () => {
    // Mirrors `pnpm --filter @freebirdai/dash-server dev`, which runs in apps/server.
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=root-level", "utf8");
    const nested = join(dir, "apps", "server", "src");
    mkdirSync(nested, { recursive: true });

    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile({ startDir: nested, env });

    expect(env.ANTHROPIC_API_KEY).toBe("root-level");
    expect(result.path).toBe(join(dir, ".env"));
  });

  it("prefers the nearest file when both a package and the root have one", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=root", "utf8");
    const pkg = join(dir, "apps", "server");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, ".env"), "ANTHROPIC_API_KEY=package", "utf8");

    const env: NodeJS.ProcessEnv = {};
    loadEnvFile({ startDir: pkg, env });

    expect(env.ANTHROPIC_API_KEY).toBe("package");
  });

  it("returns names only, so a caller cannot log secrets by accident", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-secret", "utf8");
    const result = loadEnvFile({ startDir: dir, env: {} });

    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
  });
});
