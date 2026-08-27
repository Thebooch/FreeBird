import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLayer, MemoryLayer } from "./layers.js";
import { PartRegistry } from "./registry.js";
import type { CodePart, DataPart } from "./types.js";

const theme = (id: string, accent: string, form: "data" = "data"): DataPart<{ accent: string }> => ({
  kind: "theme",
  id,
  form,
  data: { accent },
});

const codeComponent = (id: string): CodePart => ({
  kind: "component",
  id,
  form: "code",
  module: "./custom-gauge.js",
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-parts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("layered resolution", () => {
  const builtin = new MemoryLayer("builtin", [theme("default", "blue")]);

  it("falls through to the shipped default when nothing overrides it", () => {
    const registry = new PartRegistry([builtin]);
    const resolved = registry.resolve<{ accent: string }>({ kind: "theme", id: "default" });
    expect(resolved.layer).toBe("builtin");
    expect((resolved.part as DataPart<{ accent: string }>).data.accent).toBe("blue");
    expect(registry.isCustomised({ kind: "theme", id: "default" })).toBe(false);
  });

  it("prefers user over project over builtin", () => {
    const project = new MemoryLayer("project", [theme("default", "green")], true);
    const user = new MemoryLayer("user", [theme("default", "red")], true);

    expect(new PartRegistry([builtin]).data<{ accent: string }>({ kind: "theme", id: "default" })?.accent).toBe("blue");
    expect(
      new PartRegistry([builtin, project]).data<{ accent: string }>({ kind: "theme", id: "default" })?.accent,
    ).toBe("green");
    expect(
      new PartRegistry([builtin, project, user]).data<{ accent: string }>({ kind: "theme", id: "default" })?.accent,
    ).toBe("red");
  });

  it("returns null for a part nothing supplies", () => {
    expect(new PartRegistry([builtin]).get({ kind: "theme", id: "ghost" })).toBeNull();
  });

  it("reverting removes the override so the default answers again", () => {
    const user = new MemoryLayer("user", [], true);
    const registry = new PartRegistry([builtin, user]);
    const ref = { kind: "theme", id: "default" } as const;

    registry.put(theme("default", "red"));
    expect(registry.layerOf(ref)).toBe("user");

    registry.revert(ref);
    expect(registry.layerOf(ref)).toBe("builtin");
    expect(registry.data<{ accent: string }>(ref)?.accent).toBe("blue");
  });

  it("lists each part once, saying which layer supplies it", () => {
    const user = new MemoryLayer("user", [theme("default", "red"), theme("mine", "pink")], true);
    const listed = new PartRegistry([builtin, user]).list("theme");

    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => entry.ref.id === "default")).toMatchObject({
      layer: "user",
      customised: true,
    });
    expect(listed.find((entry) => entry.ref.id === "mine")).toMatchObject({ customised: true });
  });

  it("refuses to write to a read-only layer", () => {
    // The shipped defaults are the one thing nothing may overwrite in place;
    // customising means adding a part above them.
    expect(() => new PartRegistry([builtin]).put(theme("x", "y"), "builtin")).toThrow(
      /read-only|cannot be written/,
    );
  });
});

describe("the managed boundary", () => {
  const builtinGauge: DataPart<{ variant: string }> = {
    kind: "component",
    id: "gauge",
    form: "data",
    data: { variant: "shipped" },
  };
  const ref = { kind: "component", id: "gauge" } as const;

  it("supplies a code part when code is allowed", () => {
    const registry = new PartRegistry(
      [new MemoryLayer("builtin", [builtinGauge]), new MemoryLayer("user", [codeComponent("gauge")], true)],
      { allowCode: true },
    );
    expect(registry.get(ref)?.form).toBe("code");
    expect(registry.layerOf(ref)).toBe("user");
  });

  it("refuses a code part by default, falling back rather than blanking", () => {
    // Managed mode: the user still gets a working component — the shipped one.
    const registry = new PartRegistry([
      new MemoryLayer("builtin", [builtinGauge]),
      new MemoryLayer("user", [codeComponent("gauge")], true),
    ]);
    const resolved = registry.resolve(ref);

    expect(resolved.layer).toBe("builtin");
    expect(resolved.part?.form).toBe("data");
    // …and says so, so the interface can explain rather than pretend.
    expect(resolved.skipped).toEqual([{ layer: "user", reason: "code-not-allowed" }]);
  });

  it("reports a blocked part even when nothing else can answer", () => {
    const registry = new PartRegistry([new MemoryLayer("user", [codeComponent("gauge")], true)]);
    const resolved = registry.resolve(ref);
    expect(resolved.part).toBeNull();
    expect(resolved.skipped).toHaveLength(1);
  });

  it("cannot express stored source code, only a module to import", () => {
    // The type has no field for a source string, so no downstream mistake can
    // turn a stored part into eval.
    const part = codeComponent("gauge");
    expect(Object.keys(part)).not.toContain("source");
    expect(part.module).toBe("./custom-gauge.js");
  });
});

describe("FileLayer", () => {
  it("stores one whole part per file, so overrides are literally what changed", () => {
    const layer = new FileLayer("user", dir);
    layer.put(theme("default", "red"));

    expect(readdirSync(join(dir, "theme"))).toEqual(["default.json"]);
    expect((layer.get({ kind: "theme", id: "default" }) as DataPart<{ accent: string }>).data.accent).toBe("red");
  });

  it("round-trips through a fresh instance", () => {
    new FileLayer("user", dir).put(theme("default", "red"));
    expect(new FileLayer("user", dir).list("theme")).toEqual([{ kind: "theme", id: "default" }]);
  });

  it("refuses to store a code part", () => {
    // Config and code arrive through different doors on purpose.
    expect(() => new FileLayer("user", dir).put(codeComponent("gauge"))).toThrow(/only data parts/);
  });

  it("rejects an id that would escape the directory", () => {
    expect(() => new FileLayer("user", dir).put({ ...theme("x", "y"), id: "../escape" })).toThrow(
      /unsafe part id/,
    );
  });

  it("ignores a file whose contents disagree with its name", () => {
    const layer = new FileLayer("user", dir);
    layer.put(theme("default", "red"));
    // A body claiming to be a different part must not be served under this ref.
    require("node:fs").writeFileSync(
      join(dir, "theme", "default.json"),
      JSON.stringify({ kind: "theme", id: "somethingelse", form: "data", data: {} }),
      "utf8",
    );
    expect(layer.get({ kind: "theme", id: "default" })).toBeNull();
  });

  it("survives a corrupt file rather than refusing to start", () => {
    const layer = new FileLayer("user", dir);
    layer.put(theme("default", "red"));
    require("node:fs").writeFileSync(join(dir, "theme", "default.json"), "{not json", "utf8");
    expect(layer.get({ kind: "theme", id: "default" })).toBeNull();
  });

  it("reports nothing for a kind that has never been written", () => {
    expect(new FileLayer("user", dir).list("component")).toEqual([]);
  });
});
