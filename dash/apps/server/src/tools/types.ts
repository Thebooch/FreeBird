import type { LlmTool } from "@freebirdai/dash-agent";
import type { ParamDef, ResolvedParams } from "@freebirdai/dash-spec";
import type { OpReader } from "../context/types.js";

/**
 * A core tool set for whatever API somebody has connected.
 *
 * Everything the assistant could previously do with an API was read a
 * collection. It could not narrow one before reading, open a single record,
 * follow a reference to another, or write. So a question like "there is a task
 * about water on the side of a house, what are the notes?" found the record in
 * a list row, reported its status, and then said the description "was not
 * included in the available rows" — which was true, and useless. The notes were
 * one request away on the record's own endpoint, and no code path led there.
 *
 * The four verbs below are that path, and there is exactly one implementation
 * of each. Per-API difference is *data* — a binding, derived from what the map
 * already knows — rather than a second copy of the verb.
 *
 * That choice is the one this codebase keeps making and keeps being right
 * about. `Archetype` calls the handful of shapes endpoints come in "code,
 * shared by every API, the part that never needs storing". A `dialect` states
 * one vendor's pagination and date conventions once. `ParamDef.role` already
 * says what an input *does* — search, filter, range, sort, id — independently of
 * what the vendor named it. `AdapterRegistry` keeps transports pluggable by
 * being a lookup rather than a switch, so "the runtime never learns that REST
 * or MCP exist". This is that same move one level up: nothing below learns
 * which API it is talking to.
 *
 * The alternative — a read tool per connection, a write tool per connection —
 * fails in the dimension that has already bitten here. Tool schemas are prompt
 * tokens on every turn, and 135 near-identical ones were once ninety percent of
 * the chat prompt. One `read` with a `resource` argument is one schema whether
 * two APIs are connected or twenty. It also cannot answer the question that
 * spans them: "has anyone mentioned running late?" across every connected
 * source, itemized per source, is a server-side loop over one tool — from N
 * per-API tools it is N round-trips through a loop that summarises after the
 * first, plus correlation done by the model, which is what models do worst.
 */

/**
 * The verbs. Deliberately the ones an MCP server exposes, because that is the
 * vocabulary a tool-using model already has.
 */
export type Verb =
  /**
   * Narrow a collection before reading it — search, filter, range, sort.
   *
   * Listing is the degenerate case rather than a fourth verb: a query with
   * nothing to narrow by *is* a list, down to the same request. Giving it its
   * own tool would put a second way to do one thing in every prompt and leave
   * the model choosing between them.
   */
  | "query"
  /** Open one record whole, by its identifier. */
  | "read"
  /** Change one. Declared and described; nothing can execute it yet. */
  | "write";

/**
 * One verb, bound to one resource on one connection.
 *
 * Derived from the map and never authored. Every field below already exists
 * somewhere in `ConciergeContext` or the resource graph — this only gathers
 * them into the shape a tool needs, so that a tool can be written once against
 * roles and identifiers rather than against an API.
 */
export interface ToolBinding {
  readonly verb: Verb;
  /**
   * What the model names when it wants this.
   *
   * The resource noun — `task`, `conversation`, `charge` — qualified with the
   * connection only when two APIs both have one, the same way widget handles
   * are qualified only on collision. An unqualified name is what somebody
   * would actually type, and qualifying every one of them by default makes the
   * common case read like configuration.
   */
  readonly id: string;
  readonly connection: string;
  /** Human name for the connection, for saying where an answer came from. */
  readonly connectionTitle: string;
  /** The noun, in the API's own vocabulary. */
  readonly resource: string;
  readonly title: string;
  /** The endpoint this verb calls. */
  readonly op: string;
  /** What the records are, in the API's own words where it said. */
  readonly describes: string;

  /* ── read ─────────────────────────────────────────────────────────────── */

  /** The input on `op` that receives the identifier. */
  readonly idParam?: string;
  /**
   * The field on a record that carries its identity.
   *
   * Never assumed to be `Id`. It comes from a sampled response, because a path
   * says `{leaseId}` while the body says `Id` and no specification states the
   * correspondence.
   */
  readonly idField?: string;
  /** The collection endpoint whose rows this opens. */
  readonly listOp?: string;

  /* ── query and list ───────────────────────────────────────────────────── */

  /** Parameter taking free text, when the API declares one. */
  readonly search?: string;
  /** Parameters that narrow by value, carrying their accepted values. */
  readonly filters?: readonly ParamDef[];
  /** Parameters taking a date window. */
  readonly range?: { readonly start: string; readonly end?: string | undefined };
  /** Parameter taking an order. */
  readonly sort?: string;
}

/**
 * A field on one record that supplies an identifier for another.
 *
 * The bridge between "I have this record" and "so I can open that one" —
 * derived from proven links rather than from a field name that looks like a
 * foreign key.
 */
export interface Reference {
  /** The binding that can be read with it. */
  readonly to: ToolBinding;
  /** The field on the held record. */
  readonly field: string;
  /**
   * What that field holds. All three are ordinary and two of them are silent
   * when mishandled: an array never equals an id, and an object stringifies to
   * `[object Object]`, so both look exactly like a record with no link.
   */
  readonly kind: "scalar" | "array" | "objectRef";
  readonly title: string;
}

/** Everything a tool is allowed to touch. */
export interface ToolDeps {
  /**
   * The one guarded way out to an API.
   *
   * `readForChat` on the server: the query cache, request accounting, the
   * connection cooldown, secret resolution and the three-state outcome that
   * keeps a 403's reason intact. No tool fetches any other way, which is what
   * keeps budget honesty in one place rather than in four.
   */
  readonly read: OpReader;
  readonly resolved: ResolvedParams;
  readonly rowsOf: (body: unknown, rowsPath: string) => Record<string, unknown>[];
  readonly rowsPathFor: (op: string) => string;
}

/**
 * What every verb hands back.
 *
 * `note` exists because a lookup nobody asked for and nobody was told about is
 * the kind of cost that turns a useful feature off. Whatever a tool spent, the
 * reply is expected to say it.
 */
export interface ToolResult {
  readonly records: readonly Record<string, unknown>[];
  readonly requests: number;
  /** What was done, in words the reply can use directly. */
  readonly note: string;
  /** Anything that would make the records read as more than they are. */
  readonly warnings: readonly string[];
  /** The API's own reason for refusing, when it did. */
  readonly refused?: string;
}

/** One verb: the schema it presents, and what running it does. */
export interface ApiTool<Args> {
  readonly verb: Verb;
  /** Built from what is actually bound, so an unconnected verb is not offered. */
  describe(bindings: readonly ToolBinding[]): LlmTool;
  run(args: Args, bindings: readonly ToolBinding[], deps: ToolDeps): Promise<ToolResult>;
}
