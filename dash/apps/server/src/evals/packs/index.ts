import type { ScenarioInput } from "@freebirdai/dash-spec";
import { OUTBOUND_PACK } from "./outbound.js";

/** The scenario packs shipped with Dash, by name. Packs saved from a workspace's own tasks come later. */
export const PACKS: Readonly<Record<string, readonly ScenarioInput[]>> = {
  outbound: OUTBOUND_PACK,
};

export { OUTBOUND_PACK };
