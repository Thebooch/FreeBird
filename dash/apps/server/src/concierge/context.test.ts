import type { CatalogEntry, ConnectionSpec } from "@freebirdai/dash-spec";
import { catalogEntrySchema, connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { buildConciergeContext } from "./context.js";

/**
 * The shape that made "clicking a property shows no units" so hard to see.
 *
 * Units are a top-level collection — `/v1/rentals/units`, not
 * `/v1/rentals/{id}/units` — so nothing about the URL says a property has any.
 * What says so is that a unit row carries a `PropertyId`, and that relation is
 * recorded on the *unit* pointing at the property: backwards from the
 * direction a record needs.
 *
 * The units endpoint declares a `propertyids` filter, which is the difference
 * between one request and reading every unit in the account to find three.
 */
const connection: ConnectionSpec = connectionSchema.parse({
  id: "pm",
  title: "Property API",
  kind: "rest",
  baseUrl: "https://api.example.com",
  ops: [
    { id: "list_rentals", title: "Retrieve all properties", path: "/v1/rentals" },
    { id: "list_units", title: "Retrieve all units", path: "/v1/rentals/units" },
  ],
});

const map: CatalogEntry = catalogEntrySchema.parse({
  id: "pm",
  title: "Property API",
  baseUrl: "https://api.example.com",
  dialect: { auth: { type: "none" } },
  ops: [
    {
      id: "list_rentals",
      title: "Retrieve all properties",
      path: "/v1/rentals",
      params: [{ name: "rentalids", in: "query" }],
      fields: [
        { name: "Id", kinds: ["number"] },
        { name: "Name", kinds: ["string"] },
      ],
    },
    {
      id: "list_units",
      title: "Retrieve all units",
      path: "/v1/rentals/units",
      params: [{ name: "propertyids", in: "query" }],
      fields: [
        { name: "Id", kinds: ["number"] },
        { name: "PropertyId", kinds: ["number"] },
      ],
    },
  ],
  resources: [
    { id: "rental", title: "Retrieve all properties", listOp: "list_rentals" },
    {
      id: "unit",
      title: "Retrieve all units",
      listOp: "list_units",
      relations: [
        {
          id: "unit-rental",
          title: "A unit belongs to a property.",
          resource: "rental",
          cardinality: "one",
          localField: "PropertyId",
          foreignField: "Id",
          via: "fanOut",
          op: "list_rentals",
          /*
           * A parameter on the *target's* endpoint, which is what this field
           * means. Read backwards it would be sent to the units endpoint,
           * which does not declare it — so it must not be the one used.
           */
          filterParam: "rentalids",
          confidence: "inferred",
        },
      ],
    },
  ],
});

const context = buildConciergeContext({ connections: [connection], reports: [], maps: [map] });

const unitsUnderProperty = context.children.filter((child) => child.op === "list_units");

describe("child collections read out of the map", () => {
  it("turns a backwards relation into a section under the parent", () => {
    expect(unitsUnderProperty).toHaveLength(1);
    expect(unitsUnderProperty[0]).toMatchObject({
      parentOp: "list_rentals",
      op: "list_units",
    });
  });

  it("narrows the request with the child endpoint's own filter parameter", () => {
    // Not `rentalids`: that one is declared on the parent's endpoint, and an
    // API answers 200 to a parameter it does not know — putting every unit in
    // the account under every property while looking entirely healthy.
    expect(unitsUnderProperty[0]?.param).toBe("propertyids");
  });

  it("does not also match on the rows once the request itself is narrowed", () => {
    // Two ways of saying the same thing, and carrying both invites them to
    // disagree. The endpoint returned this property's units; filtering them
    // again on a field is work with nothing to remove.
    expect(unitsUnderProperty[0]?.linkField).toBeUndefined();
  });

  it("offers each child once when the connection has never been read", () => {
    const ids = context.children.map((child) => child.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a relation pointing back at a scoped endpoint", () => {
  /**
   * `/v1/tasks/{taskId}/notes` reached backwards from a note that carries a
   * `TaskId`. It reads as a collection under a task, and it cannot be fetched
   * that way: the URL still has a slot in it, so the request goes out with the
   * placeholder unresolved.
   *
   * The right route to those notes is the relation the URL itself declares,
   * which the map records separately and which supplies the id.
   */
  const scoped = buildConciergeContext({
    connections: [
      connectionSchema.parse({
        id: "pm",
        title: "Property API",
        kind: "rest",
        baseUrl: "https://api.example.com",
        ops: [
          { id: "list_tasks", title: "Retrieve all tasks", path: "/v1/tasks" },
          {
            id: "task_notes",
            title: "Retrieve all notes",
            path: "/v1/tasks/{{param.taskId}}/notes",
          },
        ],
      }),
    ],
    reports: [],
    maps: [
      catalogEntrySchema.parse({
        id: "pm",
        title: "Property API",
        baseUrl: "https://api.example.com",
        dialect: { auth: { type: "none" } },
        ops: [
          { id: "list_tasks", title: "Retrieve all tasks", path: "/v1/tasks", fields: [{ name: "Id", kinds: ["number"] }] },
          {
            id: "task_notes",
            title: "Retrieve all notes",
            path: "/v1/tasks/{{param.taskId}}/notes",
            fields: [{ name: "TaskId", kinds: ["number"] }],
          },
        ],
        resources: [
          { id: "task", title: "Task", listOp: "list_tasks" },
          {
            id: "note",
            title: "Note",
            listOp: "task_notes",
            relations: [
              {
                id: "note-task",
                title: "Task",
                resource: "task",
                cardinality: "one",
                localField: "TaskId",
                foreignField: "Id",
                confidence: "inferred",
              },
            ],
          },
        ],
      }),
    ],
  });

  it("is not offered, because the request could not be built", () => {
    expect(scoped.children).toEqual([]);
  });
});
