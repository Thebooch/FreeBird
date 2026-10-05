import type { ConnectorKit } from "@freebirdai/connect/integrate/connector";
import { MemoryConnectorTokens } from "@freebirdai/connect/connector/host";
import { QuickJsSandbox } from "@freebirdai/connect-sandbox";

/** One sandbox for every scenario: each run inside it is a fresh interpreter anyway. */
const sandbox = new QuickJsSandbox();
/* Never the same twice in a process, as real randomness would not be: a value one run made up is not another's. */
let seed = 0;

/**
 * Running connector code in the benchmark: the real sandbox, tokens kept for
 * this scenario only, and a simulated clock that a wait moves forward instead
 * of waiting — an export that takes a minute to prepare takes no time here,
 * and the same run gives the same answers.
 */
export const benchConnectors = (start: number): ConnectorKit => {
  let clock = start;
  return {
    sandbox,
    tokens: new MemoryConnectorTokens(),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    seed: () => ++seed,
  };
};
