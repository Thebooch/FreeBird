import type { ScenarioInput } from "@freebirdai/dash-spec";
import { INBOUND_PACK } from "./inbound.js";
import { OUTBOUND_PACK } from "./outbound.js";
import { PHONE_PACK } from "./phone.js";

/** The scenario packs shipped with Dash, by name. Packs saved from a workspace's own tasks come later. */
export const PACKS: Readonly<Record<string, readonly ScenarioInput[]>> = {
  outbound: OUTBOUND_PACK,
  inbound: INBOUND_PACK,
  phone: PHONE_PACK,
};

export { INBOUND_PACK, OUTBOUND_PACK, PHONE_PACK };
