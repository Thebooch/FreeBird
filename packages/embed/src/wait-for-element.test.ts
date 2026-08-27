// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { waitForElement } from "./wait-for-element.js";

describe("waitForElement", () => {
  it("returns immediately when the selector already matches", async () => {
    document.body.innerHTML = '<div id="target">hello</div>';
    const el = await waitForElement(document, "#target", 100);
    expect(el?.id).toBe("target");
  });

  it("resolves when the element appears later", async () => {
    document.body.innerHTML = "";
    const promise = waitForElement(document, "#late", 500);
    setTimeout(() => {
      document.body.innerHTML = '<div id="late">ready</div>';
    }, 60);
    const el = await promise;
    expect(el?.id).toBe("late");
  });

  it("returns null after the timeout when the element never appears", async () => {
    document.body.innerHTML = "";
    const el = await waitForElement(document, "#missing", 80);
    expect(el).toBeNull();
  });
});
