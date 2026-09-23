import type {
  ApiRhythm,
  CatalogEntry,
  ConnectionRhythm,
  ConnectionSpec,
  EntitySpec,
  TierDecision,
  Volatility,
} from "@freebirdai/dash-spec";
import { RHYTHM_VERSION, tierFor } from "@freebirdai/dash-spec";

/**
 * Turning "new applications arrive all day" into "ask this endpoint again in
 * ten minutes".
 *
 * Two translations, and keeping them apart is what makes each one checkable.
 *
 * **Record type to endpoint.** The model is asked about record types, because
 * that is the vocabulary it can reason in — nobody, model or person, can tell
 * from `externalapiapplicants_getapplicants` how often applications arrive,
 * and they can tell instantly from "Applicants". But a *request* is made to an
 * endpoint, so the rating is projected onto the endpoints that list and open
 * that record type.
 *
 * **Reading to cadence.** Which tier a volatility lands in is data, and what
 * one person moved outranks it. `tierFor` holds that precedence; this holds
 * everything needed to call it.
 */

export interface RhythmInput {
  readonly connection: ConnectionSpec;
  /** The shared reading, from the catalog entry. Absent before the pass runs. */
  readonly api?: ApiRhythm | undefined;
  /**
   * The API's record types, for finding the endpoints behind each rating.
   *
   * A rating is keyed by record type and a record type names the resource it
   * is read through. That the two ids happen to coincide today is how the
   * describing pass works, not a promise — so the projection goes through the
   * record type rather than assuming it.
   */
  readonly entities?: readonly EntitySpec[] | undefined;
  /** This account's cadences and overrides. */
  readonly personal: ConnectionRhythm;
  /**
   * What this account's own pulls showed, by endpoint.
   *
   * Outranks the model and is outranked by the person. Empty until the keeper
   * has watched an endpoint for long enough to have an opinion — which is why
   * the model's guess is worth paying for at all.
   */
  readonly measured?: Readonly<Record<string, Volatility>> | undefined;
}

/**
 * Every endpoint a record type is read through.
 *
 * Both the list and the detail: warming a record type means being able to
 * draw it *and* to open one, and they are separate endpoints with the same
 * answer to "how often does this change".
 */
export const opsOfResource = (
  connection: ConnectionSpec,
  resource: string,
): readonly string[] => {
  const found = connection.resources.find((one) => one.id === resource);
  if (!found) return [];
  return [found.listOp, found.detailOp].filter(
    (op): op is string => typeof op === "string" && connection.ops.some((one) => one.id === op),
  );
};

/**
 * The shared reading, keyed by endpoint rather than by record type.
 *
 * Stored keyed by record type because that is what the model answered about
 * and what survives an endpoint being renamed; projected here because the
 * keeper schedules endpoints. A record type this connection does not carry
 * simply contributes nothing.
 */
export const volatilityByOp = (input: {
  readonly connection: ConnectionSpec;
  readonly api?: ApiRhythm | undefined;
  readonly entities?: readonly EntitySpec[] | undefined;
}): Record<string, Volatility> => {
  const byOp: Record<string, Volatility> = {};
  for (const [recordType, volatility] of Object.entries(input.api?.recordTypes ?? {})) {
    for (const op of opsOfRecordType(input, recordType)) byOp[op] = volatility;
  }
  return byOp;
};

/** And the sentence that came with it, projected the same way. */
export const reasonByOp = (input: {
  readonly connection: ConnectionSpec;
  readonly api?: ApiRhythm | undefined;
  readonly entities?: readonly EntitySpec[] | undefined;
}): Record<string, string> => {
  const byOp: Record<string, string> = {};
  for (const [recordType, because] of Object.entries(input.api?.because ?? {})) {
    for (const op of opsOfRecordType(input, recordType)) byOp[op] = because;
  }
  return byOp;
};

/**
 * The endpoints one record type is read through, on this connection.
 *
 * Through the record type's own resource when the record type is known, and
 * by the same id when it is not — which is what an entry classified before
 * the record types were passed in relies on.
 */
const opsOfRecordType = (
  input: { readonly connection: ConnectionSpec; readonly entities?: readonly EntitySpec[] | undefined },
  recordType: string,
): readonly string[] => {
  const entity = input.entities?.find((one) => one.id === recordType);
  return opsOfResource(input.connection, entity?.resource ?? recordType);
};

/** Where one endpoint lands, with everything that decided it. */
export const decideTier = (input: RhythmInput & { readonly op: string }): TierDecision =>
  decideAll({ ...input, ops: [input.op] })[0]!;

/**
 * Every endpoint this connection carries, with its cadence and its reason.
 *
 * What the setup question is built from, and what the panel shows afterwards.
 * Ordered by record type so the list reads like the API rather than like a
 * hash: the endpoints that belong together sit together.
 */
export const decideAll = (
  input: RhythmInput & { readonly ops: readonly string[] },
): readonly TierDecision[] => {
  const model = volatilityByOp(input);
  const reasons = reasonByOp(input);
  return input.ops.map((op) =>
    tierFor({
      op,
      tiers: input.personal.tiers,
      overrides: input.personal.overrides,
      ...(input.measured?.[op] ? { measured: input.measured[op] } : {}),
      ...(model[op] ? { model: model[op] } : {}),
      ...(reasons[op] ? { because: reasons[op] } : {}),
    }),
  );
};

/**
 * The reading a fresh pass produced, ready to store on the catalog entry.
 *
 * Merged rather than replaced: a pass that covered most of an API is worth
 * keeping, and re-running it should improve what it can without discarding
 * what a previous run settled. The same bargain every other pass here makes.
 */
export const mergeApiRhythm = (
  existing: ApiRhythm | undefined,
  fresh: {
    rhythm: Readonly<Record<string, Volatility>>;
    because: Readonly<Record<string, string>>;
    /** The reading of the API this was made against. See `categoryFingerprint`. */
    fingerprint?: string | undefined;
  },
  now: () => Date = () => new Date(),
): ApiRhythm => {
  const fingerprint = fresh.fingerprint ?? existing?.fingerprint;
  return {
    recordTypes: { ...(existing?.recordTypes ?? {}), ...fresh.rhythm },
    because: { ...(existing?.because ?? {}), ...fresh.because },
    ...(fingerprint ? { fingerprint } : {}),
    at: now().toISOString(),
    version: RHYTHM_VERSION,
  };
};

/** Whether an API has been read for rhythm at all. */
export const hasRhythm = (entry: CatalogEntry): boolean =>
  Object.keys(entry.rhythm?.recordTypes ?? {}).length > 0;
