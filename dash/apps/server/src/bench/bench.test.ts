import { describe, expect, it } from "vitest";
import { baselineIntegrator, referenceIntegrator } from "./integrator.js";
import { PROVIDERS } from "./providers/index.js";
import { runSuite } from "./run.js";

/**
 * The benchmark's own mechanics — never its results.
 *
 * What an integrator scores is a measurement, written to `bench/results/`,
 * and deliberately not pinned here: a test asserting today's baseline fails
 * would have to be edited every time the baseline improved. What is pinned
 * is that the measuring instrument is right — every answer key is reachable
 * by a correct configuration, and nothing reaches past the providers.
 */

describe("the benchmark's answer keys", () => {
  /*
   * A hand-configured connection, plus the choice a correct integrator would
   * make, reaches every answer. This checks the keys and the scorer against
   * each other; it is not an integrator's result and is never reported as one.
   */
  it.each(["dev", "heldout"] as const)("are all reachable by a correct configuration (%s)", async (split) => {
    const scores = await runSuite({ split, integrator: referenceIntegrator, scripted: true });
    const withReference = scores.filter(
      (score) => PROVIDERS.find((one) => one.id === score.provider)?.reference,
    );
    expect(withReference.length).toBeGreaterThan(0);
    for (const score of withReference) {
      expect({ scenario: `${score.provider}/${score.objective}`, ...score }).toMatchObject({
        success: true,
        completeness: "complete",
        metric: "correct",
      });
    }
  });

  it("gives every provider a reason to be in the corpus, and an objective", () => {
    for (const provider of PROVIDERS) {
      expect(provider.pattern.length).toBeGreaterThan(10);
      expect(provider.objectives.length).toBeGreaterThan(0);
    }
  });
});

describe("a baseline run", () => {
  it("scores every dev scenario without leaving the benchmark's own hosts", async () => {
    const scores = await runSuite({ split: "dev", integrator: () => baselineIntegrator(), scripted: true });
    const dev = PROVIDERS.filter((one) => one.split === "dev");
    expect(scores).toHaveLength(dev.reduce((sum, one) => sum + one.objectives.length, 0));
    for (const score of scores) expect(score.integrator).toBe("baseline");
  });

  it("never scores a read that stopped short as complete", async () => {
    const scores = await runSuite({ split: "dev", integrator: () => baselineIntegrator(), scripted: true });
    for (const score of scores) {
      if (score.recordsRead !== null && score.recordsRead !== score.records)
        expect(score.completeness).not.toBe("complete");
    }
  });
});
