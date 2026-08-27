import {
  canonicalIds,
  normalizeKnowledgeItem,
  type ManifestComponent,
  type RegistrationManifest,
} from "@freebirdai/manifest";
import {
  BANNER,
  gridLiteral,
  identFor,
  lit,
  relativeImport,
} from "./emit.js";
import { buildIntegrationSteps } from "./steps.js";
import type {
  CodegenOptions,
  CodegenResult,
  Framework,
  GeneratedFile,
} from "./types.js";

const DEFAULT_OUT_DIR = "src/freebird";

/** Client render binding for a framework target. */
const clientImportAndRender = (
  framework: Framework,
  component: ManifestComponent,
  outDir: string,
): { importLine?: string; render: string } => {
  // Only framework-component entries have real source to render. dom-region /
  // wp-content entries are served through @freebirdai/embed or the managed
  // backend, so they get a passthrough render placeholder.
  if (component.kind !== "framework-component" || !component.source.file) {
    return { render: "(props) => props as never" };
  }
  const bind = identFor(component.id);
  const spec = relativeImport(outDir, component.source.file);
  const exportName = component.source.exportName;
  const importLine = exportName
    ? `import { ${exportName} as ${bind} } from ${lit(spec)};`
    : `import ${bind} from ${lit(spec)};`;
  const render =
    framework === "vue"
      ? `(props) => h(${bind}, props as Record<string, unknown>)`
      : `(props) => createElement(${bind}, props as Record<string, unknown>)`;
  return { importLine, render };
};

const registerBlock = (component: ManifestComponent, extra: string): string => {
  const tags = component.tags ?? [];
  const knowledge = component.knowledge ?? [];
  const lines = [
    `  registry.register({`,
    `    id: FREEBIRD_IDS.${identFor(component.id)},`,
    `    title: ${lit(component.title)},`,
    `    description: ${lit(component.description)},`,
    `    tags: ${lit(tags)},`,
    ...(knowledge.length
      ? [`    knowledge: ${lit(knowledge.map(normalizeKnowledgeItem))},`]
      : []),
    `    grid: ${gridLiteral(component)},`,
    extra,
    `  });`,
  ];
  return lines.filter(Boolean).join("\n");
};

const generateIdsFile = (manifest: RegistrationManifest): string => {
  const entries = canonicalIds(manifest)
    .map((id) => `  ${identFor(id)}: ${lit(id)},`)
    .join("\n");
  return `${BANNER}
/**
 * Canonical FreeBird component ids — the single source of truth imported by
 * both the client and server registries. \`freebird check\` validates every
 * registry against this map.
 */
export const FREEBIRD_IDS = {
${entries}
} as const;

export type FreeBirdComponentId =
  (typeof FREEBIRD_IDS)[keyof typeof FREEBIRD_IDS];

export const ALL_FREEBIRD_IDS = Object.values(FREEBIRD_IDS);
`;
};

const generateClientRegistry = (
  manifest: RegistrationManifest,
  framework: Framework,
  outDir: string,
): string => {
  const renderImport =
    framework === "vue"
      ? `import { h, type VNode } from "vue";`
      : `import { createElement, type ReactNode } from "react";`;
  const renderType = framework === "vue" ? "VNode" : "ReactNode";
  const importLines: string[] = [];
  const blocks: string[] = [];
  for (const c of manifest.components) {
    const { importLine, render } = clientImportAndRender(framework, c, outDir);
    if (importLine) importLines.push(importLine);
    blocks.push(registerBlock(c, `    render: ${render},`));
  }
  return `${BANNER}
${renderImport}
import { createComponentRegistry } from "@freebirdai/core";
import { FREEBIRD_IDS } from "./ids.js";
${importLines.join("\n")}

/** Client-side registry: metadata + render functions the UI mounts. */
export const clientRegistry = createComponentRegistry<${renderType}>();

${blocks.join("\n\n")}
`;
};

const generateServerRegistry = (manifest: RegistrationManifest): string => {
  const blocks = manifest.components.map((c) =>
    registerBlock(
      c,
      `    // TODO: return real data for digests / LLM context.\n` +
        `    dataSource: async () => ({}),`,
    ),
  );
  return `${BANNER}
import { createComponentRegistry } from "@freebirdai/core";
import { FREEBIRD_IDS } from "./ids.js";

/**
 * Server-side registry: same ids as the client, plus \`dataSource\` and (where
 * you add them) \`actions\`. Wire your action handlers onto these entries.
 */
export const serverRegistry = createComponentRegistry();

${blocks.join("\n\n")}
`;
};

const generateNextRoute = (opts: CodegenOptions): string =>
  `${BANNER}
import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";
import { createMemoryDb } from "@freebirdai/core/testing";
import { serverRegistry } from "${relativeImport("app/freebird/[...route]", `${opts.outDir ?? DEFAULT_OUT_DIR}/server-registry.ts`)}";

// Swap createMemoryDb() for @freebirdai/adapters-db-postgres in production.
const handlers = createFreeBirdRouteHandlers({
  db: createMemoryDb(),
  llm: createOpenAiAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  registry: serverRegistry,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
`;

const generateExpressMount = (opts: CodegenOptions): string =>
  `${BANNER}
import express from "express";
import { createFreeBirdRouter } from "@freebirdai/server/express";
import { createOpenAiAdapter } from "@freebirdai/adapters-llm-openai";
import { createMemoryDb } from "@freebirdai/core/testing";
import { serverRegistry } from "./server-registry.js";

// Swap createMemoryDb() for @freebirdai/adapters-db-postgres in production.
export const mountFreeBird = (app: express.Express): void => {
  app.use(express.json());
  app.use(
    "${opts.transportBaseUrl ?? "/freebird"}",
    createFreeBirdRouter({
      db: createMemoryDb(),
      llm: createOpenAiAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
      registry: serverRegistry,
    }),
  );
};
`;

/**
 * Generate every FreeBird integration file + wiring steps for a manifest.
 * Pure — returns strings and steps; never touches disk.
 */
export const generateIntegration = (
  manifest: RegistrationManifest,
  options: CodegenOptions,
): CodegenResult => {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const warnings: string[] = [];
  const files: GeneratedFile[] = [];

  if (options.framework === "static") {
    // Static sites don't get generated registry files — they register
    // declaratively via @freebirdai/embed. Everything is a wiring step.
    return {
      files: [],
      steps: buildIntegrationSteps(manifest, options),
      ids: canonicalIds(manifest),
      warnings: [
        "framework=static: no registry files generated; use @freebirdai/embed with data-freebird-* attributes.",
      ],
    };
  }

  for (const c of manifest.components) {
    if (c.kind !== "framework-component") {
      warnings.push(
        `component "${c.id}" is a ${c.kind}; generated a passthrough render — supply a real component or serve it via @freebirdai/embed.`,
      );
    }
  }

  files.push({ path: `${outDir}/ids.ts`, contents: generateIdsFile(manifest) });
  files.push({
    path: `${outDir}/server-registry.ts`,
    contents: generateServerRegistry(manifest),
  });
  const clientExt = options.framework === "vue" ? "ts" : "tsx";
  files.push({
    path: `${outDir}/client-registry.${clientExt}`,
    contents: generateClientRegistry(manifest, options.framework, outDir),
  });

  if (options.framework === "next") {
    files.push({
      path: "app/freebird/[...route]/route.ts",
      contents: generateNextRoute(options),
    });
  } else {
    files.push({
      path: `${outDir}/server.ts`,
      contents: generateExpressMount(options),
    });
  }

  return {
    files,
    steps: buildIntegrationSteps(manifest, options),
    ids: canonicalIds(manifest),
    warnings,
  };
};
