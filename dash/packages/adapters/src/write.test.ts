import type { ConnectionSpec } from "@freebirdai/dash-spec";
import { connectionSchema } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import { RestAdapter, type HttpFetch } from "./rest.js";
import { AdapterError, type WriteRequest } from "./types.js";

/**
 * Sending a change: once, to the right address, with the same credential a
 * read would carry, and with an honest account of what happened when it
 * does not go through.
 */

interface Sent {
  url: string;
  method: string | undefined;
  body: string | undefined;
  headers: Record<string, string>;
}

const transport = (
  answer: { status?: number; body?: unknown; headers?: Record<string, string> } | Error,
): { http: HttpFetch; sent: Sent[] } => {
  const sent: Sent[] = [];
  const http: HttpFetch = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (answer instanceof Error) throw answer;
    return {
      status: answer.status ?? 200,
      text: answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      url,
      header: (name) => answer.headers?.[name.toLowerCase()] ?? null,
    };
  };
  return { http, sent };
};

const connection = (overrides: Record<string, unknown> = {}): ConnectionSpec =>
  connectionSchema.parse({
    id: "api",
    title: "Demo API",
    kind: "rest",
    baseUrl: "https://api.example.com/v1",
    auth: { type: "headers", parts: [{ header: "x-client-id", keyRef: "id" }, { header: "x-client-secret", keyRef: "secret" }] },
    ...overrides,
  });

const request = (overrides: Partial<WriteRequest> = {}): WriteRequest => ({
  op: {
    id: "update",
    title: "Update a property",
    method: "PUT",
    path: "/rentals/{{param.propertyId}}",
    query: {},
    headers: {},
  },
  params: { propertyId: "42" },
  body: { Name: "Maple Court", Address: { PostalCode: "12345" } },
  ...overrides,
});

const secrets = { id: "client-abc", secret: "s3cret-value" } as Record<string, string>;
const ctx = { now: 0, resolveSecret: async (ref: string) => secrets[ref] ?? null };

describe("RestAdapter.write", () => {
  it("sends the method, the JSON body and the read's own credential", async () => {
    const { http, sent } = transport({ status: 200, body: { Id: 42, Name: "Maple Court" } });
    const result = await new RestAdapter(http).write(connection(), request(), ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://api.example.com/v1/rentals/42",
      method: "PUT",
      body: JSON.stringify({ Name: "Maple Court", Address: { PostalCode: "12345" } }),
    });
    expect(sent[0]?.headers).toMatchObject({
      "x-client-id": "client-abc",
      "x-client-secret": "s3cret-value",
      "content-type": "application/json",
    });
    expect(result).toMatchObject({ status: 200, body: { Id: 42 } });
  });

  it("encodes path values, so an id cannot become two segments", async () => {
    const { http, sent } = transport({ status: 204 });
    await new RestAdapter(http).write(connection(), request({ params: { propertyId: "a/b c" } }), ctx);
    expect(sent[0]?.url).toBe("https://api.example.com/v1/rentals/a%2Fb%20c");
  });

  it("sends no body with a DELETE and reads an empty answer as nothing", async () => {
    const { http, sent } = transport({ status: 204 });
    const result = await new RestAdapter(http).write(
      connection(),
      request({ op: { ...request().op, method: "DELETE" }, body: { ignored: true } }),
      ctx,
    );
    expect(sent[0]?.body).toBeUndefined();
    expect(sent[0]?.headers["content-type"]).toBeUndefined();
    expect(result.body).toBeNull();
  });

  it("keeps where a create says the new record is", async () => {
    const { http } = transport({ status: 201, headers: { location: "https://api.example.com/v1/rentals/77" } });
    const result = await new RestAdapter(http).write(connection(), request(), ctx);
    expect(result.location).toBe("https://api.example.com/v1/rentals/77");
  });

  it("refuses to send with a path value missing, and says nothing was sent", async () => {
    const { http, sent } = transport({ status: 200 });
    const error = await new RestAdapter(http)
      .write(connection(), request({ params: {} }), ctx)
      .catch((caught: unknown) => caught);
    expect(sent).toHaveLength(0);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).outcome).toBe("not-sent");
  });

  it("carries the API's reason for a refusal, with no secret in it", async () => {
    const { http } = transport({
      status: 422,
      body: { errors: [{ key: "PostalCode", message: "is invalid" }], echo: "s3cret-value" },
    });
    const error = (await new RestAdapter(http).write(connection(), request(), ctx).catch((e: unknown) => e)) as AdapterError;
    expect(error.upstreamStatus).toBe(422);
    expect(error.detail).toContain("PostalCode");
    expect(error.detail).not.toContain("s3cret-value");
    expect(error.outcome).toBeUndefined();
  });

  it("never follows a redirect, and does not claim to know what happened", async () => {
    const { http, sent } = transport({ status: 303, headers: { location: "/elsewhere" } });
    const error = (await new RestAdapter(http).write(connection(), request(), ctx).catch((e: unknown) => e)) as AdapterError;
    expect(sent).toHaveLength(1);
    expect(error).toMatchObject({ upstreamStatus: 303, outcome: "unknown" });
  });

  it("tells a request that never left apart from one whose answer was lost", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { notSent: true });
    const a = (await new RestAdapter(transport(refused).http).write(connection(), request(), ctx).catch((e: unknown) => e)) as AdapterError;
    expect(a.outcome).toBe("not-sent");

    const timedOut = new Error("The operation was aborted");
    const b = (await new RestAdapter(transport(timedOut).http).write(connection(), request(), ctx).catch((e: unknown) => e)) as AdapterError;
    expect(b.outcome).toBe("unknown");
    expect(b.userMessage).toMatch(/may or may not have been made/);
  });

  it("refuses an address nobody has confirmed", async () => {
    const { http, sent } = transport({ status: 200 });
    const error = await new RestAdapter(http)
      .write(connection({ addressPending: true }), request(), ctx)
      .catch((caught: unknown) => caught);
    expect(sent).toHaveLength(0);
    expect((error as AdapterError).outcome).toBe("not-sent");
  });
});

describe("reads keep their shape", () => {
  it("still sends a GET with no body, and reports the upstream status of a failure", async () => {
    const { http, sent } = transport({ status: 404, body: { message: "none" } });
    const conn = connection({ ops: [{ id: "listing", title: "Listing", path: "/units/{{param.unitId}}/listing", archetype: "summary" }] });
    const { getOp } = await import("@freebirdai/dash-spec");
    const op = getOp(conn, "listing")!;
    const error = (await new RestAdapter(http)
      .fetch(conn, op, {}, {
        now: 0,
        params: { range: { start: 0, end: 1, grain: "1d" }, filters: { unitId: "5" } } as never,
        resolveSecret: ctx.resolveSecret,
      })
      .catch((e: unknown) => e)) as AdapterError;
    expect(sent[0]?.method).toBeUndefined();
    expect(sent[0]?.body).toBeUndefined();
    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBe(404);
  });
});
