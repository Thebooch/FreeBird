import type { EntityField, EntitySpec } from "@freebirdai/dash-spec";
import { entitySchema, fnv1a, looksLikeIdentifier, normaliseName } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * Which fields point at other records — asked as a closed question.
 *
 * The pass this replaces asked an open one: "report the relationships between
 * these resources", with fourteen field names per endpoint as evidence. It
 * found 64 links across 109 record types on a real API, and the ones it missed
 * were not exotic — a work order's `VendorId` is field 22 of 32, so it was
 * never shown at all.
 *
 * This inverts the shape. **Deterministic code enumerates every field that
 * could possibly be a reference** — an id-shaped name, an object carrying an
 * id, a field the specification calls an identifier — and the model is asked
 * one question per candidate: which of these record types does this point at,
 * or none of them? Nothing depends on the model *noticing* a field, which is
 * the failure mode that cost the previous pass most of its coverage. It also
 * makes the work countable: a candidate either got an answer or it did not.
 *
 * The answer set is closed, so a hallucinated target cannot survive: it is
 * either one of the entity ids handed over or it is discarded.
 */

/** Candidates per call. Each is one line in, one line out. */
const BATCH = 40;

/**
 * A field that might hold another record's identity.
 *
 * Three shapes, and the third is why this cannot be a name test alone: an
 * object like `Property: { Id, Type, Href }` is a reference whose *own* name
 * says nothing, and the id lives one level in.
 */
export interface ReferenceCandidate {
  /** The entity whose rows carry this field. */
  readonly entity: string;
  /** The field as the API spells it. */
  readonly path: string;
  readonly kinds: readonly string[];
  readonly description?: string | undefined;
  /** A sibling field naming which kind of record this points at, if any. */
  readonly typeField?: string | undefined;
  /** Display fields the row already carries for the referenced record. */
  readonly embedded: readonly string[];
  readonly holds: "scalar" | "array" | "objectRef";
}

const leafOf = (path: string): string => path.split(".").pop() ?? path;
const parentOf = (path: string): string | undefined =>
  path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : undefined;

/**
 * Names the spec uses for a record's own name, worth carrying as display.
 *
 * Compared against the *normalised* leaf, so the convention an API happens to
 * use does not decide whether this works. Tested against the raw name it only
 * recognised camelCase and lowercase: `first_name`, `company_name` and
 * `display_name` all missed, which on any snake_case API meant a link whose
 * row already carried the target's name was not seen to — and so fell back to
 * fetching it, or to rendering "Vendor 41" beside the name itself.
 */
const NAMEY = /^(name|title|number|label|displayname|companyname|firstname|lastname|subject)$/;

const isNamey = (leaf: string): boolean => NAMEY.test(normaliseName(leaf));

/**
 * Every field that could be a reference, from the fields alone.
 *
 * Deliberately generous: this is the *candidate* list, and a candidate costs
 * one line of prompt while a missed reference costs a link nobody can add
 * later without knowing it was absent. The model refuses the ones that are not
 * links — a reference number, a count, a code — which is a question it can
 * answer and this cannot.
 *
 * A record's own identity is excluded: it points at itself, and offering it
 * would invite a self-link on every record type in the API.
 */
export const referenceCandidates = (entity: EntitySpec): readonly ReferenceCandidate[] => {
  const byPath = new Map(entity.fields.map((field) => [field.path, field]));
  const own = entity.identity?.field;
  const found: ReferenceCandidate[] = [];
  /**
   * Paths the object pass has already claimed.
   *
   * `Property.Id` is reached two ways — as the id inside the `Property`
   * object, and as a scalar field whose own leaf is `Id` — and offering it
   * twice would ask the same question twice and pay for it twice. The object
   * reading is the better one: it is the only one that knows about the
   * sibling type field and the name sitting beside the id.
   */
  const claimed = new Set<string>();

  const kinOf = (parent: string): readonly EntityField[] =>
    entity.fields.filter((field) => parentOf(field.path) === parent);

  const typeFieldOf = (kin: readonly EntityField[]): string | undefined =>
    kin.find((field) => /^type$/i.test(leafOf(field.path)))?.path;

  const embeddedOf = (kin: readonly EntityField[]): readonly string[] =>
    kin.filter((field) => isNamey(leafOf(field.path))).map((field) => field.path);

  /* ── objects first, so the id inside one is only offered once ─────────── */

  for (const field of entity.fields) {
    if (field.path === own || field.reference) continue;
    if (!field.kinds.includes("object")) continue;

    /*
     * An object is a candidate only when it really holds an id one level in.
     * Without that there is nothing to compare, and a link matched against
     * `[object Object]` is false for every row and says so to nobody.
     */
    const kin = kinOf(field.path);
    const inner = kin.find((candidate) => /^id$/i.test(leafOf(candidate.path)));
    if (!inner) continue;

    claimed.add(inner.path);
    const typeField = typeFieldOf(kin);
    found.push({
      entity: entity.id,
      path: inner.path,
      kinds: inner.kinds.length > 0 ? [...inner.kinds] : ["number"],
      ...(field.description ?? inner.description
        ? { description: field.description ?? inner.description }
        : {}),
      ...(typeField ? { typeField } : {}),
      embedded: embeddedOf(kin),
      holds: "objectRef",
    });
  }

  /* ── then the plain and list-valued ones ──────────────────────────────── */

  for (const field of entity.fields) {
    if (field.path === own || field.reference) continue;
    if (claimed.has(field.path)) continue;
    if (field.kinds.includes("object")) continue;

    const leaf = leafOf(field.path);
    const isArray = field.kinds.includes("array");
    /*
     * The specification's own words, where they say outright that a value is
     * somebody's id. This is what catches the references whose names do not
     * follow the convention, which no name test ever will.
     */
    const described = /\b(identifier|unique id|the id of|references?)\b/i.test(
      field.description ?? "",
    );
    const named =
      looksLikeIdentifier(leaf) || (isArray && looksLikeIdentifier(leaf.replace(/s$/i, "")));
    if (!named && !described) continue;

    const kin = parentOf(field.path) ? kinOf(parentOf(field.path)!) : [];
    const siblings = kin.filter((candidate) => candidate.path !== field.path);
    const typeField = typeFieldOf(siblings);
    found.push({
      entity: entity.id,
      path: field.path,
      kinds: [...field.kinds],
      ...(field.description ? { description: field.description } : {}),
      ...(typeField ? { typeField } : {}),
      embedded: embeddedOf(siblings),
      holds: isArray ? "array" : "scalar",
    });
  }

  return found;
};

const classifiedSchema = z.object({
  entity: z.string().describe("The record type the field belongs to. Copy it exactly."),
  path: z.string().describe("The field being classified. Copy it exactly."),
  points_at: z
    .string()
    .describe(
      'The id of the record type this field identifies, copied exactly from the list — or ' +
        '"none" when the value is not a reference to anything.',
    ),
  also: z
    .array(z.string())
    .describe(
      "For a field that can point at several kinds of record, the other record type ids it " +
        "can name. Only when a sibling field says which kind each row is.",
    )
    .optional(),
  reason: z
    .string()
    .describe("Why, in one sentence somebody could disagree with.")
    .optional(),
});

export const referenceProposalSchema = z.object({
  links: z.array(classifiedSchema).optional(),
});

export type ReferenceProposal = z.infer<typeof referenceProposalSchema>;

const referenceTool: LlmTool<ReferenceProposal> = {
  name: "classify_links",
  description:
    "For each field offered, say which record type it identifies, or that it identifies nothing.",
  schema: referenceProposalSchema,
};

export const REFERENCE_SYSTEM_PROMPT = `You are deciding which fields hold another record's identity.

Every field below looks like it could be a reference. For each one, answer with
the record type it points at, or "none".

What makes a field a reference: its value IS some other record's identity, so
you could use it to look that record up. A field named for a record type plus an
id suffix usually is one; a field named for the record it sits on usually is not,
because that is the record's own id.

What is NOT a reference, however much it looks like one:
- A reference number, an invoice number, a cheque number, a code. These are
  values printed on something, not the identity of a record in this API.
- A count, an amount, a year, a quantity.
- An external system's id, or an id belonging to a record type that is not in
  the list below. "none" is the right answer for both.

Rules:
- Answer with an id copied exactly from RECORD TYPES, or the word "none".
  Anything else is discarded.
- A field is a reference to ONE record type. Use "also" only when a sibling
  field says which kind each row points at — that field is named for you where
  it exists.
- Where two record types share a noun, read the path: records in the same
  section of the API belong together. If you cannot tell, answer "none" — a
  missing link costs one question, and a wrong one silently pairs unrelated
  records and looks exactly like a right one.
- Give a reason for every link you do report. It is stored and read by the next
  person to use this API.`;

export interface ReferenceInput {
  readonly apiTitle: string;
  readonly entities: readonly EntitySpec[];
  /** The path each entity's records are listed at, for same-noun disambiguation. */
  readonly pathOf?: ((entityId: string) => string | undefined) | undefined;
}

export const buildReferencePrompt = (
  input: ReferenceInput,
  batch: readonly ReferenceCandidate[],
): string => {
  const lines: string[] = [`API: ${input.apiTitle}`, "", "RECORD TYPES — link only to these:"];
  for (const entity of input.entities) {
    const path = input.pathOf?.(entity.id);
    lines.push(
      `  ${entity.id} — ${entity.name.many}${path ? ` at ${path}` : ""}` +
        `${entity.description ? `: ${entity.description}` : ""}`,
    );
  }
  lines.push("", "FIELDS TO CLASSIFY:");
  for (const candidate of batch) {
    const owner = input.entities.find((entity) => entity.id === candidate.entity);
    const shape =
      candidate.holds === "array"
        ? " · holds several ids"
        : candidate.holds === "objectRef"
          ? " · the id inside a nested record"
          : "";
    lines.push(
      `  on ${candidate.entity} (${owner?.name.many ?? candidate.entity}): ${candidate.path}${shape}` +
        `${candidate.typeField ? ` · a sibling field "${candidate.typeField}" says which kind` : ""}` +
        `${candidate.description ? ` — the spec says: ${candidate.description}` : ""}`,
    );
  }
  return lines.join("\n");
};

export interface ReferenceResult {
  /** The entities, with references written onto their fields. */
  readonly entities: readonly EntitySpec[];
  readonly completedBatches: readonly string[];
  readonly errors: readonly string[];
  readonly skipped: readonly string[];
  /** How many candidates were offered and how many became links. */
  readonly considered: number;
  readonly linked: number;
}

/**
 * Run the pass over every candidate, batch by batch.
 *
 * The entities come back with `reference` written onto the fields that earned
 * one. Everything else about them is untouched — this pass adds links and
 * changes nothing else, so a re-run cannot damage the descriptions.
 */
export const classifyReferences = async (
  llm: LlmAdapter,
  input: ReferenceInput,
  options: {
    model?: string | undefined;
    signal?: AbortSignal | undefined;
    completedBatches?: readonly string[];
    onCheckpoint?: (result: ReferenceResult) => void;
  } = {},
): Promise<ReferenceResult> => {
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));
  const known = new Set(byId.keys());
  const candidates = input.entities.flatMap((entity) => referenceCandidates(entity));
  const errors: string[] = [];
  const skipped: string[] = [];
  const previous = new Set(options.completedBatches ?? []);
  const completed = new Set<string>();
  let linked = 0;

  /** Written as we go, so a checkpoint carries everything settled so far. */
  const references = new Map<string, Map<string, EntityField["reference"]>>();
  const record = (candidate: ReferenceCandidate, reference: EntityField["reference"]): void => {
    const held = references.get(candidate.entity) ?? new Map();
    held.set(candidate.path, reference);
    references.set(candidate.entity, held);
  };

  /** The entities with whatever has been settled so far written on. */
  const applied = (): readonly EntitySpec[] =>
    input.entities.map((entity) => {
      const found = references.get(entity.id);
      if (!found || found.size === 0) return entity;
      const parsed = entitySchema.safeParse({
        ...entity,
        fields: entity.fields.map((field) => {
          const reference = found.get(field.path);
          return reference ? { ...field, reference } : field;
        }),
      });
      /*
       * A record type that will not re-validate keeps its previous form. The
       * pass adds links; it must never be able to break a description that
       * was already good.
       */
      return parsed.success ? parsed.data : entity;
    });

  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    const batchKey = fnv1a(
      JSON.stringify({
        title: input.apiTitle,
        batch: batch.map((candidate) => `${candidate.entity}.${candidate.path}`),
        targets: [...known].sort(),
      }),
    );
    if (previous.has(batchKey)) {
      completed.add(batchKey);
      continue;
    }
    const errorsBefore = errors.length;
    const where = `fields ${start + 1}–${start + batch.length}`;
    const offered = new Map(
      batch.map((candidate) => [`${candidate.entity}.${candidate.path}`, candidate]),
    );

    try {
      const result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0.2,
        maxOutputTokens: 8192,
        messages: [
          { role: "system" as const, content: REFERENCE_SYSTEM_PROMPT },
          { role: "user" as const, content: buildReferencePrompt(input, batch) },
        ],
        tools: { classify_links: referenceTool },
        toolChoice: { name: "classify_links" as const },
      });

      const call = result.toolCalls.find((candidate) => candidate.name === "classify_links");
      if (!call) {
        errors.push(`${where}: the model answered without calling the tool.`);
        continue;
      }

      const args = call.args as { links?: unknown };
      const rows = Array.isArray(args.links) ? args.links : [];
      let malformed = 0;

      for (const entry of rows) {
        const one = classifiedSchema.safeParse(entry);
        if (!one.success) {
          malformed += 1;
          continue;
        }
        const candidate = offered.get(`${one.data.entity}.${one.data.path}`);
        if (!candidate) {
          skipped.push(`${where}: "${one.data.path}" was classified and was not offered.`);
          continue;
        }
        const target = one.data.points_at;
        if (target === "none" || target === "") continue;
        if (!known.has(target)) {
          skipped.push(
            `${candidate.entity}.${candidate.path}: "${target}" is not a record type on this API, so no link was recorded.`,
          );
          continue;
        }
        /*
         * A link from a record to itself on a field that is not its identity
         * is possible and real — a task's parent task — so this is allowed.
         * What is refused is the *identity* field, and that never reaches
         * here: `referenceCandidates` excludes it.
         */
        const alsoIds = (one.data.also ?? []).filter((id) => known.has(id) && id !== target);
        const map: Record<string, string> = {};
        if (candidate.typeField && alsoIds.length > 0) {
          /*
           * A discriminated link needs a value → record type map, and only the
           * API's own values can fill it. Nothing here has seen a value, so
           * the entity ids are used as the keys and the live pass corrects
           * them when a row is read. Recording the *shape* now is what lets a
           * reader see the link is conditional at all.
           */
          for (const id of [target, ...alsoIds]) map[id] = id;
        }

        record(candidate, {
          entity: target,
          holds: candidate.holds,
          embedded: [...candidate.embedded],
          ...(candidate.typeField && Object.keys(map).length > 0
            ? { typeField: { field: candidate.typeField, map } }
            : {}),
          verified: false,
        });
        linked += 1;
      }

      if (malformed > 0) {
        skipped.push(`${where}: ${malformed} classification(s) were malformed and dropped.`);
      }
    } catch (cause) {
      errors.push(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (errors.length === errorsBefore) {
        completed.add(batchKey);
        options.onCheckpoint?.({
          entities: applied(),
          errors,
          skipped,
          completedBatches: [...completed],
          considered: candidates.length,
          linked,
        });
      }
    }
  }

  return {
    entities: applied(),
    errors,
    skipped,
    completedBatches: [...completed],
    considered: candidates.length,
    linked,
  };
};
