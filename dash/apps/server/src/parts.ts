import { COMPONENT_CONTRACTS, PRESENTATION_DEFAULTS } from "@freebirdai/dash-spec";
import { FileLayer, MemoryLayer, type Part, PartRegistry } from "@freebirdai/dash-parts";
import { join } from "node:path";

/**
 * The parts this build ships.
 *
 * Component contracts are seeded from code rather than duplicated as files, so
 * there is exactly one definition of what a `bar` chart requires. Publishing
 * them as parts is what lets one be overridden without editing the product:
 * the override is a whole part in a higher layer, and the default underneath
 * is untouched.
 */
const builtinParts = (): Part[] => [
  ...Object.values(COMPONENT_CONTRACTS).map(
    (contract): Part => ({
      kind: "component",
      id: contract.id,
      title: contract.title,
      description: contract.description,
      form: "data",
      data: { contract },
    }),
  ),
  /*
   * The shipped look, published the same way as the contracts.
   *
   * Seeding these rather than burying the defaults in a renderer is what makes
   * "customised" answerable: the user layer holds an override only when
   * somebody actually changed something, so `revert` is a delete and the parts
   * list can honestly say which components are still stock.
   */
  ...Object.entries(PRESENTATION_DEFAULTS).map(
    ([id, presentation]): Part => ({
      kind: "presentation",
      id,
      title: COMPONENT_CONTRACTS[id as keyof typeof COMPONENT_CONTRACTS]?.title ?? "Widget frame",
      description: `How the ${id} component is drawn.`,
      form: "data",
      data: presentation,
    }),
  ),
];

export interface PartsOptions {
  /** Instance state, gitignored. The user layer. */
  readonly stateDir: string;
  /** Committed, shared by everyone working on this dashboard. The project layer. */
  readonly projectDir: string;
  /**
   * Whether code parts may be supplied.
   *
   * True when self-hosting: it is the operator's own machine and their own
   * code. A hosted deployment sets this false — running one tenant's
   * JavaScript for another needs a sandbox designed for it, and the registry
   * falls back to the shipped default rather than pretending.
   */
  readonly allowCode?: boolean;
}

export const buildPartRegistry = (options: PartsOptions): PartRegistry =>
  new PartRegistry(
    [
      new MemoryLayer("builtin", builtinParts()),
      new FileLayer("project", options.projectDir),
      new FileLayer("user", join(options.stateDir, "parts")),
    ],
    { allowCode: options.allowCode ?? true },
  );
