// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionSchema, dashboardSchema } from "@freebirdai/dash-spec";
import { api, type OnboardingState } from "./api.js";
import { ConnectionOnboarding } from "./ConnectionOnboarding.js";

/**
 * The setup screen, driven the way somebody would drive it.
 *
 * The server is mocked at the `api` boundary: what is being pinned here is
 * that the screen resumes wherever setup was left, never spends anything
 * without a click, and creates exactly the preview it showed.
 */

vi.mock("@freebirdai/dash-react", () => ({
  Dashboard: ({ dashboard }: { dashboard: { title: string } }) =>
    createElement("div", { "data-testid": "dashboard-preview" }, dashboard.title),
}));

let element: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onDone = vi.fn();
const onChanged = vi.fn();

const connection = {
  ...connectionSchema.parse({ id: "acme", title: "Acme", kind: "rest", catalog: "acme" }),
  hasKey: true,
};

const STATE = {
  divided: true,
  stale: false,
  categories: 2,
  composed: 2,
  pending: 0,
  empty: 0,
  failed: 0,
  starters: 4,
  entities: 2,
  rhythm: true,
  remaining: 0,
  categoriesAt: null,
  canRun: true,
};

const offer = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "ready" as const,
  recordTypes: 1,
  endpoints: 1,
  widgets: 2,
  opensWith: ["Open work", "Tasks"],
  available: true,
  ...extra,
});

const status = (input: Partial<OnboardingState> = {}): OnboardingState => ({
  connection: "acme",
  title: "Acme",
  catalog: "acme",
  profile: { summary: "Property management software." },
  state: STATE,
  categories: [offer("maintenance", "Maintenance"), offer("leasing", "Leasing")],
  setup: { status: "pending", dashboards: [], notes: [] },
  boards: [],
  ...input,
});

const previewed = (boards = [dashboardSchema.parse({ id: "maintenance", title: "Maintenance", widgets: [] })]) =>
  status({
    setup: {
      status: "preview",
      choices: { categories: ["maintenance", "leasing"], layout: "per-category" },
      preview: {
        id: "p1",
        boards: boards.map((board) => ({ board })),
        checks: [
          {
            category: "leasing",
            widget: "leases",
            title: "Leases",
            status: "denied",
            message: "This account is not allowed to read these records.",
          },
        ],
        notes: [],
      },
      dashboards: [],
      notes: [],
    },
  });

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
};

const button = (text: string): HTMLButtonElement =>
  [...element.querySelectorAll("button")].find((one) => one.textContent?.trim() === text)!;

const mount = async (): Promise<void> => {
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(ConnectionOnboarding, { connection, onOpen, onDone, onChanged }),
      ),
    ),
  );
  await flush();
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  vi.spyOn(api, "onboarding").mockResolvedValue(status());
  vi.spyOn(api, "prepareOnboarding").mockResolvedValue({
    ...status(),
    step: { step: "none", ok: true, skipped: [], proposed: 0, kept: 0 },
  });
  vi.spyOn(api, "chooseOnboarding").mockResolvedValue(status());
  vi.spyOn(api, "previewOnboarding").mockResolvedValue(previewed());
  vi.spyOn(api, "commitOnboarding").mockResolvedValue({
    ...status({
      setup: { status: "complete", dashboards: ["maintenance"], notes: [] },
      boards: [{ dashboard: "maintenance", title: "Maintenance", widgets: 3 }],
    }),
    created: [{ dashboard: "maintenance", title: "Maintenance", widgets: 3 }],
  });
  vi.spyOn(api, "skipOnboarding").mockResolvedValue(status({ setup: { status: "skipped", dashboards: [], notes: [] } }));
  vi.spyOn(api, "restartOnboarding").mockResolvedValue(status());
  onOpen.mockReset();
  onDone.mockReset();
  onChanged.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.restoreAllMocks();
});

describe("ConnectionOnboarding", () => {
  it("ticks the top parts, previews what would be made, and creates exactly that", async () => {
    await mount();
    const ticked = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
      (box) => box.checked,
    );
    expect(ticked).toEqual([true, true]);

    await act(async () => element.querySelector<HTMLInputElement>('[data-testid="layout-per-category"]')!.click());
    await act(async () => button("Preview").click());
    await flush();
    expect(api.chooseOnboarding).toHaveBeenCalledWith("acme", {
      categories: ["maintenance", "leasing"],
      layout: "per-category",
    });
    expect(element.querySelector('[data-testid="dashboard-preview"]')?.textContent).toBe(
      "Maintenance",
    );
    /* What was left off, and why, before anything is made. */
    expect(element.textContent).toContain("Leases is left off: This account is not allowed");

    await act(async () => button("Make my dashboard").click());
    await flush();
    expect(api.commitOnboarding).toHaveBeenCalledWith("acme", "p1");
    expect(onChanged).toHaveBeenCalled();
    await act(async () => button("Open Maintenance (3 widgets)").click());
    expect(onOpen).toHaveBeenCalledWith("maintenance");
  });

  /* Preparing spends model tokens, so starting it is a click. */
  it("does not start preparing an API nobody has divided without being asked", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(
      status({ state: { ...STATE, divided: false, categories: 0, remaining: 2 }, categories: [] }),
    );
    await mount();
    expect(api.prepareOnboarding).not.toHaveBeenCalled();
    expect(element.querySelector('[data-testid="onboarding-gate"]')).not.toBeNull();
  });

  /* Once begun, closing the screen half way comes back to it finishing. */
  it("carries on preparing an API it had started on", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(status({ state: { ...STATE, pending: 1, remaining: 1 } }));
    await mount();
    expect(api.prepareOnboarding).toHaveBeenCalledTimes(1);
  });

  it("stops at a step that failed and offers to try again", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(status({ state: { ...STATE, pending: 1, remaining: 1 } }));
    vi.mocked(api.prepareOnboarding).mockResolvedValue({
      ...status({ state: { ...STATE, failed: 1, remaining: 1 } }),
      step: { step: "composed", ok: false, error: "Leasing: the model answered without calling the tool.", skipped: [], proposed: 0, kept: 0 },
    });
    await mount();
    expect(api.prepareOnboarding).toHaveBeenCalledTimes(1);
    expect(element.textContent).toContain("Leasing: the model answered without calling the tool.");
    expect(button("Try again")).toBeDefined();
  });

  it("resumes the choices it saved", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(
      status({
        setup: {
          status: "choosing",
          choices: { categories: ["leasing"], layout: "per-category" },
          dashboards: [],
          notes: [],
        },
      }),
    );
    await mount();
    const ticked = [...element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
      (box) => box.checked,
    );
    expect(ticked).toEqual([false, true]);
  });

  it("offers to finish a create that was cut off", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(
      status({ setup: { ...previewed().setup, status: "creating", dashboards: ["maintenance"] } }),
    );
    await mount();
    await act(async () => button("Finish creating them").click());
    await flush();
    expect(api.commitOnboarding).toHaveBeenCalledWith("acme", "p1");
  });

  it("offers another set once set up, and makes nothing while asking", async () => {
    vi.mocked(api.onboarding).mockResolvedValue(
      status({
        setup: { status: "complete", dashboards: ["maintenance"], notes: [] },
        boards: [{ dashboard: "maintenance", title: "Maintenance", widgets: 3 }],
      }),
    );
    await mount();
    await act(async () => button("Create another set").click());
    await flush();
    expect(api.restartOnboarding).toHaveBeenCalledWith("acme");
    expect(api.commitOnboarding).not.toHaveBeenCalled();
  });

  it("lets somebody skip, and says so to the server", async () => {
    await mount();
    await act(async () => button("Skip for now").click());
    await flush();
    expect(api.skipOnboarding).toHaveBeenCalledWith("acme");
    expect(onDone).toHaveBeenCalled();
  });
});
