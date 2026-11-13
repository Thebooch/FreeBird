import { TELNYX_PROVIDER_ID, TelnyxSimulator } from "@freebirdai/adapters-phone-telnyx";
import type { SandboxCarrierFactory } from "./phone-world.js";

/**
 * Telnyx's simulator as a sandbox's carrier: the same packs and Gate A tests
 * run through Telnyx's own adapter (its API shapes, its Ed25519-signed
 * webhooks), so a pack that passes on the fake carrier and fails here is a
 * leak in the provider contract.
 */
export const telnyxSandboxCarrier: SandboxCarrierFactory = ({ now, numbers }) => {
  const telnyx = new TelnyxSimulator({ now, numbers, businessName: "Sandbox carrier" });
  return {
    provider: TELNYX_PROVIDER_ID,
    open: telnyx.open,
    keys: telnyx.keys,
    sent: telnyx.sent,
    calls: telnyx.calls,
    placer: telnyx.placer,
    holder: telnyx,
    failDelivery: (to, code) => telnyx.failDelivery(to, code),
    inboundText: (text, url) => telnyx.inboundText(text, url),
    stopReply: (from, to, url) => telnyx.stopReply(from, to, url),
    takeUpdates: () => telnyx.takeUpdates(),
    statusRequest: (update, url) => telnyx.statusRequest(update, url),
  };
};
