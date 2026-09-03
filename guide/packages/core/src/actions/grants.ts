import {
  actionCapability,
  createGrant,
  digest,
  type Capability,
  type Declaration,
  type Grant,
} from "../grants/index.js";

/**
 * Binding a confirmation to the arguments it was given for.
 *
 * The preview card is the whole basis of consent in the action layer: the user
 * sees a summary of what is about to happen and says yes to *that*. Nothing
 * until now tied the execution back to it, so an action whose arguments moved
 * between the preview and the confirm — a later `update_action_args`, a retry
 * that reused the record, a race between two turns — executed on a yes that
 * was given to different numbers.
 *
 * The digest closes that. The host records a grant over the arguments it
 * displayed, and `runAction` refuses to execute anything that no longer
 * hashes the same.
 *
 * Grant over `normalizedArgs` from {@link prepareActionArgs}, never over the
 * raw args: that is the exact value `runAction` executes with, after preflight
 * resolution and schema defaults. Hashing anything earlier in the pipeline
 * would compare two different shapes and reject every legitimate run.
 */

/** Storage seam. Hosts back this with the DbAdapter; tests pass a map. */
export interface ActionGrantPort {
  read(subject: string): Promise<Grant | null> | Grant | null;
}

/**
 * Identity of one confirmation.
 *
 * Scoped by action *and* record so a grant cannot be replayed against a
 * different action that happens to share a record id.
 */
export const actionGrantSubject = (
  componentId: string,
  actionId: string,
  recordId: string,
): string => `action:${componentId}/${actionId}#${recordId}`;

/** Reach a single action execution asks for. */
export const actionGrantDeclaration = (
  componentId: string,
  actionId: string,
): Capability[] => [actionCapability(componentId, actionId)];

/** Build the grant to store when the user confirms a previewed action. */
export const grantForActionArgs = (input: {
  componentId: string;
  actionId: string;
  recordId: string;
  /** `normalizedArgs` from `prepareActionArgs`. */
  normalizedArgs: Record<string, unknown>;
  grantedBy?: string;
  now?: Date;
}): Grant =>
  createGrant({
    subject: actionGrantSubject(input.componentId, input.actionId, input.recordId),
    digest: digest(input.normalizedArgs),
    declaration: actionGrantDeclaration(input.componentId, input.actionId) as Declaration,
    ...(input.grantedBy === undefined ? {} : { grantedBy: input.grantedBy }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
