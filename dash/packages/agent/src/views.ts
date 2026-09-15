import type { EntitySpec } from "@freebirdai/dash-spec";
import type { GraphOp } from "@freebirdai/dash-spec";
import {
  FACET_MAX_PER_WIDGET,
  entityGraph,
  entitySchema,
  fnv1a,
  recipeFor,
} from "@freebirdai/dash-spec";
import type { ResourceSpec } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { LlmAdapter, LlmTool } from "./llm.js";

/**
 * What a list and a page of each record type should look like.
 *
 * The third pass, and the one with the least to do — which is the point.
 * Every slot it fills already has a defensible answer without it: columns come
 * from the record type's own primary fields, the sort from the first date its
 * kind would order by, the strips from the field names its kind reaches for,
 * and the numbers above a record from counting the collections hanging off it.
 * Nothing here is required for the product to work, and that is deliberate —
 * an API nobody has paid for this on is a working API.
 *
 * What it buys is the cases where those rules are blunt:
 *
 * - **Columns.** A record type with forty fields has six worth a table, and
 *   which six is a judgement about the domain, not about the schema.
 * - **Strips.** The recipe matches names like `status` and `type`. A field
 *   called `Bucket` that holds exactly those values is invisible to it.
 * - **Sort.** Where no field is marked as a date, the kind's rule finds
 *   nothing and a list comes back in whatever order the endpoint returns.
 * - **Sums.** That a collection is worth *counting* needs no opinion; that its
 *   `Amount` is worth *totalling* is exactly an opinion, and the difference
 *   between "12 bills" and "£4,200 outstanding".
 *
 * Every answer is checked against the record type's real fields and its real
 * back-references. An invented name is dropped with a reason, never
 * approximated — the same rule the other two passes follow, and for the same
 * reason: a view naming a field that does not exist renders as "this view no
 * longer matches its data", which blames the reader's data for a bad write.
 */

/** Record types per call. Each carries its whole field list, so this is small. */
const BATCH = 6;

/** How many numbers fit above a record before they stop being read. */
const MAX_STATS = 4;

/** How many fields a table shows before it stops being readable. */
const MAX_COLUMNS = 6;

/**
 * Where a list stops being a long answer and starts being nonsense.
 *
 * Deliberately far above every real cap, because the caps are applied by
 * *trimming* further down and a schema that rejects instead throws away the
 * whole batch — six record types lost because one of them listed seven
 * candidate filter fields where six fit. That happened: two of eighteen
 * batches on a real API, for exactly this.
 *
 * So the schema's job here is only to refuse an answer nobody could mean. The
 * choosing is `slice`'s job, and a list that is merely too long is an answer.
 */
const OVER_LONG = 60;

/**
 * Absent and `null` mean the same thing: nothing was chosen.
 *
 * Stripped before parsing rather than allowed by the schema, because a tool
 * schema has to stay flat — the converter refuses a nullable outright, so
 * `.nullish()` here fails every call rather than tolerating anything.
 *
 * Worth doing at all because models emit an explicit `null` for a slot they
 * are declining at least as often as they omit the key, and one `null` used to
 * cost the *whole batch*: measured on a real API, three of eighteen batches
 * failed this way, taking eighteen record types with them.
 */
const withoutNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, withoutNulls(entry)]),
  );
};

const viewProposalSchema = z.object({
  views: z
    .array(
      z.object({
        entity: z.string().min(1).max(64),
        /** Fields worth a column, best first. Trimmed here, never refused. */
        columns: z.array(z.string().min(1).max(200)).max(OVER_LONG).optional(),
        sort: z
          .object({
            field: z.string().min(1).max(200),
            dir: z.enum(["asc", "desc"]).optional(),
          })
          .optional(),
        /** Fields whose values are categories worth a strip above the rows. */
        facets: z.array(z.string().min(1).max(200)).max(OVER_LONG).optional(),
        /** The date a timeline orders by. */
        time_field: z.string().min(1).max(200).optional(),
        stats: z
          .array(
            z.object({
              label: z.string().min(1).max(60),
              /** The id of one of the collections offered for this record. */
              collection: z.string().min(1).max(200),
              agg: z.enum(["count", "sum"]),
              /** Required for a sum. The field on the *far* records. */
              field: z.string().min(1).max(200).optional(),
            }),
          )
          .max(OVER_LONG)
          .optional(),
      }),
    )
    .max(BATCH),
});

export type ViewProposal = z.infer<typeof viewProposalSchema>;

export const VIEWS_SYSTEM_PROMPT = `You are choosing how each of an API's record types should be shown.

You are given record types, their fields, and the collections that hang off each one. For each record type, choose:

- columns: the fields worth a column in a table of these, best first. Pick what somebody scanning the list needs to tell one row from another and judge it — a name, a state, a date, an amount. Leave out identifiers, links and anything only useful once a single record is open.
- sort: the field a list of these should be ordered by, and which direction. Newest first for anything that happens; by name for anything that is a party or a place. Omit it if nothing is a sensible default order.
- facets: fields whose values are a small closed set worth offering as a row of filter tiles — a state, a category, a kind, an assignee. Never a date, an amount, a description, or an identifier: those hold a different value on nearly every record, and a tile per record is not a filter.
- time_field: the date these records are naturally placed on a timeline by, where there is one.
- stats: up to four numbers worth showing above a single record, each counting or totalling one of the collections offered for it. Counting needs no justification; total something only where the sum is a figure somebody actually wants, and name the field being totalled.

Rules:
- Use only the field paths given for that record type, spelled exactly. Never invent one, never abbreviate one.
- A stat's collection must be one of the ids offered for that record type.
- Say nothing rather than guessing. Omitting a slot leaves a sensible default in place; naming a field that does not exist produces a view that fails to draw.
- Judge from the field names, their descriptions and what the record type is. Nothing here is about any one company's data.`;

const viewsTool: LlmTool<ViewProposal> = {
  name: "choose_views",
  description: "Choose how each record type is listed and shown.",
  schema: viewProposalSchema,
};

export interface ViewsInput {
  readonly apiTitle: string;
  readonly entities: readonly EntitySpec[];
  readonly resources: readonly ResourceSpec[];
  /** Every endpoint, so back-references can be worked out and offered. */
  readonly ops: readonly GraphOp[];
}

export interface ViewsResult {
  readonly entities: readonly EntitySpec[];
  readonly completedBatches: readonly string[];
  readonly errors: readonly string[];
  /** Answers refused, and why — the pass worked and declined to record one. */
  readonly skipped: readonly string[];
  /** How many record types were offered and how many came back with a view. */
  readonly considered: number;
  readonly chosen: number;
}

/** The fields a reader could be shown at all. */
const visible = (entity: EntitySpec) =>
  entity.fields.filter((field) => field.visibility !== "hidden");

const promptFor = (
  input: ViewsInput,
  batch: readonly EntitySpec[],
  collectionsOf: (id: string) => readonly { id: string; title: string; entity: string }[],
): string => {
  const lines: string[] = [`API: ${input.apiTitle}`, ""];
  for (const entity of batch) {
    lines.push(`Record type: ${entity.id} — ${entity.name.many} (${entity.kind})`);
    if (entity.description) lines.push(`  ${entity.description}`);
    lines.push("  fields:");
    for (const field of visible(entity)) {
      const bits = [field.label ?? field.path];
      if (field.semantic) bits.push(field.semantic);
      if (field.values && field.values.length > 0) {
        bits.push(`one of: ${field.values.slice(0, 8).join(", ")}`);
      }
      if (field.description) bits.push(field.description.slice(0, 120));
      lines.push(`    ${field.path} — ${bits.join("; ")}`);
    }
    const collections = collectionsOf(entity.id);
    if (collections.length > 0) {
      lines.push("  collections that hang off one of these:");
      for (const one of collections) lines.push(`    ${one.id} — ${one.title}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

/**
 * Choose the views, batch by batch.
 *
 * The entities come back with `views` written and everything else untouched,
 * so a re-run cannot damage the descriptions or the links two earlier passes
 * paid for.
 */
export const chooseViews = async (
  llm: LlmAdapter,
  input: ViewsInput,
  options: {
    model?: string | undefined;
    signal?: AbortSignal | undefined;
    completedBatches?: readonly string[];
    onCheckpoint?: (result: ViewsResult) => void;
  } = {},
): Promise<ViewsResult> => {
  const graph = entityGraph({
    entities: input.entities,
    resources: input.resources,
    ops: input.ops,
  });

  const collectionsOf = (id: string) =>
    graph.backrefsOf(id).map((backref) => ({
      id: backref.id,
      title: backref.title,
      entity: backref.entity,
    }));

  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));
  const chosenViews = new Map<string, EntitySpec["views"]>();
  const errors: string[] = [];
  const skipped: string[] = [];
  const previous = new Set(options.completedBatches ?? []);
  const completed = new Set<string>();

  /** Entities with something to show. One with no visible field has no view. */
  const describable = input.entities.filter((entity) => visible(entity).length > 0);

  const settle = (): ViewsResult => {
    /*
     * Counted from what survives, never from what was accepted.
     *
     * A view can pass this file's own checks and still fail the record type's
     * schema — and when it does it is dropped whole rather than half-applied,
     * because a record type keeping the defaults it had draws correctly and a
     * half-written view does not. Reporting the proposals instead of the
     * survivors said "90 chosen" on a run that stored 80, which is exactly the
     * confidently wrong number this codebase exists to not produce.
     */
    let stored = 0;
    const entities = input.entities.map((entity) => {
      const views = chosenViews.get(entity.id);
      if (!views) return entity;
      const parsed = entitySchema.safeParse({ ...entity, views });
      if (!parsed.success) return entity;
      stored += 1;
      return parsed.data;
    });

    const lost = chosenViews.size - stored;
    return {
      entities,
      completedBatches: [...completed],
      errors: [...errors],
      skipped: [
        ...skipped,
        ...(lost > 0
          ? [`${lost} view(s) did not validate against their record type and were left at their defaults.`]
          : []),
      ],
      considered: describable.length,
      chosen: stored,
    };
  };

  for (let start = 0; start < describable.length; start += BATCH) {
    const batch = describable.slice(start, start + BATCH);
    const batchKey = fnv1a(
      JSON.stringify({
        title: input.apiTitle,
        batch: batch.map((entity) => `${entity.id}:${visible(entity).length}`),
      }),
    );
    if (previous.has(batchKey)) {
      completed.add(batchKey);
      continue;
    }
    const where = `record types ${start + 1}–${start + batch.length}`;

    try {
      const result = await llm.generate({
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        temperature: 0.2,
        maxOutputTokens: 8192,
        messages: [
          { role: "system" as const, content: VIEWS_SYSTEM_PROMPT },
          { role: "user" as const, content: promptFor(input, batch, collectionsOf) },
        ],
        tools: { choose_views: viewsTool },
        toolChoice: { name: "choose_views" as const },
      });

      const call = result.toolCalls.find((candidate) => candidate.name === "choose_views");
      if (!call) {
        errors.push(`${where}: the model answered without calling the tool.`);
        continue;
      }
      const parsed = viewProposalSchema.safeParse(withoutNulls(call.args));
      if (!parsed.success) {
        /*
         * Which field, and what was wrong with it. "The answer did not match
         * the tool's shape" names a batch that failed and gives nobody a way
         * to find out why — and a batch failing costs all six record types in
         * it, so this is exactly where the detail is worth carrying.
         */
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        errors.push(`${where}: the answer did not match the tool's shape — ${detail}`);
        continue;
      }

      const offered = new Set(batch.map((entity) => entity.id));
      for (const proposal of parsed.data.views) {
        const entity = byId.get(proposal.entity);
        if (!entity || !offered.has(proposal.entity)) {
          skipped.push(`${where}: "${proposal.entity}" was answered for and was not offered.`);
          continue;
        }

        const shown = new Set(visible(entity).map((field) => field.path));
        const keep = (path: string | undefined, what: string): string | undefined => {
          if (!path) return undefined;
          if (shown.has(path)) return path;
          skipped.push(`${entity.id}: "${path}" is not a field these records show, so ${what}.`);
          return undefined;
        };

        const columns = (proposal.columns ?? [])
          .map((path) => keep(path, "it is not a column"))
          .filter((path): path is string => Boolean(path))
          .slice(0, MAX_COLUMNS);

        const sortField = keep(proposal.sort?.field, "nothing sorts by it");
        const facets = (proposal.facets ?? [])
          .map((path) => keep(path, "no strip offers it"))
          .filter((path): path is string => Boolean(path))
          .slice(0, FACET_MAX_PER_WIDGET);
        const timeField = keep(proposal.time_field, "no timeline uses it");

        const collections = new Map(collectionsOf(entity.id).map((one) => [one.id, one]));
        const stats = (proposal.stats ?? []).flatMap((stat) => {
          const collection = collections.get(stat.collection);
          if (!collection) {
            skipped.push(
              `${entity.id}: "${stat.collection}" is not a collection hanging off these, so "${stat.label}" was dropped.`,
            );
            return [];
          }
          if (stat.agg === "sum") {
            // The field belongs to the *far* records, so it is checked against
            // them — a sum over a field the collection does not have produces
            // a number that is always zero.
            const far = byId.get(collection.entity);
            const there = new Set((far ? visible(far) : []).map((field) => field.path));
            if (!stat.field || !there.has(stat.field)) {
              skipped.push(
                `${entity.id}: "${stat.label}" totals a field ${collection.title.toLowerCase()} do not carry, so it was dropped.`,
              );
              return [];
            }
          }
          return [
            {
              label: stat.label.slice(0, 60),
              backref: stat.collection,
              agg: stat.agg,
              ...(stat.agg === "sum" && stat.field ? { field: stat.field } : {}),
            },
          ];
        })
          // Four is what a row of figures holds at a glance. Trimmed here for
          // the same reason as everything else above: an over-long answer is
          // an answer.
          .slice(0, MAX_STATS);

        chosenViews.set(entity.id, {
          ...entity.views,
          ...(columns.length > 0 ? { columns } : {}),
          ...(sortField
            ? {
                sort: {
                  field: sortField,
                  dir: proposal.sort?.dir ?? recipeFor(entity.kind).sortDir,
                },
              }
            : {}),
          ...(facets.length > 0 ? { facets } : {}),
          ...(timeField ? { timeField } : {}),
          ...(stats.length > 0 ? { stats } : {}),
        } as EntitySpec["views"]);
      }

      completed.add(batchKey);
      options.onCheckpoint?.(settle());
    } catch (cause) {
      /*
       * One batch failing is not the run failing. Every other record type keeps
       * whatever it was given, and the batch key stays unrecorded so running
       * this again picks up exactly what is missing.
       */
      errors.push(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return settle();
};
