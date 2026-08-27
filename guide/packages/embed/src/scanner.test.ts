// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { safeParseManifest } from "@freebirdai/manifest";
import { scanDocument } from "./scanner.js";

describe("scanDocument", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("turns data-freebird-* elements into a valid dom-region manifest", () => {
    document.body.innerHTML = `
      <section id="hours"
               data-freebird-component="openingHours"
               data-freebird-title="Opening hours"
               data-freebird-description="Weekly opening hours"
               data-freebird-tags="hours, contact">
        <span data-freebird-field="monday" data-freebird-field-description="Monday hours">9-17</span>
      </section>
      <form data-freebird-component="bookingForm">
        <input name="guests" />
      </form>
    `;
    const manifest = scanDocument(document, "fb_site1");
    expect(safeParseManifest(manifest).success).toBe(true);
    expect(manifest.siteId).toBe("fb_site1");
    expect(manifest.components.map((c) => c.id).sort()).toEqual([
      "bookingForm",
      "openingHours",
    ]);

    const hours = manifest.components.find((c) => c.id === "openingHours")!;
    expect(hours.title).toBe("Opening hours");
    expect(hours.tags).toEqual(["hours", "contact"]);
    expect(hours.source.selector).toBe("#hours");
    expect(hours.fields).toEqual([
      { name: "monday", selector: '[data-freebird-field="monday"]', description: "Monday hours" },
    ]);

    // No id/title/description on the form → derived defaults, still valid.
    const booking = manifest.components.find((c) => c.id === "bookingForm")!;
    expect(booking.title).toBe("Booking Form");
    expect(booking.description).toContain("Booking Form");
    expect(booking.source.selector).toBe('[data-freebird-component="bookingForm"]');
  });

  it("skips duplicate ids and keeps the first", () => {
    document.body.innerHTML = `
      <div id="a" data-freebird-component="dup" data-freebird-description="first"></div>
      <div id="b" data-freebird-component="dup" data-freebird-description="second"></div>
    `;
    const manifest = scanDocument();
    expect(manifest.components).toHaveLength(1);
    expect(manifest.components[0]!.source.selector).toBe("#a");
  });

  it("returns an empty manifest when nothing is registered", () => {
    document.body.innerHTML = `<div>plain content</div>`;
    const manifest = scanDocument();
    expect(manifest.components).toHaveLength(0);
    expect(safeParseManifest(manifest).success).toBe(true);
  });
});
