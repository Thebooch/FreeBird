import type { MappedField, RelationSpec, ResourceSpec } from "@freebirdai/dash-spec";
import {
  commonPathPrefix,
  pathParamNames,
  pathSegments,
  resolveSameNoun,
  singularNoun,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * Understanding an API once, so nobody has to understand it again.
 *
 * An import gives paths, params and response shapes. What it cannot give is
 * *meaning*: which of two hundred endpoints titled "Retrieve all X" is the one
 * somebody meant, and which of them relate to each other through fields whose
 * names share no vocabulary. This is the pass that adds those two things, and
 * it is the only expensive part of mapping an API — the schemas themselves
 * come out of the spec for nothing.
 *
 * It runs **once per API, ever**, and the result is shareable: nothing here
 * touches an account's data, so a map made on one install is true on every
 * other. That is what lets a new user arrive with only their keys.
 *
 * Two rules keep it honest. It never overwrites the API author's own words —
 * a description is written only where the spec supplied none. And every
 * relation it invents is marked `inferred`, because a name match is a guess
 * however plausible, and the vocabulary for saying so already exists.
 */

/** How many resources go into one call. Keeps a single prompt readable. */
const BATCH = 25;

const mapProposalSchema = z.object({
  descriptions: z
    .array(
      z.object({
        op: z.string().describe("Endpoint id, exactly as given."),
        description: z
          .string()
          .describe("One sentence saying what this endpoint returns. No marketing, no hedging."),
      }),
    )
    .optional(),
  relations: z
    .array(
      z.object({
        from: z.string().describe("Resource id whose rows carry the link."),
        to: z.string().describe("Resource id on the other end."),
        localField: z
          .string()
          .describe("Field on the `from` rows holding the other one's identity."),
        foreignField: z.string().describe("Field on the `to` rows that it matches."),
        title: z
          .string()
          .describe("How to describe this link in a sentence, e.g. \"A lease is for a property.\"")
          .optional(),
        reason: z
          .string()
          .describe(
            "Why you believe this link, in one sentence. What made the two fields the " +
              "same value — the naming, the section of the API both sides live in, a " +
              "convention this API follows. Somebody who disagrees should be able to say so.",
          )
          .optional(),
      }),
    )
    .optional(),
});

export type MapProposal = z.infer<typeof mapProposalSchema>;

const mapTool: LlmTool<MapProposal> = {
  name: "describe_api",
  description:
    "Describe endpoints that have no description, and report relationships between resources " +
    "that the URL structure does not already show.",
  schema: mapProposalSchema,
};

export const MAP_SYSTEM_PROMPT = `You are reading an API's endpoint list so that other people never have to.

Two jobs, and nothing else.

1. DESCRIPTIONS. Some endpoints have no description. Write one sentence for each
   of those saying what its rows are. Say what the thing IS, in the API's own
   domain language, so somebody choosing between two similarly-named endpoints
   can tell them apart. Use the path — it usually says more than the title.
   Do NOT describe endpoints that already have a description.

2. RELATIONSHIPS. You are shown resources whose URLs already prove a parent and
   child. Report only the links those URLs do NOT show: a field on one
   resource's rows that holds another resource's identity. Name the field on
   each side exactly as it appears in the field lists.

   localField is on the "from" rows and holds the other resource's identity.
   foreignField is on the "to" rows and is what it matches — normally that
   resource's own id.

   Give a reason for every link. It is stored and shown to the next person who
   uses this API, so write what actually convinced you rather than restating
   the link.

Rules:
- Only use ids and field names that appear below. Anything else is discarded.
- A relationship is a claim about data. If two fields merely have similar names
  but plainly mean different things, leave it out. A missing link costs one
  question; a wrong one produces a widget that is confidently wrong.
- A number that is not an id is not a link. Codes, reference numbers, amounts
  and counts share the look of a foreign key and none of them point anywhere.
  A field is a link only if its value IS a record's identity somewhere else.
- Fields marked (list) hold several ids and fields marked (object) hold a
  nested record. Both are ordinary foreign keys and worth reporting; name them
  exactly as shown and the shape is handled downstream.
- Say nothing about what makes a good chart. That is not this job.`;

export interface MapInput {
  readonly apiTitle: string;
  readonly resources: readonly ResourceSpec[];
  /** Every endpoint, keyed by op id. */
  readonly ops: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly path: string;
    readonly description?: string | undefined;
    readonly fields?: readonly MappedField[] | undefined;
  }>;
}

/** How many field names each endpoint contributes to the prompt. */
const FIELDS_SHOWN = 14;

/**
 * One batch of resources, rendered for the model.
 *
 * Field names are included but truncated: the model needs enough to spot that
 * `lease.PropertyId` and `property.Id` are the same value, not the whole
 * schema. The whole schema comes later, for the two endpoints a widget
 * actually uses.
 */
export const buildMapPrompt = (input: MapInput, resources: readonly ResourceSpec[]): string => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  const lines: string[] = [`API: ${input.apiTitle}`, ""];

  /*
   * Every collection in the API, as a link target.
   *
   * Batching describes twenty-five resources in detail per call, and until
   * this existed the model could only relate the ones it happened to be shown
   * together. That is not a mild limitation — it silently biases every answer
   * toward whatever shares a batch. Buildium's rental units carry a
   * `PropertyId`; `rental` sat in batch 0 and `unit-2` in batch 1, so the only
   * property-shaped thing in view was `propertygroup`, and that is the link
   * that got recorded. Clicking a property then showed no units, because
   * according to the map it had none.
   *
   * Cheap enough to include whole: an id and a noun each, a few kilobytes for
   * a large API, on a pass that runs once ever.
   */
  if (input.resources.length > 0) {
    lines.push("ALL COLLECTIONS IN THIS API — you may link to any of these, not only the ones");
    lines.push("described below. Use the id exactly as written.");
    for (const resource of input.resources) {
      const listTitle = resource.listOp ? opById.get(resource.listOp)?.title : undefined;
      const nouns = [
        ...new Set([
          nounOf(resource, opById),
          titleNoun(listTitle ?? resource.title),
          titleNoun(resource.title),
        ]),
      ].filter(Boolean);
      lines.push(`  ${resource.id} — ${listTitle ?? resource.title}${nouns.length > 0 ? ` (${nouns.join(", ")})` : ""}`);
    }
    lines.push("");
  }

  for (const resource of resources) {
    lines.push(`RESOURCE ${resource.id} — ${resource.title}`);
    /*
     * What one of its records is called, which is not always what the URL
     * calls the collection. Buildium lists properties at `/v1/rentals` and
     * titles it "Retrieve all properties", so a `PropertyId` on another
     * record matches nothing about the path — and the nearest thing that
     * *does* look right is `propertygroup`, which is a different concept
     * entirely. Stating the noun outright is what stops that.
     */
    const listTitle = resource.listOp ? opById.get(resource.listOp)?.title : undefined;
    const nouns = [
      ...new Set([
        nounOf(resource, opById),
        titleNoun(listTitle ?? resource.title),
        titleNoun(resource.title),
      ]),
    ].filter(Boolean);
    if (nouns.length > 0) lines.push(`  its records are called: ${nouns.join(", ")}`);
    if (resource.idField) lines.push(`  identity: ${resource.idField}`);

    /*
     * Name the other resources this one could be confused with.
     *
     * Batching hides them otherwise: twenty-five resources go into a call, so
     * a model can name "the units" in perfect good faith having never been
     * shown that a second units collection exists in another batch. The rivals
     * are drawn from the whole API rather than the batch for exactly that
     * reason, and they are named here because being able to choose correctly
     * is better than being refused afterwards.
     */
    const rivals = input.resources.filter(
      (other) =>
        other.id !== resource.id && nounOf(other, opById) === nounOf(resource, opById),
    );
    if (rivals.length > 0) {
      lines.push(
        `  CAUTION — ${rivals.length + 1} different "${nounOf(resource, opById)}" collections ` +
          "exist in this API and they hold different records. The others are: " +
          rivals
            .map((rival) => `${rival.id} (${pathOf(rival, opById) ?? "no path"})`)
            .join(", ") +
          ". Only link to this one if the path says these records belong together; if you " +
          "cannot tell, do not propose the link at all.",
      );
    }

    const known = new Set(resource.relations.map((relation) => relation.resource));
    if (known.size > 0) {
      lines.push(`  already linked (do not repeat): ${[...known].join(", ")}`);
    }

    for (const opId of [resource.listOp, resource.detailOp]) {
      const op = opId ? opById.get(opId) : undefined;
      if (!op) continue;
      lines.push(`  endpoint ${op.id}  ${op.path}`);
      lines.push(`    title: ${op.title}`);
      lines.push(
        op.description ? `    description: ${op.description} [HAS ONE]` : "    description: MISSING",
      );
      /*
       * Field names, with the non-scalar ones marked.
       *
       * `PropertyIds` and `PropertyId` are one character apart and behave
       * nothing alike: the first holds a list. `Property` holds an object with
       * the id one level in. Both read as perfectly good foreign keys and both
       * match nothing when compared as scalars, so the shape is stated where
       * it is not `string` or `number` — the two that need no comment.
       */
      const declared = op.fields ?? [];
      if (declared.length > 0) {
        const shown = declared
          .slice(0, FIELDS_SHOWN)
          .map((field) => {
            const shape = field.kinds.includes("array")
              ? " (list)"
              : field.kinds.includes("object")
                ? " (object)"
                : "";
            return `${field.name}${shape}`;
          })
          .join(", ");
        const more = declared.length - Math.min(declared.length, FIELDS_SHOWN);
        lines.push(`    fields: ${shown}${more > 0 ? `, +${more} more` : ""}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
};

export interface MapResult {
  /** op id → the description the model wrote, for ops that had none. */
  readonly descriptions: Readonly<Record<string, string>>;
  /** Additional relations, all marked `inferred`. Keyed by source resource id. */
  readonly relations: Readonly<Record<string, RelationSpec[]>>;
  /** Batches that failed, so a partial map can say what it is missing. */
  readonly errors: readonly string[];
  /**
   * Links the model proposed that were refused, and why.
   *
   * Separate from `errors` because nothing went wrong: the pass worked and
   * declined to record a guess it could not justify. Surfaced rather than
   * dropped so a missing link is explainable — "the API has two units
   * collections" is an answer; silence is not.
   */
  readonly skipped: readonly string[];
}

/**
 * Run the pass, batch by batch.
 *
 * Batches fail independently on purpose. A map that covers ninety per cent of
 * an API is worth keeping and worth re-running for the rest; one that throws
 * away a completed pass because the last call timed out is not.
 */
export const mapApi = async (
  llm: LlmAdapter,
  input: MapInput,
  options: { model?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<MapResult> => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  /*
   * What every path in *this* API shares, so it can be discounted. Read from
   * the API rather than assumed to be a version segment: some are unversioned,
   * some are mounted under `/api/v2`, and a rule that hardcodes one shape is a
   * rule about one vendor's URLs.
   */
  const mountDepth = commonPathPrefix(input.ops.map((op) => op.path));
  const resourceIds = new Set(input.resources.map((resource) => resource.id));
  const descriptions: Record<string, string> = {};
  const relations: Record<string, RelationSpec[]> = {};
  const errors: string[] = [];
  const skipped: string[] = [];

  for (let start = 0; start < input.resources.length; start += BATCH) {
    const batch = input.resources.slice(start, start + BATCH);
    try {
      const result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0.2,
        maxOutputTokens: 4096,
        messages: [
          { role: "system" as const, content: MAP_SYSTEM_PROMPT },
          { role: "user" as const, content: buildMapPrompt(input, batch) },
        ],
        tools: { describe_api: mapTool },
        toolChoice: { name: "describe_api" as const },
      });

      const call = result.toolCalls.find((candidate) => candidate.name === "describe_api");
      let parsed: ReturnType<typeof mapProposalSchema.safeParse> | null = call
        ? mapProposalSchema.safeParse(call.args)
        : null;

      /*
       * One malformed entry must not cost the batch.
       *
       * The proposal is a list, and a list validated as a unit is all-or-
       * nothing: a single relation missing a field discarded twenty-five
       * resources' worth of correct ones. That is not hypothetical — it
       * happened on the first run of this pass, twice, because the model
       * folded `title` into `reason` and answered with only the second.
       *
       * So a failed parse is retried entry by entry. Every surviving entry
       * still goes through the same validation below; nothing is being let
       * through, only salvaged.
       */
      if (call && parsed && !parsed.success) {
        const args = call.args as { descriptions?: unknown; relations?: unknown };
        const salvage = <T>(list: unknown, schema: z.ZodType<T>): T[] =>
          Array.isArray(list)
            ? list.flatMap((entry) => {
                const one = schema.safeParse(entry);
                return one.success ? [one.data] : [];
              })
            : [];

        const descriptions = salvage(args.descriptions, mapProposalSchema.shape.descriptions.unwrap().element);
        const relations = salvage(args.relations, mapProposalSchema.shape.relations.unwrap().element);
        if (descriptions.length > 0 || relations.length > 0) {
          parsed = { success: true, data: { descriptions, relations } };
          const lost =
            (Array.isArray(args.descriptions) ? args.descriptions.length - descriptions.length : 0) +
            (Array.isArray(args.relations) ? args.relations.length - relations.length : 0);
          if (lost > 0) {
            skipped.push(
              `resources ${start + 1}–${start + batch.length}: ${lost} proposal(s) were malformed and dropped; the rest of the batch was kept.`,
            );
          }
        }
      }

      if (!parsed?.success) {
        const detail = parsed
          ? parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : "the model called no tool";
        errors.push(
          `resources ${start + 1}–${start + batch.length}: the model's answer did not parse (${detail})`,
        );
        continue;
      }

      for (const entry of parsed.data.descriptions ?? []) {
        const op = opById.get(entry.op);
        // Never over an author's own words, and never for an op that does not
        // exist — the same guard every other model boundary here applies.
        if (!op || op.description) continue;
        const text = entry.description.trim();
        if (text) descriptions[entry.op] = text.slice(0, 400);
      }

      for (const entry of parsed.data.relations ?? []) {
        if (!resourceIds.has(entry.from) || !resourceIds.has(entry.to)) continue;
        if (entry.from === entry.to) continue;

        const source = input.resources.find((resource) => resource.id === entry.from)!;
        const target = input.resources.find((resource) => resource.id === entry.to)!;
        // Already known from the URL, which is stronger than any guess.
        if (source.relations.some((relation) => relation.resource === entry.to)) continue;

        const localOk = fieldsOf(source, opById).includes(entry.localField);
        const foreignOk = fieldsOf(target, opById).includes(entry.foreignField);
        if (!localOk || !foreignOk) continue;

        /*
         * Is this the only resource by that name, and if not, is it the right
         * one? The model is shown twenty-five resources at a time, so it can
         * name a "unit" in perfect good faith without ever having been shown
         * the other units collection in a different batch. The check has to
         * happen against the whole API, here, rather than being left to a
         * prompt that cannot see far enough to get it right.
         *
         * Verified live: this is what recorded leases, applicants and
         * applicant groups as linking to `/v1/associations/units` — the HOA
         * module — when every one of them is a rentals-domain record.
         */
        const rivals = input.resources.filter(
          (resource) =>
            nounOf(resource, opById) === nounOf(target, opById) && isBareCollection(resource, opById),
        );
        if (isBareCollection(target, opById) && rivals.length > 1) {
          const winner = resolveSameNoun(
            rivals.map((resource) => ({ resource, path: pathOf(resource, opById) })),
            pathOf(source, opById),
            mountDepth,
          );
          if (winner?.resource.id !== target.id) {
            skipped.push(
              `${source.title} → ${target.title}: the API has ${rivals.length} different ` +
                `${nounOf(target, opById)} collections and nothing says which one ` +
                `${entry.localField} points at, so no link was recorded.`,
            );
            continue;
          }
        }

        /*
         * What the two fields actually hold, read from the schemas.
         *
         * A link whose local field is an object with no id inside it cannot be
         * honoured by anything downstream — the comparison is against
         * `[object Object]` and is false for every row — so it is refused here
         * rather than stored and silently rendered as an empty section. The
         * array and nested-id cases are both real foreign keys and are kept,
         * with the shape recorded so the right comparison is used later.
         */
        const local = linkKindOf(declaredFieldsOf(source, opById), entry.localField);
        const foreign = linkKindOf(declaredFieldsOf(target, opById), entry.foreignField);
        if (!local || !foreign) {
          skipped.push(
            `${source.title} → ${target.title}: ${!local ? entry.localField : entry.foreignField} ` +
              "is an object with no id inside it, so there is nothing to match on.",
          );
          continue;
        }

        (relations[entry.from] ??= []).push({
          id: `${entry.from}-${entry.to}`.slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "-"),
          /*
           * The target's own title where the model gave none. A link with no
           * name is still a link, and every consumer already falls back this
           * way — requiring one only meant losing the relation entirely.
           */
          title: (entry.title ?? target.title).slice(0, 120),
          resource: entry.to,
          cardinality: "one",
          /*
           * The resolved names, so a link that had to reach one level into an
           * object stores the field that can actually be compared rather than
           * the one the model named.
           */
          localField: local.field,
          foreignField: foreign.field,
          linkKind: local.kind,
          ...(entry.reason ? { notes: entry.reason.slice(0, 400) } : {}),
          ...(target.listOp ? { op: target.listOp } : {}),
          /*
           * `fanOut` until something proves otherwise.
           *
           * Whether the target's collection can be filtered by this key is a
           * property of its declared parameters, which the caller checks — not
           * something to take the model's word for, because getting it wrong
           * turns one request into twenty-five.
           */
          via: "fanOut",
          // A name match is a guess however plausible, and the schema has a
          // word for that. `verified` stays false until a join matches rows.
          confidence: "inferred",
          verified: false,
        });
      }
    } catch (caught) {
      errors.push(
        `resources ${start + 1}–${start + batch.length}: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  return { descriptions, relations, errors, skipped };
};

/**
 * Remove stored links that the ambiguity rule would no longer allow.
 *
 * The correcting half of a re-map, and it has to exist separately from simply
 * re-running the pass. Merging can add a link but never retract one, so a
 * relation recorded wrongly is permanent: the fixed pass declines to propose
 * it again and the bad one sits in the entry unchallenged. That is precisely
 * how `leases → /v1/associations/units` would have survived its own fix.
 *
 * Discarding every inference instead is worse in a different way. The pass is
 * a model and a model is not deterministic, so a clean slate loses whatever
 * good links this run happens not to repeat — measured at 44 down to 24 on
 * Buildium, taking `lease → rental` with it, which was never in doubt.
 *
 * So this drops exactly what is now known to be unjustifiable and keeps
 * everything else. What the URL declared and what a request verified are never
 * touched: neither came from a guess.
 */
export const pruneAmbiguousRelations = (
  input: MapInput,
): { resources: ResourceSpec[]; removed: string[] } => {
  const opById = new Map(input.ops.map((op) => [op.id, op]));
  const mountDepth = commonPathPrefix(input.ops.map((op) => op.path));
  const byId = new Map(input.resources.map((resource) => [resource.id, resource]));
  const removed: string[] = [];

  const resources = input.resources.map((source) => {
    const kept = source.relations.filter((relation) => {
      if (relation.confidence === "declared" || relation.verified) return true;

      const target = byId.get(relation.resource);
      if (!target || !isBareCollection(target, opById)) return true;

      const rivals = input.resources.filter(
        (resource) =>
          nounOf(resource, opById) === nounOf(target, opById) && isBareCollection(resource, opById),
      );
      if (rivals.length < 2) return true;

      const winner = resolveSameNoun(
        rivals.map((resource) => ({ resource, path: pathOf(resource, opById) })),
        pathOf(source, opById),
        mountDepth,
      );
      if (winner?.resource.id === target.id) return true;

      removed.push(
        `${source.title} → ${target.title}: ${rivals.length} different ` +
          `${nounOf(target, opById)} collections exist and nothing says which one this meant.`,
      );
      return false;
    });

    return kept.length === source.relations.length ? source : { ...source, relations: kept };
  });

  return { resources, removed };
};

/** The collection path a resource lists at, where it has one. */
const pathOf = (
  resource: ResourceSpec,
  opById: ReadonlyMap<string, { path?: string | undefined }>,
): string | undefined => (resource.listOp ? opById.get(resource.listOp)?.path : undefined);

/**
 * The noun in a collection's title — "Retrieve all properties" → "property".
 *
 * Often the only place the API's own vocabulary appears. A path is a route and
 * a title is a description, and when they disagree the title is the one that
 * matches the field names other records use.
 */
const titleNoun = (title: string): string => {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !["retrieve", "get", "all", "the", "a", "an", "list"].includes(word));
  if (words.length === 0) return "";

  /*
   * The whole phrase, not its last word. "Retrieve all property groups" is a
   * `propertygroup` and emphatically not a `group` — and a bare "group" would
   * happily match a `GroupId` belonging to something else entirely. Joining
   * also lands on the same noun the path gives, which is a good sign the two
   * are describing the same thing.
   */
  const singular = [...words.slice(0, -1), singularNoun(words[words.length - 1]!)];
  return singular.join("").toLowerCase();
};

/**
 * Whether this collection can be listed without already having some other id.
 *
 * Only these compete for a bare foreign key. Buildium has three collections
 * ending in `/vendors`, but two of them are `/v1/rentals/{propertyId}/vendors`
 * and `/v1/associations/{associationId}/vendors` — you cannot resolve a
 * `VendorId` against either, because you do not have a property or an
 * association to ask about, and neither is "all vendors" in any case. Counting
 * them as rivals made an unambiguous link look contested and refused it.
 */
const isBareCollection = (
  resource: ResourceSpec,
  opById: ReadonlyMap<string, { path?: string | undefined }>,
): boolean => {
  const path = pathOf(resource, opById);
  return path !== undefined && pathParamNames(path).length === 0;
};

/**
 * The noun a resource's rows are called, independent of its id.
 *
 * Read from the path rather than the id because ids are unique and nouns are
 * not: two `units` collections become `unit` and `unit-2`, and that suffix is
 * bookkeeping. Comparing ids would report the two as different nouns and miss
 * the ambiguity entirely — which is the whole thing being detected.
 */
const nounOf = (
  resource: ResourceSpec,
  opById: ReadonlyMap<string, { path?: string | undefined; title?: string | undefined }>,
): string => {
  const path = pathOf(resource, opById);
  const last = path ? pathSegments(path).pop() : undefined;
  return singularNoun(last ?? resource.id.replace(/-\d+$/, "")).toLowerCase();
};

/**
 * What the linking field actually holds, decided from the schema and not from
 * the model.
 *
 * The one relational fact that is fully determined by data already in hand, so
 * asking for it would be spending a call on something checkable — and taking
 * an answer on trust where the truth is right there is how a link comes to
 * read correctly and match nothing.
 *
 * `null` means the field cannot carry a comparable value at all: an object
 * with no id inside it. That is refused rather than recorded, because the
 * comparison would be against `[object Object]`, false for every row, and
 * indistinguishable from a parent that genuinely has no children.
 */
const linkKindOf = (
  fields: readonly MappedField[],
  name: string,
): { kind: "scalar" | "array" | "objectRef"; field: string } | null => {
  const found = fields.find((field) => field.name === name);
  // Nothing declared about this endpoint's rows, so nothing contradicts the
  // proposal. An unsampled, undescribed endpoint is ignorance, not evidence.
  if (!found) return { kind: "scalar", field: name };

  if (found.kinds.includes("array")) return { kind: "array", field: name };

  if (found.kinds.includes("object")) {
    const nested = fields.find(
      (field) => field.name === `${name}.Id` || field.name === `${name}.id`,
    );
    return nested ? { kind: "objectRef", field: nested.name } : null;
  }

  return { kind: "scalar", field: name };
};

/** Every field a resource's endpoints declare, with the kinds they carry. */
const declaredFieldsOf = (
  resource: ResourceSpec,
  opById: ReadonlyMap<string, { fields?: readonly MappedField[] | undefined }>,
): MappedField[] => {
  const byName = new Map<string, MappedField>();
  for (const opId of [resource.listOp, resource.detailOp]) {
    if (!opId) continue;
    for (const field of opById.get(opId)?.fields ?? []) {
      if (!byName.has(field.name)) byName.set(field.name, field);
    }
  }
  return [...byName.values()];
};

/** Every field name a resource's endpoints declare, for validating a guess. */
const fieldsOf = (
  resource: ResourceSpec,
  opById: ReadonlyMap<string, { fields?: readonly MappedField[] | undefined }>,
): string[] => {
  const names = new Set<string>();
  for (const opId of [resource.listOp, resource.detailOp]) {
    if (!opId) continue;
    for (const field of opById.get(opId)?.fields ?? []) names.add(field.name);
  }
  return [...names];
};
