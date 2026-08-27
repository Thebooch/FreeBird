import type { RegistrationManifest } from "@freebirdai/manifest";
import type { CodegenOptions, IntegrationStep } from "./types.js";

/**
 * The wiring that codegen can't do deterministically because it edits existing
 * app files. The CLI prints these; FreeBird Studio hands them to the edit
 * engine. `automatable` steps are safe append-only operations.
 */
export const buildIntegrationSteps = (
  manifest: RegistrationManifest,
  options: CodegenOptions,
): IntegrationStep[] => {
  const outDir = options.outDir ?? "src/freebird";
  const base = options.transportBaseUrl ?? "/freebird";

  if (options.framework === "static") {
    return [
      {
        id: "add-embed-script",
        title: "Add the FreeBird embed script",
        detail: `Add <script src="https://cdn.freebird.dev/v1/freebird.js" data-site-id="<your-site-id>" data-api="<your-api>" defer></script> to your site's <head>.`,
        automatable: false,
        targetHint: "index.html",
      },
      {
        id: "annotate-components",
        title: "Annotate components with data-freebird-* attributes",
        detail:
          "For each component in the manifest, add data-freebird-component/-title/-description to the matching element so the assistant can find it.",
        automatable: false,
      },
    ];
  }

  const installDeps: IntegrationStep = {
    id: "install-deps",
    title: "Install FreeBird packages",
    detail:
      options.framework === "vue"
        ? "Add @freebirdai/core, @freebirdai/core-state, @freebirdai/vue, @freebirdai/server, and an LLM adapter (@freebirdai/adapters-llm-openai)."
        : "Add @freebirdai/core, @freebirdai/core-state, @freebirdai/react, @freebirdai/server, and an LLM adapter (@freebirdai/adapters-llm-openai).",
    automatable: false,
    targetHint: "package.json",
  };

  const mountChat: IntegrationStep =
    options.framework === "vue"
      ? {
          id: "install-vue-plugin",
          title: "Install the FreeBird Vue plugin and mount the chat panel",
          detail: `In main.ts: app.use(FreeBirdPlugin, { registry: clientRegistry, transportOptions: { baseUrl: "${base}" } }). Render <ChatPanelRoot> somewhere that stays mounted for the app's lifetime.`,
          automatable: false,
          targetHint: "src/main.ts",
        }
      : {
          id: "wrap-provider",
          title: "Wrap the app in FreeBirdProvider and mount the chat panel",
          detail: `Wrap your root in <FreeBirdProvider registry={clientRegistry}> and render <ChatPanel /> where it stays mounted. Point transport at "${base}".`,
          automatable: false,
          targetHint: options.framework === "next" ? "app/layout.tsx" : "src/main.tsx",
        };

  const importRegistries: IntegrationStep = {
    id: "import-registries",
    title: "Import the generated registries",
    detail: `Client code imports { clientRegistry } from "${outDir}/client-registry"; server code imports { serverRegistry } from "${outDir}/server-registry". Both draw ids from ${outDir}/ids.`,
    automatable: true,
    targetHint: outDir,
  };

  const wireServer: IntegrationStep =
    options.framework === "next"
      ? {
          id: "verify-route",
          title: "Confirm the FreeBird route handler is mounted",
          detail:
            "The generated app/freebird/[...route]/route.ts mounts the server. Set OPENAI_API_KEY and swap createMemoryDb() for a real DB adapter in production.",
          automatable: false,
          targetHint: "app/freebird/[...route]/route.ts",
        }
      : {
          id: "call-mount",
          title: "Call mountFreeBird(app) in your server entry",
          detail: `Import { mountFreeBird } from "${outDir}/server" and call it with your Express app. Set OPENAI_API_KEY.`,
          automatable: false,
          targetHint: "server entry (e.g. server/index.ts)",
        };

  const drift: IntegrationStep = {
    id: "add-check-script",
    title: "Add a registry drift check",
    detail:
      'Add "freebird:check": "freebird check" to package.json scripts and run it in CI to catch client/server id drift.',
    automatable: true,
    targetHint: "package.json",
  };

  const hasActions = manifest.components.some((c) => (c.actions ?? []).length > 0);
  const steps = [installDeps, importRegistries, mountChat, wireServer, drift];
  if (hasActions) {
    steps.push({
      id: "implement-actions",
      title: "Implement server action handlers",
      detail:
        "The manifest declares actions. Add their handlers to the entries in server-registry.ts (schema, authorize, handler, requiresConfirmation).",
      automatable: false,
      targetHint: `${outDir}/server-registry.ts`,
    });
  }
  return steps;
};
