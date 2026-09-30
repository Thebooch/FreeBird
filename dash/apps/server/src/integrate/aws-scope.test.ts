import { connectionSchema, getOp } from "@freebirdai/dash-spec";
import { describe, expect, it } from "vitest";
import type { DocsKnowledge } from "./docs.js";
import type { Attempt } from "./read.js";
import { awsScopeStrategy } from "./strategies.js";

/* Plan, track B: a signature scoped to the wrong region or service, set right from what was said. */

const connection = connectionSchema.parse({
  id: "orders",
  title: "Orders",
  kind: "rest",
  baseUrl: "https://api.orders.example",
  auth: { type: "sigv4", accessKeyRef: "orders-access", keyRef: "orders-key", region: "us-east-1" },
  ops: [{ id: "orders", title: "Orders", path: "/orders" }],
});
const op = getOp(connection, "orders")!;
const docs = (text: string): DocsKnowledge => ({ text: async () => text, spec: async () => null, outline: async () => "" });
const refused = (said: string): Attempt => ({ kind: "forbidden", status: 403, said, message: said });

const propose = (said: string, text = "") =>
  awsScopeStrategy.propose({ connection, op, attempt: refused(said), docs: docs(text) });

describe("an AWS signature's scope", () => {
  it("takes the region and the service the API's refusal names", async () => {
    const region = await propose("The authorization header is malformed; the region 'us-east-1' is wrong; expecting 'eu-west-1'");
    expect(region.map((one) => one.patch.auth)).toEqual([expect.objectContaining({ type: "sigv4", region: "eu-west-1" })]);
    const service = await propose("Credential should be scoped to correct service: 'execute-api'.");
    expect(service.map((one) => one.patch.auth)).toEqual([expect.objectContaining({ service: "execute-api", region: "us-east-1" })]);
  });

  it("tries the regions the documentation names when the refusal names none, and never one nobody stated", async () => {
    const said = "Credential should be scoped to a valid region, not 'us-east-1'.";
    const named = await propose(said, "Our API runs in ap-southeast-2. Sign requests for ap-southeast-2; a mirror is in eu-central-1.");
    expect(named.map((one) => (one.patch.auth as { region?: string }).region)).toEqual(["ap-southeast-2", "eu-central-1"]);
    expect(await propose(said, "Sign each request with your keys.")).toEqual([]);
  });

  it("leaves every other sign-in, and every other refusal, alone", async () => {
    expect(await propose("The security token included in the request is invalid.", "eu-west-1")).toEqual([]);
    const bearer = connectionSchema.parse({ ...connection, auth: { type: "bearer", keyRef: "orders-key" } });
    expect(
      await awsScopeStrategy.propose({ connection: bearer, op, attempt: refused("expecting 'eu-west-1'"), docs: docs("") }),
    ).toEqual([]);
  });
});
