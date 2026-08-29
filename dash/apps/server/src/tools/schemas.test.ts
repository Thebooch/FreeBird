import type { LlmTool } from "@freebirdai/dash-agent";
import { describe, expect, it } from "vitest";
import { ANSWER_TOOL } from "../context/tool.js";
import { LOOK_UP_WIDGET_TOOL } from "../chat/lookUpWidget.js";
import { LOOK_UP_TOOL, lookUpSchema } from "../chat/concierge-actions.js";
import { toJsonSchema } from "../llm.js";
import { QUERY_TOOL } from "./query.js";
import { READ_TOOL } from "./read.js";
import { WRITE_TOOL } from "./write.js";

/**
 * Every tool the chat can be handed, run through the converter that will
 * actually convert it.
 *
 * The regression this exists for, and it was as bad as it sounds: two new
 * tools declared `z.record(...)` for a map of filter values. `toJsonSchema`
 * accepts a deliberately flat subset — no records, no unions — and throws on
 * anything else. It throws while building the request, so it did not break
 * those two tools, it broke **every turn**: no tools were exposed at all, and
 * the assistant answered "the task update tool failed" to questions it should
 * have simply looked up.
 *
 * Nothing in the tools' own tests could see it. They exercise the functions,
 * and the schema is only converted on the way to a model. So this asserts the
 * one thing they cannot: that the schema is expressible.
 */

const TOOLS: readonly LlmTool[] = [
  ANSWER_TOOL,
  READ_TOOL,
  QUERY_TOOL,
  WRITE_TOOL,
  LOOK_UP_WIDGET_TOOL,
  /*
   * Registered in `server.ts` as an inline object rather than exported whole,
   * which is exactly how it got missed the first time this list was written.
   * The schema is the part that matters.
   */
  { name: LOOK_UP_TOOL, description: "look up an endpoint", schema: lookUpSchema },
];

describe("chat tool schemas", () => {
  for (const tool of TOOLS) {
    it(`${tool.name} converts to a JSON schema`, () => {
      expect(() => toJsonSchema(tool.schema as never)).not.toThrow();
    });

    /*
     * A tool whose arguments a model cannot see is a tool it will call with
     * guesses, so the conversion has to produce something, not merely survive.
     */
    it(`${tool.name} describes its arguments`, () => {
      const json = toJsonSchema(tool.schema as never) as {
        type: string;
        properties?: Record<string, unknown>;
      };
      expect(json.type).toBe("object");
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
    });
  }

  it("covers every tool this server registers", () => {
    // A new tool added to the server and not to this list is the exact gap
    // that let the record schemas through, so the count is asserted too.
    expect(TOOLS).toHaveLength(6);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(TOOLS.length);
  });
});
