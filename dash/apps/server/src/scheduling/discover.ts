import type { AppointmentType, MatchOutcome } from "@freebirdai/dash-spec";
import type { ContactService } from "../contacts/service.js";
import type { FactKind, Facts } from "./rules.js";
import type { SchedulingService } from "./service.js";
import type { FindSlotsResult } from "./slots.js";

/**
 * Before times are shown or offered: which facts would change them, and how
 * to get each one.
 *
 * 1. The slot engine says which fields kept times out, or made them need
 *    approval, because they were unknown (`needs`). A field whose answer
 *    changes nothing is never in that list, so it is never asked.
 * 2. A contact not linked to any record, missing a field that records fill,
 *    is matched once, and the times worked out again.
 * 3. What is still missing and the field allows asking comes back as
 *    questions; `request.*` fields are asked with the type's own intake
 *    wording. A field the person could answer to their own advantage is not
 *    askable, and neither is one they already answered where a rule wants a
 *    record's value: those are left to each block's "when unknown".
 */

export interface DiscoveryNeed {
  /** "contact.serviceArea", "request.serviceAddress". */
  readonly field: string;
  readonly question: string;
  readonly kind: FactKind;
  readonly choices?: readonly string[];
}

export interface Discovery {
  readonly facts: Facts;
  readonly result: FindSlotsResult;
  /** Questions to ask before showing times. */
  readonly needs: readonly DiscoveryNeed[];
  /** Fields still unknown that may not be asked. */
  readonly unknown: readonly string[];
  /** When a match was tried, what came of it. */
  readonly matched?: MatchOutcome;
}

const words = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

export const discover = async (
  deps: { readonly scheduling: SchedulingService; readonly contacts: ContactService },
  input: {
    readonly type: AppointmentType;
    readonly contact?: string;
    /** Answers given for this booking. */
    readonly request?: Readonly<Record<string, unknown>>;
    readonly range: { readonly from: number; readonly to: number };
  },
): Promise<Discovery> => {
  const { type } = input;
  const factsFor = async (): Promise<Facts> => {
    const base = input.contact ? await deps.contacts.facts(input.contact) : { scope: { contact: {} }, trusted: new Set<string>(), kinds: await deps.contacts.factKinds() };
    return { ...base, scope: { ...base.scope, request: { ...(input.request ?? {}) }, type: { id: type.id, name: type.name } } };
  };
  const { fields: defs } = await deps.contacts.setup();
  const defOf = (path: string) => (path.startsWith("contact.") ? defs.find((def) => def.key === path.split(".")[1]) : undefined);

  let facts = await factsFor();
  let result = await deps.scheduling.slots(type, facts, input.range);
  let matched: MatchOutcome | undefined;

  if (input.contact && result.needs.some((path) => (defOf(path)?.sources.length ?? 0) > 0)) {
    const contact = await deps.contacts.get(input.contact);
    if (contact && contact.links.length === 0) {
      matched = await deps.contacts.match(input.contact);
      if (matched === "linked") {
        facts = await factsFor();
        result = await deps.scheduling.slots(type, facts, input.range);
      }
    }
  }

  const contact = input.contact ? await deps.contacts.get(input.contact) : null;
  const needs = new Map<string, DiscoveryNeed>();
  const unknown = new Set<string>();
  for (const path of result.needs) {
    if (path.startsWith("request.")) {
      const intake = type.intake.find((one) => one.field === path || path.startsWith(`${one.field}.`));
      const field = intake?.field ?? path;
      needs.set(field, { field, question: intake?.ask ?? `What is the ${words(field.split(".").slice(1).join(" "))}?`, kind: "text" });
      continue;
    }
    const def = defOf(path);
    const answered = def ? contact?.fields[def.key]?.person !== undefined : false;
    if (!def || !def.askable || answered) {
      unknown.add(path);
      continue;
    }
    const field = `contact.${def.key}`;
    needs.set(field, { field, question: def.ask ?? `What is your ${def.label.toLowerCase()}?`, kind: def.kind, ...(def.choices ? { choices: def.choices } : {}) });
  }
  return { facts, result, needs: [...needs.values()], unknown: [...unknown], ...(matched ? { matched } : {}) };
};
