// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparationJobSchema, type IntegrationActivationReview } from "@freebirdai/dash-spec";
import { api } from "./api.js";
import { IntegrationPreparation } from "./IntegrationPreparation.js";

vi.mock("./api.js", () => ({
  api: {
    preparationStatus: vi.fn(),
    estimatePreparation: vi.fn(),
    preparationJob: vi.fn(),
    approvePreparation: vi.fn(),
    runPreparation: vi.fn(),
    reviewIntegration: vi.fn(),
    activateIntegration: vi.fn(),
  },
}));
describe("preparation approval and recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  const job = preparationJobSchema.parse({
    id: "12345678-1234-4234-8234-123456789abc",
    integration: "service",
    revision: 1,
    state: "awaiting-approval",
    estimate: {
      maxModelUsd: 0,
      maxApiRequests: 12,
      expectedSeconds: 24,
      contractFingerprint: "estimate",
    },
    target: { connection: "account", version: "one", bindingRevision: 1 },
  });
  const review: IntegrationActivationReview = {
    connection: "account",
    currentVersion: "one",
    targetVersion: "two",
    bindingRevision: 1,
    fingerprint: "review",
    alreadyActive: false,
    compatible: true,
    blockers: [],
    relationships: [
      { title: "Assigned vendor", direction: "forward", before: "unverified", after: "verified" },
      {
        title: "Associated tasks",
        direction: "reverse",
        before: "unverified",
        after: "unverified",
      },
    ],
  };
  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(api.preparationStatus).mockResolvedValue({ available: true, jobs: [] });
    vi.mocked(api.estimatePreparation).mockResolvedValue(job);
    vi.mocked(api.reviewIntegration).mockResolvedValue(review);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (onActivated = vi.fn()) => {
    await act(async () =>
      root.render(
        createElement(IntegrationPreparation, {
          connection: "account",
          title: "Sample service",
          onBack: vi.fn(),
          onActivated,
        }),
      ),
    );
    return onActivated;
  };
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };

  it("requires budget approval, runs the approved job and separately reviews activation", async () => {
    const approved = { ...job, revision: 2, state: "queued" as const };
    const finished = {
      ...job,
      revision: 4,
      state: "complete" as const,
      resultVersion: "two",
      completed: ["owner:forward"],
    };
    vi.mocked(api.approvePreparation).mockResolvedValue(approved);
    vi.mocked(api.runPreparation).mockResolvedValue(finished);
    vi.mocked(api.activateIntegration).mockResolvedValue({ ...review, alreadyActive: true });
    const activated = await render();
    expect(api.estimatePreparation).not.toHaveBeenCalled();
    await click("Estimate checks");
    expect(container.textContent).toContain("12 API reads");
    expect(api.runPreparation).not.toHaveBeenCalled();
    expect(api.activateIntegration).not.toHaveBeenCalled();
    await click("Approve budget and check links");
    expect(api.approvePreparation).toHaveBeenCalledWith(job);
    expect(api.runPreparation).toHaveBeenCalledWith(approved);
    expect(container.textContent).toContain("Assigned vendor: Available");
    expect(container.textContent).toContain("Associated tasks: Not yet confirmed");
    expect(api.activateIntegration).not.toHaveBeenCalled();
    await click("Use verified links");
    expect(api.activateIntegration).toHaveBeenCalledWith(job.id, review);
    expect(activated).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("results are active");
  });

  it("resumes a stored approved job without approving another budget", async () => {
    const paused = {
      ...job,
      revision: 6,
      state: "paused" as const,
      reservedApiRequests: 2,
      completed: ["owner:forward"],
    };
    vi.mocked(api.preparationStatus).mockResolvedValue({ available: true, jobs: [paused] });
    vi.mocked(api.runPreparation).mockResolvedValue({
      ...paused,
      revision: 7,
      state: "complete",
      resultVersion: "two",
    });
    await render();
    expect(container.textContent).toContain("2 of 12");
    await click("Resume approved checks");
    expect(api.runPreparation).toHaveBeenCalledWith(paused);
    expect(api.approvePreparation).not.toHaveBeenCalled();
    expect(api.estimatePreparation).not.toHaveBeenCalled();
  });

  it("does not offer activation for incompatible changes", async () => {
    vi.mocked(api.preparationStatus).mockResolvedValue({
      available: true,
      jobs: [{ ...job, state: "complete", resultVersion: "two" }],
    });
    vi.mocked(api.reviewIntegration).mockResolvedValue({
      ...review,
      compatible: false,
      blockers: ["A migration review is required."],
    });
    await render();
    expect(container.textContent).toContain("migration review is required");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Use verified links",
      ),
    ).toBe(false);
    expect(api.activateIntegration).not.toHaveBeenCalled();
  });
});
