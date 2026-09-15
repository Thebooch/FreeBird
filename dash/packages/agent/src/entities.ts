import type { EntitySpec, MappedField, ResourceSpec } from "@freebirdai/dash-spec";
import {
  ENTITY_KINDS,
  ENTITY_VERSION,
  entitySchema,
  fnv1a,
  humanLabel,
  isFieldNoise,
  pathParamNames,
} from "@freebirdai/dash-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * Describing what an API's records are, once, for everybody who connects it.
 *
 * The pass the whole entity model rests on. It is handed the structure the
 * importer read out of the URLs — which endpoint lists a thing, which returns
 * one, what fields each declares — and answers the questions no schema
 * contains: what are these records called, which field identifies one, how do
 * you say its name, and what does each field mean to somebody who will never
 * see the API.
 *
 * Three decisions shape it, and each was paid for by a defect in the pass it
 * replaces.
 *
 * **Whole field lists, not the first fourteen.** The relation pass showed the
 * model `FIELDS_SHOWN = 14` names per endpoint, and on a real API the
 * references sit past that — Buildium's work orders carry `VendorId` at field
 * 22, so the link from a work order to its vendor could not be found at all.
 * Fewer resources per call is the right trade: the fields are the evidence.
 *
 * **One label per field per record type, never per API.** The lexicon this
 * replaces is keyed by bare field name across the whole API, so the *task*
 * list's `Id` reads "Transaction" and its `Title` reads "File title" — a name
 * some other endpoint earned. A field means what it means *on this record*.
 *
 * **Descriptions are the point, not a bonus.** The specification already
 * described 2,898 of Buildium's 2,927 field entries and not one of those
 * sentences ever reached a user. They are handed to the model as evidence and
 * rewritten for a reader, which is the cheapest quality in the product.
 */

/** Resources per call. Low, because whole field lists are the evidence. */
const BATCH = 6;

/**
 * Fields described per resource, at most.
 *
 * A ceiling rather than a target: the largest real endpoint measured 52
 * fields, so this clips almost nothing — and where it does clip, the noise
 * fields go first, so what survives is what a person would read.
 */
const MAX_FIELDS = 120;

const describedFieldSchema = z.object({
  path: z.string().describe("The field's name exactly as given. Copy it, never adjust it."),
  label: z
    .string()
    .describe(
      "What to call it on screen, in a person's words. Two or three words, no punctuation, " +
        "not a sentence. Leave it out if the mechanical name already reads well.",
    )
    .optional(),
  description: z
    .string()
    .describe(
      "One plain line saying what this field holds, for somebody who will never see the API. " +
        "Rewrite the spec's own words rather than repeating them verbatim.",
    )
    .optional(),
  visibility: z
    .string()
    .describe(
      'One of: "primary" (worth a column in a list), "detail" (worth showing on the record ' +
        'page), "hidden" (exists for the API — a self-link, an internal key, a field that is ' +
        "always empty).",
    )
    .optional(),
  group: z
    .string()
    .describe(
      "A short heading this field belongs under on the record page, in the API's own domain " +
        'language — "Contact", "Amounts", "Dates". Leave it out for the obvious ones.',
    )
    .optional(),
});

const describedEntitySchema = z.object({
  resource: z.string().describe("The resource id being described. Copy it exactly."),
  name: z
    .string()
    .describe('What ONE of these records is called, singular and capitalised: "Work order".'),
  plural: z.string().describe('What several are called: "Work orders".'),
  description: z
    .string()
    .describe(
      "One sentence saying what these records are, in the API's own domain language, so " +
        "somebody choosing between two similar ones can tell them apart.",
    )
    .optional(),
  kind: z
    .string()
    .describe(`What sort of thing this is. One of: ${ENTITY_KINDS.join(", ")}.`)
    .optional(),
  identity: z
    .string()
    .describe("The field holding a record's own id. Copy the name exactly.")
    .optional(),
  title: z
    .array(z.string())
    .describe(
      "The field, or the two or three fields, whose values ARE this record's name — a company " +
        "name, or a first and last name together. Never an id unless nothing else identifies " +
        "it. Copy names exactly.",
    )
    .optional(),
  subtitle: z
    .string()
    .describe("A field qualifying the name, where a second one genuinely does.")
    .optional(),
  status: z
    .string()
    .describe("A field holding this record's state, if it has one. Not a date and not a number.")
    .optional(),
  fields: z
    .array(describedFieldSchema)
    .describe("Every field worth describing. Leave out nothing a person would read."),
});

export const entityProposalSchema = z.object({
  entities: z.array(describedEntitySchema).optional(),
});

export type EntityProposal = z.infer<typeof entityProposalSchema>;
export type DescribedEntity = z.infer<typeof describedEntitySchema>;

const entityTool: LlmTool<EntityProposal> = {
  name: "describe_records",
  description:
    "Describe what each of these record types is, what identifies one, how to say its name, " +
    "and what each of its fields means.",
  schema: entityProposalSchema,
};

export const ENTITY_SYSTEM_PROMPT = `You are describing an API's records for people who will never see the API.

For each resource you are shown, answer four things.

1. WHAT IT IS CALLED. The singular and plural a person would use. Read the path
   AND the endpoint titles, because they disagree more often than you would
   expect — a collection mounted at one noun and titled "Retrieve all" another
   holds the one in the title. Capitalise it as a person would.

2. WHAT IT IS. One sentence saying what these records are. This is what somebody
   reads when choosing between two similarly-named collections, so say what
   distinguishes it rather than restating its name.

3. WHAT IDENTIFIES ONE, AND WHAT IT IS CALLED. "identity" is the field holding
   the record's own id. "title" is the field — or the two or three fields — whose
   values a person would read as this record's *name*. Those are different
   things and both matter: an id identifies, a name identifies *to a person*.
   Use an id as the title only when nothing else in the record identifies it.

4. WHAT EACH FIELD MEANS. A label in a person's words, and one plain line about
   what it holds. The specification's own description is given where it exists —
   rewrite it for a reader rather than copying it. Mark a field "hidden" when it
   exists for the API rather than for a person: a link back to the API, an
   internal key, a field that is empty on every record.

Rules:
- Use resource ids and field names EXACTLY as given. Anything else is discarded,
  never approximated.
- A label is a name, not a sentence: two or three words, no trailing colon, no
  punctuation. Leave it out entirely when the mechanical name already reads well
  — an entry that says nothing costs a reader attention for nothing.
- Describe the fields that are there. Do not invent one, and do not describe one
  you were not shown.
- "kind" is about the shape of the thing, not its domain: work to be done, a
  party dealt with, an asset, a place, money, a document, an event, a note, or a
  lookup list other records point at. Anything that fits none of those is other.
- Say nothing about charts, filters or what would make a good widget. Not this job.`;

export interface EntityInput {
  readonly apiTitle: string;
  readonly resources: readonly ResourceSpec[];
  /** Every endpoint, so a resource's own fields and titles can be read. */
  readonly ops: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly path: string;
    readonly description?: string | undefined;
    readonly fields?: readonly MappedField[] | undefined;
  }>;
}

/**
 * The fields a resource's records carry, in the order worth describing.
 *
 * Read from the list endpoint and the detail endpoint together, because they
 * differ: a detail response routinely carries fields the collection omits, and
 * those are exactly the ones a record page exists to show. Noise sorts last
 * rather than being dropped — a `Href` still deserves to be *marked* hidden,
 * and the clip only ever bites the tail.
 */
export const fieldsOfResource = (
  resource: ResourceSpec,
  ops: EntityInput["ops"],
): readonly MappedField[] => {
  const byId = new Map(ops.map((op) => [op.id, op]));
  const found = new Map<string, MappedField>();
  for (const opId of [resource.listOp, resource.detailOp]) {
    const op = opId ? byId.get(opId) : undefined;
    for (const field of op?.fields ?? []) {
      if (!found.has(field.name)) found.set(field.name, field);
    }
  }
  return [...found.values()]
    .sort((a, b) => Number(isFieldNoise(a.name)) - Number(isFieldNoise(b.name)))
    .slice(0, MAX_FIELDS);
};

const shapeOf = (field: MappedField): string => {
  if (field.kinds.includes("array")) return "a list";
  if (field.kinds.includes("object")) return "a nested record";
  if (field.format) return field.format;
  return field.kinds.filter((kind) => kind !== "null").join("|") || "unknown";
};

export const buildEntityPrompt = (
  input: EntityInput,
  batch: readonly ResourceSpec[],
): string => {
  const byId = new Map(input.ops.map((op) => [op.id, op]));
  const lines: string[] = [`API: ${input.apiTitle}`, ""];

  for (const resource of batch) {
    lines.push(`RESOURCE ${resource.id}`);
    for (const opId of [resource.listOp, resource.detailOp]) {
      const op = opId ? byId.get(opId) : undefined;
      if (!op) continue;
      const role = opId === resource.listOp ? "lists them" : "returns one";
      lines.push(`  endpoint ${op.path}  (${role})`);
      lines.push(`    title: ${op.title}`);
      if (op.description) lines.push(`    description: ${op.description}`);
    }
    if (resource.idField) lines.push(`  a real response showed its id is: ${resource.idField}`);

    const fields = fieldsOfResource(resource, input.ops);
    lines.push(`  FIELDS (${fields.length}):`);
    for (const field of fields) {
      const said = field.description ? ` — the spec says: ${field.description}` : "";
      lines.push(`    ${field.name} · ${shapeOf(field)}${field.nullable ? " · nullable" : ""}${said}`);
    }
    lines.push("");
  }

  return lines.join("\n");
};

export interface EntityResult {
  readonly entities: readonly EntitySpec[];
  readonly completedBatches: readonly string[];
  readonly errors: readonly string[];
  /**
   * Proposals refused, and why.
   *
   * Separate from `errors` because nothing went wrong: the pass worked and
   * declined a reading it could not justify. A record type that came back
   * unnamed needs a reason attached or it reads as the pass not noticing.
   */
  readonly skipped: readonly string[];
}

/** A visibility the schema accepts, or nothing rather than a guess. */
const asVisibility = (raw: string | undefined): "primary" | "detail" | "hidden" | undefined =>
  raw === "primary" || raw === "detail" || raw === "hidden" ? raw : undefined;

const asKind = (raw: string | undefined): EntitySpec["kind"] | undefined =>
  (ENTITY_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as EntitySpec["kind"])
    : undefined;

/**
 * A label worth storing.
 *
 * The same bar the lexicon applies: this is "is it better than the mechanical
 * answer", not "is it acceptable". An entry equal to what `humanLabel` already
 * produces occupies a shared artifact in order to say nothing.
 */
export const acceptEntityLabel = (path: string, raw: string | undefined): string | undefined => {
  const label = (raw ?? "").replace(/\s+/g, " ").trim();
  if (label.length === 0 || label.length > 60) return undefined;
  if (/[<>{}]|^\s*$/.test(label)) return undefined;
  if (label.toLowerCase() === humanLabel(path).toLowerCase()) return undefined;
  return label;
};

/**
 * Turn one proposal into an entity, keeping only what the fields support.
 *
 * Every name is checked against the fields that were offered. The pass is
 * model-driven and its output is shared with everybody who connects this API,
 * so a field it invented must not survive into the artifact — and the entity
 * schema refuses one anyway, which would cost the whole record type rather
 * than the one name.
 */
export const entityFromProposal = (input: {
  readonly proposal: DescribedEntity;
  readonly resource: ResourceSpec;
  readonly fields: readonly MappedField[];
  readonly scope?: EntitySpec["scope"] | undefined;
  readonly model?: string | undefined;
  readonly now?: () => Date;
}): { entity: EntitySpec | null; skipped: readonly string[] } => {
  const { proposal, resource, fields } = input;
  const offered = new Set(fields.map((field) => field.name));
  const skipped: string[] = [];
  const keep = (path: string | undefined, what: string): string | undefined => {
    if (!path) return undefined;
    if (offered.has(path)) return path;
    skipped.push(`${resource.id}: ${what} named "${path}", which these records do not carry.`);
    return undefined;
  };

  const described = new Map<string, DescribedEntity["fields"][number]>();
  for (const field of proposal.fields ?? []) {
    if (!offered.has(field.path)) {
      skipped.push(`${resource.id}: a field called "${field.path}" was described and does not exist.`);
      continue;
    }
    described.set(field.path, field);
  }

  /*
   * Every field the records carry, described or not.
   *
   * A field the pass skipped is still real, so it appears with no label and
   * the mechanical name shows for it. Dropping it would lose data silently and
   * would also make the schema's own guard useless — a display or a column
   * naming it would then be refused for naming something "the records do not
   * have", when they do.
   */
  const entityFields = fields.map((field) => {
    const said = described.get(field.name);
    const label = acceptEntityLabel(field.name, said?.label);
    const visibility =
      asVisibility(said?.visibility) ?? (isFieldNoise(field.name) ? "hidden" : "detail");
    return {
      path: field.name,
      ...(label ? { label } : {}),
      ...(said?.description ? { description: said.description.slice(0, 300) } : {}),
      visibility,
      ...(said?.group ? { group: said.group.slice(0, 60) } : {}),
      /*
       * Carried from the declared schema, not from the model: whether a field
       * holds a list or a nested record is a fact nobody should be asked to
       * restate, and it is what the reference pass reads to know whether a
       * link can match at all.
       */
      kinds: [...field.kinds],
      /*
       * Also from the declared schema. A closed set of values is the one thing
       * about a field that a sample cannot establish: rows show the values an
       * account happens to have, so a filter strip built from them silently
       * omits the status nobody is currently in.
       */
      ...(field.values && field.values.length > 0 ? { values: [...field.values] } : {}),
    };
  });

  const title = (proposal.title ?? [])
    .map((path) => keep(path, "the record's name"))
    .filter((path): path is string => Boolean(path))
    .slice(0, 3);

  const identity = keep(proposal.identity, "the identity") ?? resource.idField;

  const parsed = entitySchema.safeParse({
    id: resource.id,
    resource: resource.id,
    name: { one: proposal.name.slice(0, 60), many: proposal.plural.slice(0, 60) },
    ...(proposal.description ? { description: proposal.description.slice(0, 400) } : {}),
    ...(asKind(proposal.kind) ? { kind: asKind(proposal.kind) } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(identity && offered.has(identity)
      ? { identity: { field: identity, observed: resource.idField === identity } }
      : {}),
    ...(title.length > 0
      ? {
          display: {
            title,
            ...(keep(proposal.subtitle, "the subtitle") ? { subtitle: proposal.subtitle } : {}),
            ...(keep(proposal.status, "the status") ? { status: proposal.status } : {}),
          },
        }
      : {}),
    fields: entityFields,
    ...(input.model
      ? {
          provenance: {
            model: input.model,
            at: (input.now ?? (() => new Date()))().toISOString(),
            version: ENTITY_VERSION,
          },
        }
      : {}),
  });

  if (!parsed.success) {
    return {
      entity: null,
      skipped: [
        ...skipped,
        `${resource.id}: the description did not validate (${parsed.error.issues
          .slice(0, 2)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}).`,
      ],
    };
  }
  return { entity: parsed.data, skipped };
};

/**
 * The parent a scoped collection belongs to, from the path the API published.
 *
 * `/tasks/{taskId}/history` cannot be listed on its own, and saying so is what
 * stops it being offered as a starting point — an offer that cannot be
 * executed. Read from the URL rather than inferred, so it is certain.
 */
export const scopeOf = (
  resource: ResourceSpec,
  resources: readonly ResourceSpec[],
  ops: EntityInput["ops"],
): EntitySpec["scope"] | undefined => {
  const byId = new Map(ops.map((op) => [op.id, op]));
  const listPath = resource.listOp ? byId.get(resource.listOp)?.path : undefined;
  if (!listPath) return undefined;
  const params = pathParamNames(listPath);
  if (params.length !== 1) return undefined;

  const prefix = listPath.slice(0, listPath.indexOf("{{"));
  const parent = resources.find((candidate) => {
    if (candidate.id === resource.id) return false;
    const path = candidate.listOp ? byId.get(candidate.listOp)?.path : undefined;
    return path !== undefined && prefix.startsWith(`${path}/`);
  });
  return parent ? { parent: parent.id, param: params[0]! } : undefined;
};

/**
 * Run the pass, batch by batch.
 *
 * Batches fail independently, exactly as the mapping and labelling passes do:
 * a set of record types covering most of an API is worth keeping and worth
 * re-running for the rest, and one that throws away nine good calls because
 * the tenth timed out is not.
 */
export const describeEntities = async (
  llm: LlmAdapter,
  input: EntityInput,
  options: {
    model?: string | undefined;
    signal?: AbortSignal | undefined;
    completedBatches?: readonly string[];
    /** Entities already written, so a resumed run keeps them. */
    existing?: readonly EntitySpec[];
    onCheckpoint?: (result: EntityResult) => void;
  } = {},
): Promise<EntityResult> => {
  const byId = new Map((options.existing ?? []).map((entity) => [entity.resource, entity]));
  const errors: string[] = [];
  const skipped: string[] = [];
  const previous = new Set(options.completedBatches ?? []);
  const completed = new Set<string>();
  const model = options.model ?? llm.defaultModel;

  /* Only resources with somewhere to read rows from can be described. */
  const describable = input.resources.filter(
    (resource) => fieldsOfResource(resource, input.ops).length > 0,
  );

  for (let start = 0; start < describable.length; start += BATCH) {
    const batch = describable.slice(start, start + BATCH);
    const batchKey = fnv1a(
      JSON.stringify({
        title: input.apiTitle,
        batch: batch.map((resource) => [
          resource.id,
          fieldsOfResource(resource, input.ops).map((field) => field.name),
        ]),
      }),
    );
    if (previous.has(batchKey)) {
      completed.add(batchKey);
      continue;
    }
    const errorsBefore = errors.length;
    const where = `resources ${start + 1}–${start + batch.length}`;

    try {
      const result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0.2,
        maxOutputTokens: 16_384,
        messages: [
          { role: "system" as const, content: ENTITY_SYSTEM_PROMPT },
          { role: "user" as const, content: buildEntityPrompt(input, batch) },
        ],
        tools: { describe_records: entityTool },
        toolChoice: { name: "describe_records" as const },
      });

      const call = result.toolCalls.find((candidate) => candidate.name === "describe_records");
      if (!call) {
        errors.push(`${where}: the model answered without calling the tool.`);
        continue;
      }

      /*
       * Salvaged entry by entry rather than parsed as a unit. The same
       * reasoning as the other two passes: a list validated whole is
       * all-or-nothing, and one malformed record type should not cost five
       * good ones.
       */
      const args = call.args as { entities?: unknown };
      const rows = Array.isArray(args.entities) ? args.entities : [];
      const row = describedEntitySchema;
      const wanted = new Map(batch.map((resource) => [resource.id, resource]));

      let malformed = 0;
      for (const entry of rows) {
        const one = row.safeParse(entry);
        if (!one.success) {
          malformed += 1;
          continue;
        }
        const resource = wanted.get(one.data.resource);
        if (!resource) {
          skipped.push(
            `${where}: a description named "${one.data.resource}", which was not one of the records offered.`,
          );
          continue;
        }
        const scope = scopeOf(resource, input.resources, input.ops);
        const built = entityFromProposal({
          proposal: one.data,
          resource,
          fields: fieldsOfResource(resource, input.ops),
          ...(scope ? { scope } : {}),
          model,
        });
        skipped.push(...built.skipped);
        if (built.entity) byId.set(resource.id, built.entity);
      }

      if (malformed > 0) {
        skipped.push(`${where}: ${malformed} description(s) were malformed and dropped.`);
      }
    } catch (cause) {
      errors.push(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (errors.length === errorsBefore) {
        completed.add(batchKey);
        options.onCheckpoint?.({
          entities: [...byId.values()],
          errors,
          skipped,
          completedBatches: [...completed],
        });
      }
    }
  }

  return {
    entities: [...byId.values()],
    errors,
    skipped,
    completedBatches: [...completed],
  };
};
