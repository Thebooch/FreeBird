import type { EntityPageView, WriteFormField, WriteReviewView } from "@freebirdai/dash-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntityRecordPage } from "../EntityRecordPage.jsx";
import { RecordForm, changedValues } from "./RecordForm.jsx";
import { WriteReview } from "./WriteReview.jsx";

/**
 * The form and the review, rendered: which input each field gets, what the
 * review says before anybody clicks, and which controls a page offers.
 */

const FIELDS: WriteFormField[] = [
  { field: "Name", label: "Name", type: "string", required: true, readFrom: "Name" },
  { field: "SubType", label: "Sub type", type: "string", required: true, options: ["SingleFamily", "MultiFamily"] },
  { field: "Address", label: "Address", type: "object", required: true },
  { field: "Address.PostalCode", label: "Postal code", type: "string", required: true, readFrom: "Address.PostalCode" },
  { field: "IsManagedExternally", label: "Managed externally", type: "boolean", required: false },
  { field: "AvailableDate", label: "Available", type: "string", format: "date", required: false },
  { field: "BankAccountId", label: "Bank account", type: "integer", required: true, references: "bankaccount", readFrom: "BankAccountId" },
  { field: "ManagerId", label: "Manager", type: "integer", required: false, readFrom: null },
  { field: "Units", label: "Units", type: "array", required: false },
  { field: "Units[].UnitNumber", label: "Unit number", type: "string", required: true },
];

const render = (element: JSX.Element): string => renderToStaticMarkup(element);

describe("RecordForm", () => {
  const html = render(
    createElement(RecordForm, {
      fields: FIELDS,
      values: { Name: "Maple", AvailableDate: "2026-10-01T00:00:00Z", Units: [{ UnitNumber: "1" }] },
      onChange: () => undefined,
      editing: true,
      references: { bankaccount: [{ value: "5", label: "Operating" }] },
      errors: [{ field: "Name", label: "Name", message: "is required" }],
    }),
  );

  it("picks an input from what each field declares", () => {
    expect(html).toMatch(/data-testid="write-field-SubType"[^>]*>|<select[^>]*data-testid="write-field-SubType"/);
    expect(html).toMatch(/Single family/i);
    expect(html).toMatch(/type="checkbox"[^>]*data-testid="write-field-IsManagedExternally"/);
    expect(html).toMatch(/type="date"[^>]*value="2026-10-01"/);
    expect(html).toContain("Operating");
  });

  it("groups nested values, and lists of records item by item", () => {
    expect(html).toContain("<legend>Address</legend>");
    expect(html).toContain('data-testid="write-group-Units"');
    expect(html).not.toContain('data-testid="write-field-Address"');
  });

  it("marks what is required, and says which current values could not be read", () => {
    expect(html).toContain("Name *");
    expect(html).toContain("could not be read");
    expect(html).toContain("is required");
  });

  it("sends only what changed on an edit, and everything given on a create", () => {
    const initial = { Name: "Maple", YearBuilt: 1990, City: "X" };
    expect(changedValues(initial, { Name: "Maple", YearBuilt: "1990", City: null }, false)).toEqual({ City: null });
    expect(changedValues({}, { Name: "New", Empty: "", Gone: null }, true)).toEqual({ Name: "New" });
  });
});

const REVIEW: WriteReviewView = {
  pendingId: "p1",
  digest: "d1",
  connection: "rentals",
  connectionTitle: "Rentals",
  entity: "rental",
  entityName: "Property",
  kind: "update",
  mode: "replace",
  title: "Update a property",
  summary: "Change 1 value on property “Maple” on Rentals.",
  record: "Maple",
  rows: [
    { field: "Name", label: "Name", before: "Maple", after: "Maple East", changed: true },
    { field: "YearBuilt", label: "Year built", before: "1990", after: "1990", changed: false },
  ],
  warnings: ["Not sent: Manager. Their current values could not be read."],
  danger: false,
  unverified: true,
  inferred: false,
  expiresAt: new Date(0).toISOString(),
};

describe("WriteReview", () => {
  it("shows each changed value before and after, and what else is sent as it is", () => {
    const html = render(createElement(WriteReview, { review: REVIEW, onConfirm: () => undefined, onCancel: () => undefined }));
    expect(html).toContain("Maple East");
    expect(html).toContain("1 other value is sent back as it is");
    expect(html).toContain("Not sent: Manager");
    expect(html).toContain("First use");
    expect(html).toContain("Save to Rentals");
  });

  it("will not confirm something that cannot be undone until that is acknowledged", () => {
    const html = render(
      createElement(WriteReview, {
        review: { ...REVIEW, kind: "delete", mode: "delete", danger: true, rows: [] },
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain("Cannot be undone");
    expect(html).toContain("I understand this cannot be undone here.");
    expect(html).toMatch(/<button[^>]*data-testid="write-review-confirm"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="write-review-confirm"/);
    expect(html).toContain("Delete from Rentals");
  });

  it("carries the API's own reason when it refused", () => {
    const html = render(
      createElement(WriteReview, {
        review: REVIEW,
        onConfirm: () => undefined,
        onCancel: () => undefined,
        error: "Rentals returned an error (422).",
        detail: '{"errors":[{"key":"PostalCode"}]}',
      }),
    );
    expect(html).toContain("PostalCode");
  });
});

describe("EntityRecordPage changes", () => {
  const PAGE: EntityPageView = {
    entity: "unit",
    resource: "unit",
    name: { one: "Unit", many: "Units" },
    kind: "asset",
    identity: "Id",
    title: ["UnitNumber"],
    detail: { op: "unit", param: "unitId" },
    fields: [],
    facts: [],
    groups: [],
    sections: [
      {
        id: "listing-under-unit",
        entity: "listing",
        title: "Listings",
        field: "unitId",
        reach: { mode: "path", op: "listing", param: "unitId" },
        cost: "cheap",
        verified: true,
        singleton: true,
        columns: [],
        writes: {
          update: { op: "put_listing", mode: "upsert", title: "Create/Update a listing", confidence: "declared", confirmed: true, verified: false },
          remove: { op: "delete_listing", mode: "delete", title: "Delete a listing", confidence: "declared", confirmed: true, verified: false },
          actions: [],
        },
      },
    ],
    sectionsTotal: 1,
    omitted: [],
    references: [],
    facets: [],
    stats: [],
    writes: {
      update: { op: "put_unit", mode: "replace", title: "Update a unit", confidence: "declared", confirmed: true, verified: false },
      actions: [{ op: "archive", mode: "action", title: "Archive a unit", confidence: "declared", confirmed: true, verified: false, id: "archive", danger: true }],
    },
  } as unknown as EntityPageView;

  const page = (withChanges: boolean) =>
    render(
      createElement(EntityRecordPage, {
        page: PAGE,
        connection: "rentals",
        recordId: "5",
        onBack: () => undefined,
        ...(withChanges ? { onChangeRecord: () => undefined } : {}),
      }),
    );

  it("offers Edit, and the rest behind one menu rather than a button apiece", () => {
    const html = page(true);
    expect(html).toContain('data-testid="record-change-update"');
    // Archiving and the listing's changes make nothing new, so they are under "More", not "Add".
    expect(html).toContain('data-testid="record-more"');
    expect(html).toContain('aria-label="More changes to this unit"');
    expect(html).not.toContain('data-testid="record-add"');
    // One button per change is what this replaced.
    expect(html).not.toContain('data-testid="record-change-action-archive"');
    expect(html).not.toContain('data-testid="section-change-listing-update"');
    expect(page(false)).not.toContain("record-changes");
  });
});
