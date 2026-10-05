import { briefCandidates, describeEntities, inferShape, resolveCandidate, writeBrief, type LlmAdapter } from "@freebirdai/dash-agent";
import {
  compileBrief,
  entityById,
  filterParamsOf,
  readsRangeOf,
  getOp,
  observeEntity,
  rerootBrief,
  type WidgetBrief,
  type CatalogEntry,
  type ConnectionSpec,
  type EntitySpec,
  type WidgetSpec,
} from "@freebirdai/dash-spec";
import { seenByRecordType, type SeenSet } from "@freebirdai/connect/integrate/values";

/**
 * Choosing what answers an objective, the way the product does — unscripted.
 *
 * The same steps a person's request goes through, in the same order:
 * 1. the API's record types are described from the documentation (the
 *    `entity` pass that runs after an API is mapped);
 * 2. the request becomes a brief over those record types (`writeBrief`, the
 *    widget task);
 * 3. the brief is compiled into a widget (`compileBrief`), which fixes the
 *    endpoint, the fields and the calculation deterministically.
 *
 * Nothing here knows the answer key, the scripted choice, or anything about a
 * provider beyond what discovery read. Where the product cannot express what
 * an objective asks — a record type with no declared fields, a narrowing a
 * number cannot carry — this fails exactly as the product would, and the
 * failure is the measurement.
 *
 * Two simplifications, both said here so a result is read correctly: the
 * relation-mapping and reference passes are not run (they matter only to a
 * brief joining two record types, which no objective asks for yet), and the
 * brief is compiled without the rest of the API as `related`.
 */

export type BriefChoice =
  | {
      readonly widget: WidgetSpec;
      /** The endpoints the widget reads: what the integration loop settles. */
      readonly ops: readonly string[];
      readonly entities: readonly EntitySpec[];
      /** What was compiled, so it can be compiled again once a read has been observed. */
      readonly brief: WidgetBrief;
      readonly entity: EntitySpec;
      readonly notes: readonly string[];
      readonly modelCalls: number;
    }
  | { readonly stop: string; readonly why: string; readonly notes: readonly string[]; readonly modelCalls: number };

/** The list's path for the compiler's check, as the server gives it: none where connector code supplies the ids. */
const listPathOf = (connection: ConnectionSpec, op: string | undefined): string | undefined => {
  const found = op ? connection.ops.find((one) => one.id === op) : undefined;
  return found && found.servedBy !== "connector" ? found.path : undefined;
};

const opsOf = (widget: WidgetSpec): string[] => [
  ...new Set([
    ...(widget.source ? [widget.source.op] : []),
    ...(widget.sources ?? []).map((source) => source.op),
  ]),
];

export const chooseByBrief = async (input: {
  readonly connection: ConnectionSpec;
  readonly entry: CatalogEntry;
  readonly request: string;
  readonly llm: LlmAdapter;
  /** Today, for the benchmark's own clock. */
  readonly today?: string;
  /** What the first check's reads showed the records hold, by endpoint — as the product keeps it per connection. */
  readonly seen?: Readonly<Record<string, SeenSet>>;
}): Promise<BriefChoice> => {
  const { connection, entry, llm } = input;
  const notes: string[] = [];
  let modelCalls = 0;
  const counted: LlmAdapter = {
    ...llm,
    generate: (options) => {
      modelCalls++;
      return llm.generate(options);
    },
  };

  /* 1. Record types, from what the documentation declares — as the product describes them. */
  const ops = entry.ops.map((op) => ({
    id: op.id,
    title: op.title,
    path: op.path,
    ...(op.description ? { description: op.description } : {}),
    ...(op.fields ? { fields: op.fields } : {}),
  }));
  const described = await describeEntities(counted, { apiTitle: entry.title, resources: entry.resources, ops });
  notes.push(...described.errors.map((one) => `Describing record types: ${one}`));
  const entities = described.entities;
  if (entities.length === 0)
    return {
      stop: "describe",
      why: `No record types could be described: ${entry.resources.length} resource(s), none with fields the documentation declares.`,
      notes,
      modelCalls,
    };
  notes.push(`Record types described: ${entities.map((one) => one.name.many).join(", ")}.`);
  /* Which fields each carries, so a brief naming one that is not there can be diagnosed from the record. */
  for (const one of entities)
    notes.push(`${one.name.many} (${one.id}): ${one.fields.map((field) => `${field.path}${field.label && field.label !== field.path ? ` "${field.label}"` : ""}`).join(", ").slice(0, 600)}`);

  /* 2. The request, as a brief over those record types. */
  const seen = seenByRecordType(connection, entities, input.seen ?? {});
  for (const [recordType, one] of Object.entries(seen))
    notes.push(
      `Seen in ${one.everyRecord ? "every one" : "some"} of ${recordType}'s records: ${Object.entries(one.fields).map(([path, values]) => `${path} = ${values.join(" / ")}`).join("; ").slice(0, 600)}`,
    );
  const candidates = briefCandidates([{ connection: connection.id, title: connection.title, entities, seen }], { request: input.request });
  const written = await writeBrief(counted, { intent: input.request, candidates, ...(input.today ? { today: input.today } : {}) });
  if (!written.brief)
    return {
      stop: "choose",
      why: written.unmatched
        ? `No record type here is what the request is about: ${written.unmatched}`
        : (written.error ?? "No brief was written for the request."),
      notes,
      modelCalls,
    };
  notes.push(`Brief: ${JSON.stringify(written.brief)}. The model said: ${written.reason}`);

  /* 3. Compiled, exactly as the brief route compiles it. */
  const candidate = resolveCandidate(candidates, written.brief.entity);
  const entity = entityById(entities, candidate?.recordType ?? written.brief.entity);
  const resource = entity ? connection.resources.find((one) => one.id === entity.resource) : undefined;
  if (!entity || !resource)
    return { stop: "choose", why: "The brief named a record type this connection does not carry.", notes, modelCalls };
  const compiled = compileBrief({
    brief: { ...written.brief, entity: entity.id },
    entity,
    resource,
    connection: connection.id,
    listPath: listPathOf(connection, resource.listOp),
    rowsPathOf: (op) => getOp(connection, op)?.rowsPath,
    filterParamOf: filterParamsOf(connection),
    readsRange: readsRangeOf(connection),
    id: "objective",
  });
  notes.push(...compiled.notes.map((one) => `Compiling the brief: ${one}`));
  if (!compiled.widget)
    return { stop: "build", why: `The brief did not compile: ${compiled.errors.join("; ")}`, notes, modelCalls };
  return {
    widget: compiled.widget,
    ops: opsOf(compiled.widget),
    entities,
    brief: { ...written.brief, entity: entity.id },
    entity,
    notes,
    modelCalls,
  };
};

/**
 * What the product does when a read lands: tell the record type what its
 * fields really hold, and rebuild the widget if that changed how it reads.
 *
 * The same two steps as `observeConnection` and `recompileReadings` in the
 * server. A record the documentation describes flat can arrive wrapped
 * (`{ lease: { … } }`), and a flag declared boolean can arrive as 0 or 1; the
 * record type moves to where the fields really are, and the brief with it.
 * Without this the benchmark would measure a product that never looked at its
 * own first read, which is not the product.
 */
export const observeFirstRead = (input: {
  readonly connection: ConnectionSpec;
  readonly brief: WidgetBrief;
  readonly entity: EntitySpec;
  readonly opId: string;
  readonly body: unknown;
  readonly at: string;
}): { readonly widget: WidgetSpec; readonly notes: readonly string[] } | null => {
  const rowsPath = getOp(input.connection, input.opId)?.rowsPath;
  const shape = inferShape(input.body, rowsPath ? { rowsPath } : {});
  if (shape.fields.length === 0) return null;
  const observed = observeEntity(input.entity, shape.fields, input.at);
  if (observed === input.entity) return null;
  const { wrapped, ...entity } = observed;
  const resource = input.connection.resources.find((one) => one.id === entity.resource);
  if (!resource) return null;
  const compiled = compileBrief({
    brief: wrapped ? rerootBrief(input.brief, wrapped) : input.brief,
    entity,
    resource,
    connection: input.connection.id,
    listPath: listPathOf(input.connection, resource.listOp),
    rowsPathOf: (op) => getOp(input.connection, op)?.rowsPath,
    filterParamOf: filterParamsOf(input.connection),
    readsRange: readsRangeOf(input.connection),
    id: "objective",
  });
  if (!compiled.widget) return null;
  return {
    widget: compiled.widget,
    notes: [
      `Observed the first read${wrapped ? `: each record arrives wrapped in "${wrapped}", so the record type moved inside it` : ""}; the widget was rebuilt.`,
      ...compiled.notes.map((one) => `Compiling the brief: ${one}`),
    ],
  };
};
