// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { RegistrationManifest } from "@freebirdai/manifest";
import { captureSnapshots, snapshotComponent } from "./snapshot.js";

describe("snapshots", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section id="hours">
        <h2>Hours</h2>
        <span data-freebird-field="monday">9-17</span>
        <script>console.log("ignore me")</script>
      </section>
      <form id="book">
        <input data-freebird-field="guests" name="guests" value="2" />
      </form>
    `;
  });

  it("extracts text without scripts and reads declared fields", () => {
    const snap = snapshotComponent("openingHours", document.querySelector("#hours")!);
    expect(snap.componentId).toBe("openingHours");
    expect(snap.text).toContain("Hours");
    expect(snap.text).toContain("9-17");
    expect(snap.text).not.toContain("ignore me");
    expect(snap.fields).toEqual({ monday: "9-17" });
  });

  it("reads form control values as field snapshots", () => {
    const snap = snapshotComponent("bookingForm", document.querySelector("#book")!);
    expect(snap.fields).toEqual({ guests: "2" });
  });

  it("captures all present manifest components and skips absent ones", () => {
    const manifest: RegistrationManifest = {
      version: 1,
      components: [
        { id: "openingHours", title: "Hours", description: "d", kind: "dom-region", source: { selector: "#hours" } },
        { id: "bookingForm", title: "Book", description: "d", kind: "dom-region", source: { selector: "#book" } },
        { id: "gone", title: "Gone", description: "d", kind: "dom-region", source: { selector: "#nope" } },
      ],
    };
    const snaps = captureSnapshots(manifest, document);
    expect(snaps.map((s) => s.componentId).sort()).toEqual(["bookingForm", "openingHours"]);
  });
});
