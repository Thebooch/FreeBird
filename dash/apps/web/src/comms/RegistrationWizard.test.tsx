// @vitest-environment happy-dom
import { registrationDraftSchema, type PhoneLineView, type RegistrationDraftView } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, fakeServer, mount, settle, shown, type, unmountAll, type Call, type FakeServer } from "../testing/screen.js";
import { RegistrationWizard } from "./RegistrationWizard.jsx";

/**
 * The text registration wizard: the only way a carrier registration is
 * submitted, and a rejected one costs a fee and restarts the wait.
 *
 * These open the wizard against a stand-in for the server and hold it to
 * what it sends: nothing is submitted by opening or moving about, the EIN
 * goes its own way and never with the rest, and Submit is one request.
 */

const ROOT = "/api/comms/lines/line-1/registration";
const line = { id: "line-1", title: "Main line", number: "+15125550100" } as unknown as PhoneLineView;

const draft = (over: Record<string, unknown> = {}): RegistrationDraftView =>
  registrationDraftSchema.parse({ line: "line-1", updatedAt: "2026-11-01T00:00:00.000Z", ...over }) as unknown as RegistrationDraftView;

let server: FakeServer;
let onChanged: ReturnType<typeof vi.fn>;
const open = async (routes: Parameters<typeof fakeServer>[0]) => {
  server = fakeServer({ [`GET ${ROOT}/uses`]: { uses: [] }, ...routes });
  onChanged = vi.fn();
  const page = mount(createElement(RegistrationWizard, { line, onClose: () => {}, onChanged }));
  await settle();
  return page.container.ownerDocument.body;
};
const by = <T extends HTMLElement>(page: ParentNode, id: string): T => {
  const found = page.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`nothing on screen with test id ${id}`);
  return found;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const writes = () => server.calls.filter((one) => one.method !== "GET").map((one) => `${one.method} ${one.url}`);

afterEach(() => {
  unmountAll();
  server?.restore();
  document.body.innerHTML = "";
});

describe("the text registration wizard", () => {
  it("opens where the person left off and sends nothing by opening", async () => {
    const page = await open({ [`GET ${ROOT}`]: draft({ step: "contact", contact: { name: "Ada Park" } }) });
    expect(by(page, "reg-step-contact").getAttribute("data-active")).toBe("true");
    expect(by<HTMLInputElement>(page, "reg-name").value).toBe("Ada Park");
    expect(writes()).toEqual([]);
  });

  it("saves what was typed a moment later, and only what changed", async () => {
    const page = await open({
      [`GET ${ROOT}`]: draft(),
      [`PUT ${ROOT}`]: (call: Call) => draft({ business: (call.body as { business: object }).business }),
    });
    await type(by<HTMLInputElement>(page, "reg-legalName"), "Acme Homes LLC");
    expect(writes()).toEqual([]);
    await pause(750);
    await settle();
    expect(server.sent(`PUT ${ROOT}`).map((one) => one.body)).toEqual([{ business: { legalName: "Acme Homes LLC" }, field: "legalName" }]);
    expect(shown(page)).toContain("Saved");
    expect(writes()).toEqual([`PUT ${ROOT}`]);
  });

  it("seals the EIN through its own request, clears the box, and never sends it with the rest", async () => {
    const page = await open({
      [`GET ${ROOT}`]: draft(),
      [`POST ${ROOT}/ein`]: { ...draft(), business: { ...draft().business, ein: "•••••6789" } },
      [`PUT ${ROOT}`]: draft(),
    });
    const box = by<HTMLInputElement>(page, "reg-ein");
    expect(box.type).toBe("password");
    await type(box, "12-3456789");
    /* Typing it saves nothing: only Seal sends it. */
    await pause(750);
    expect(writes()).toEqual([]);

    await click(by(page, "reg-ein-save"));
    await settle();
    expect(server.sent(`POST ${ROOT}/ein`).map((one) => one.body)).toEqual([{ ein: "12-3456789" }]);
    expect(by<HTMLInputElement>(page, "reg-ein").value).toBe("");
    expect(shown(page)).toContain("On file: •••••6789");

    /* A later autosave carries no EIN. */
    await type(by<HTMLInputElement>(page, "reg-city"), "Austin");
    await pause(750);
    await settle();
    const saved = server.sent(`PUT ${ROOT}`);
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved[0]!.body)).not.toContain("3456789");
    expect(saved[0]!.body).toEqual({ business: { city: "Austin" }, field: "city" });
  });

  it("moves between steps without submitting", async () => {
    const page = await open({ [`GET ${ROOT}`]: draft(), [`PUT ${ROOT}`]: (call: Call) => draft({ step: (call.body as { step: string }).step }) });
    await click(by(page, "reg-next"));
    await settle();
    expect(by(page, "reg-step-contact").getAttribute("data-active")).toBe("true");
    expect(server.sent(`PUT ${ROOT}`).map((one) => one.body)).toEqual([{ step: "contact" }]);
    expect(server.sent(`POST ${ROOT}/submit`)).toHaveLength(0);
  });

  it("lists what would fail on the check step, and takes the person to the field to fix", async () => {
    const page = await open({
      [`GET ${ROOT}`]: draft({ step: "check" }),
      [`POST ${ROOT}/check`]: { problems: [{ rule: "legal-name", field: "legalName", step: "business", says: "The legal name is missing." }] },
      [`PUT ${ROOT}`]: (call: Call) => draft({ step: (call.body as { step: string }).step }),
    });
    expect(shown(by(page, "reg-problems"))).toContain("The legal name is missing.");
    expect(server.sent(`POST ${ROOT}/submit`)).toHaveLength(0);

    const fix = [...page.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent?.trim() === "Fix this")!;
    await click(fix);
    await settle();
    expect(by(page, "reg-step-business").getAttribute("data-active")).toBe("true");
    expect(server.sent(`PUT ${ROOT}`).map((one) => one.body)).toEqual([{ step: "business", field: "legalName" }]);
  });

  it("submits once, and tells the page around it", async () => {
    const page = await open({
      [`GET ${ROOT}`]: draft({ step: "check", business: { legalName: "Acme Homes LLC" } }),
      [`POST ${ROOT}/check`]: { problems: [] },
      [`POST ${ROOT}/submit`]: draft({ step: "status", submitted: { brand: { kind: "brand", id: "BN1", provider: "fake" }, brandState: "pending" } }),
    });
    expect(shown(page)).toContain("Every check passes.");
    expect(shown(page)).toContain("“Acme Homes LLC” is the legal name exactly as on the IRS letter");
    await click(by(page, "reg-submit"));
    await settle();
    expect(server.sent(`POST ${ROOT}/submit`)).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(by(page, "reg-step-status").getAttribute("data-active")).toBe("true");
  });

  it("says why a submit was refused, shows the checks again, and reports nothing as changed", async () => {
    let checks = 0;
    const page = await open({
      [`GET ${ROOT}`]: draft({ step: "check" }),
      [`POST ${ROOT}/check`]: () => ({ problems: checks++ === 0 ? [] : [{ rule: "confirm", field: "confirmed", step: "check", says: "Confirm the legal name first." }] }),
      [`POST ${ROOT}/submit`]: { status: 400, body: { error: "Not submitted: 1 check failed." } },
    });
    await click(by(page, "reg-submit"));
    await settle();
    expect(server.sent(`POST ${ROOT}/submit`)).toHaveLength(1);
    expect(shown(page)).toContain("Not submitted: 1 check failed.");
    expect(shown(by(page, "reg-problems"))).toContain("Confirm the legal name first.");
    expect(onChanged).not.toHaveBeenCalled();
    expect(by(page, "reg-step-check").getAttribute("data-active")).toBe("true");
  });

  it("will not submit again while a registration is with the carrier", async () => {
    const page = await open({
      [`GET ${ROOT}`]: draft({ step: "check", submitted: { brand: { kind: "brand", id: "BN1", provider: "fake" }, brandState: "pending" } }),
      [`POST ${ROOT}/check`]: { problems: [] },
    });
    const submit = by<HTMLButtonElement>(page, "reg-submit");
    expect(submit.disabled).toBe(true);
    await click(submit);
    expect(server.sent(`POST ${ROOT}/submit`)).toHaveLength(0);
  });

  it("says so when the draft cannot be read, and offers nothing to fill in", async () => {
    const page = await open({ [`GET ${ROOT}`]: { status: 403, body: { error: "You may not manage this line." } } });
    expect(shown(page)).toContain("You may not manage this line.");
    expect(page.querySelector('[data-testid="reg-submit"]')).toBeNull();
    expect(page.querySelector('[data-testid="reg-legalName"]')).toBeNull();
  });
});
