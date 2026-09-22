// @vitest-environment happy-dom
import { createElement, act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionSchema,
  dashboardSchema,
  integrationOnboardingSchema,
} from "@freebirdai/dash-spec";
import type { OnboardingStatus } from "@freebirdai/dash-spec";
import { api } from "./api.js";
import { ConnectionOnboarding } from "./ConnectionOnboarding.js";

vi.mock("@freebirdai/dash-react", () => ({
  Dashboard: ({ dashboard }: { dashboard: { title: string } }) =>
    createElement("div", { "data-testid": "dashboard-preview" }, dashboard.title),
}));
let element: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onSkip = vi.fn();
const connection = {
  ...connectionSchema.parse({ id: "account", title: "Buildium", kind: "rest" }),
  hasKey: true,
};
const template = integrationOnboardingSchema.parse({
  version: 1,
  fingerprint: "fixture",
  revision: "v1-fixture",
  purpose: "Property management",
  categoryQuestion: "Which areas?",
  organizationQuestion: "How many tabs?",
  categories: [
    { id: "leasing", title: "Leasing", description: "Leases", opIds: ["leases"], status: "ready" },
    {
      id: "maintenance",
      title: "Maintenance",
      description: "Repairs",
      opIds: ["tasks"],
      status: "ready",
    },
  ],
});
const initial: OnboardingStatus = { template, state: null, stale: false, canPrepare: true };
const preview = {
  id: "preview",
  fingerprint: "fixture",
  dashboards: [dashboardSchema.parse({ id: "board", title: "Buildium" })],
  verification: [],
};
const flush = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
};
const button = (text: string) =>
  [...element.querySelectorAll("button")].find((one) => one.textContent === text)!;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  vi.spyOn(api, "onboarding").mockResolvedValue(initial);
  vi.spyOn(api, "prepareOnboarding").mockResolvedValue(initial);
  vi.spyOn(api, "chooseOnboarding").mockResolvedValue(initial);
  vi.spyOn(api, "previewOnboarding").mockResolvedValue(preview);
  vi.spyOn(api, "commitOnboarding").mockResolvedValue({ dashboardIds: ["board"] });
  vi.spyOn(api, "skipOnboarding").mockResolvedValue(initial);
  vi.spyOn(api, "restartOnboarding").mockResolvedValue(initial);
  onOpen.mockReset();
  onSkip.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.restoreAllMocks();
});
const mount = async () => {
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(ConnectionOnboarding, { connection, onOpen, onSkip }),
      ),
    ),
  );
  await flush();
};

describe("connection onboarding UI", () => {
  it("selects categories, chooses separate tabs, previews and opens the created board", async () => {
    await mount();
    expect(api.prepareOnboarding).not.toHaveBeenCalled();
    for (const checkbox of element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      await act(async () => checkbox.click());
    const separate = element.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!;
    await act(async () => separate.click());
    await act(async () => button("Preview dashboards").click());
    await flush();
    expect(api.chooseOnboarding).toHaveBeenCalledWith("account", {
      categoryIds: ["leasing", "maintenance"],
      organization: "separate",
    });
    expect(element.querySelector('[data-testid="dashboard-preview"]')?.textContent).toBe(
      "Buildium",
    );
    await act(async () => button("Create dashboards").click());
    await flush();
    expect(onOpen).toHaveBeenCalledWith("board");
  });
  it("resumes saved choices and offers the already created dashboards", async () => {
    vi.mocked(api.onboarding).mockResolvedValue({
      ...initial,
      state: {
        status: "complete",
        choices: { categoryIds: ["leasing"], organization: "combined" },
        preview,
        dashboardIds: ["board"],
      },
    });
    await mount();
    await act(async () => button("Open Buildium").click());
    expect(onOpen).toHaveBeenCalledWith("board");
    expect(api.prepareOnboarding).not.toHaveBeenCalled();
    expect(button("Create another set")).toBeDefined();
  });
  it("shows access failures, prevents an empty creation, and allows skipping", async () => {
    vi.mocked(api.previewOnboarding).mockResolvedValue({
      ...preview,
      dashboards: [],
      verification: [
        {
          categoryId: "leasing",
          widgetId: "w",
          title: "Lease list",
          status: "denied",
          message: "No access.",
        },
      ],
    });
    await mount();
    await act(async () =>
      element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await act(async () => button("Preview dashboards").click());
    await flush();
    expect(element.textContent).toContain("No access.");
    expect(button("Create dashboards").disabled).toBe(true);
    await act(async () => button("Skip for now").click());
    expect(onSkip).toHaveBeenCalled();
  });
});
