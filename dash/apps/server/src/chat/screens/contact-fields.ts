import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import { CONTACT_FIELD_KINDS, contactFieldKeySchema, type ContactFieldDef, type ContactMatchRule } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { ContactService } from "../../contacts/service.js";
import { SCREENS, actor, allowedTo, argsOf, blocked, changeRows, findBy, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";

/**
 * Contact fields (`#/agent/contacts/fields`): the facts contacts hold (each
 * field's kind, choices, whether the person may be asked, how far rules trust
 * it, which records it copies from) and the rules that match contacts to
 * records. Saved through `ContactService`, as the tab is.
 */

export interface ContactFieldsDeps extends ScreenAccess {
  readonly contacts: ContactService;
  readonly setup: { readonly fields: readonly ContactFieldDef[]; readonly matchRules: readonly ContactMatchRule[] };
}

const SCREEN = SCREENS.contactFields;
const MANAGE = "Your role here does not allow changing contacts.";

const sourceSchema = z
  .object({
    connection: z.string().min(1).describe("The connection's id."),
    entity: z.string().min(1).describe("The record type."),
    field: z.string().trim().min(1).max(200).describe("A path in the record, like address.zip."),
    map: z.record(z.string()).optional().describe("The API's values to ours, like { A: 'existing' }."),
  })
  .strict();

const fieldChange = z.object({
  field: z.string().min(1).describe("The field, by key or label; a new key makes a new field (letters, digits and underscores, starting with a letter)."),
  label: z.string().trim().min(1).max(80).optional().describe("Its name on screen."),
  kind: z.enum(CONTACT_FIELD_KINDS).optional().describe("What it holds: text, choice, address, email, phone, number, date or boolean."),
  choices: z.array(z.string().trim().min(1).max(80)).max(100).optional().describe("A choice field's choices. Replaces the list."),
  askable: z.boolean().optional().describe("Whether the person may be asked for it. Off for anything they could answer to their own advantage."),
  ask: z.string().trim().max(200).optional().describe("How to ask, like 'What's the address of the visit?'"),
  trust: z.enum(["any", "record"]).optional().describe("Whether rules count any value, or only a record's or a member's."),
  sources: z.array(sourceSchema).max(10).optional().describe("Records it copies from. Replaces the list."),
});
type FieldChange = z.infer<typeof fieldChange>;

const ruleChange = z.object({
  rule: z.string().optional().describe("The rule's id, from list_contact_setup, to change it. Left out: a new rule."),
  connection: z.string().min(1).describe("The connection whose records to match."),
  entity: z.string().min(1).describe("The record type."),
  on: z
    .array(z.object({ contact: z.string().trim().min(1).max(60).describe("email, phone or a field key."), record: z.string().trim().min(1).max(200).describe("A path in the record.") }).strict())
    .min(1)
    .max(3)
    .describe("What equals what: the contact's email, phone or field, and the record's field."),
});
type RuleChange = z.infer<typeof ruleChange>;

const LABELS = { label: "Name", kind: "Holds", choices: "Choices", askable: "May be asked", ask: "Asked as", trust: "Rules count", sources: "Copies from" } as const;

export const contactFieldsScreen = (deps: ContactFieldsDeps): ComponentDefinition => {
  const { contacts, setup } = deps;
  const manage = allowedTo(deps, "contacts.manage", MANAGE);
  const findField = (fields: readonly ContactFieldDef[], key: string) => findBy(fields, key, (one) => [one.key, one.label]);

  const list: ActionDefinition<Record<string, never>, unknown, unknown> = {
    id: "list_contact_setup",
    description: "Read the contact fields (kind, choices, asking, trust, sources) and the match rules, with their ids.",
    schema: z.object({}),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: allowedTo(deps, "records.read", "Your role here does not allow reading contacts."),
    handler: async () => contacts.setup(),
  };

  const setField: ActionDefinition<FieldChange, unknown, unknown> = {
    id: "set_contact_field",
    description: "Make or change a contact field: its name, kind, choices, whether people may be asked for it and how, how far rules trust it, and which records it copies from. Shown on a card first.",
    schema: argsOf<FieldChange>(fieldChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findField(setup.fields, args.field);
      if (held) return { ok: true, resolvedArgs: { field: held.key } };
      const key = contactFieldKeySchema.safeParse(args.field);
      if (!key.success) return blocked("field", `"${args.field}" is not a field here, and not a key a new one can take: ${key.error.issues[0]?.message ?? "letters, digits and underscores"}. Fields: ${listed(setup.fields.map((one) => one.label))}.`);
      if (!args.label) return blocked("label", "Give the new field a name.");
      if ((args.kind ?? "text") === "choice" && !(args.choices?.length)) return blocked("choices", "A choice field needs its choices.");
      return { ok: true };
    },
    preview: (args) => {
      const held = findField(setup.fields, args.field);
      return {
        title: held ? `Change the contact field "${held.label}"` : `Add the contact field "${args.label ?? args.field}"`,
        summary: held ? "Only these change." : `Key: ${args.field}.`,
        rows: changeRows((Object.keys(LABELS) as Array<keyof typeof LABELS>).map((key) => ({ label: LABELS[key], before: held?.[key], after: args[key], isNew: !held, words: key === "sources" ? (value: unknown) => ((value as ContactFieldDef["sources"]) ?? []).map((one) => `${one.connection} ${one.entity}.${one.field}`).join(", ") || "None" : shown }))),
      };
    },
    handler: async (args) => {
      const { fields } = await contacts.setup();
      const held = findField(fields, args.field);
      const key = held?.key ?? args.field;
      const { key: _key, createdAt: _created, updatedAt: _updated, ...kept } = held ?? ({ kind: "text", askable: false, trust: "any", sources: [] } as Partial<ContactFieldDef>);
      const input = { ...kept, ...Object.fromEntries(Object.entries(args).filter(([name, value]) => name !== "field" && value !== undefined)) };
      const saved = await contacts.putField(key, input);
      deps.changed();
      return landed({ saved: true, key: saved.key }, SCREEN, { title: saved.label, item: saved.key, summary: `${held ? "Changed" : "Added"} the contact field "${saved.label}".` });
    },
  };

  const removeField: ActionDefinition<{ field: string }, unknown, unknown> = {
    id: "remove_contact_field",
    description: "Remove a contact field. Refused while a match rule matches on it. Shown on a card first.",
    schema: z.object({ field: z.string().min(1).describe("The field, by key or label.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      const held = findField(setup.fields, args.field);
      return held ? { ok: true, resolvedArgs: { field: held.key } } : blocked("field", `There is no field "${args.field}". Fields: ${listed(setup.fields.map((one) => one.label))}.`);
    },
    preview: (args) => ({ title: `Remove the contact field "${findField(setup.fields, args.field)?.label ?? args.field}"`, summary: "Rules and questions that use it stop finding a value.", rows: [] }),
    handler: async (args) => {
      const held = findField((await contacts.setup()).fields, args.field);
      if (!held) throw new Error(`There is no field "${args.field}" any more.`);
      await contacts.removeField(held.key);
      deps.changed();
      return landed({ removed: true, key: held.key }, SCREEN, { title: "Contact fields", summary: `Removed the contact field "${held.label}".` });
    },
  };

  const setRule: ActionDefinition<RuleChange, unknown, unknown> = {
    id: "set_match_rule",
    description: "Make or change a rule that matches contacts to records in a connected account: which of the contact's keys equals which field of the record. Matching reads as you. Shown on a card first.",
    schema: argsOf<RuleChange>(ruleChange),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      if (args.rule && !setup.matchRules.some((one) => one.id === args.rule)) return blocked("rule", `There is no match rule "${args.rule}". list_contact_setup shows them.`);
      const keys = new Set(["email", "phone", ...setup.fields.map((one) => one.key)]);
      const unknown = args.on.filter((pair) => !keys.has(pair.contact)).map((pair) => pair.contact);
      if (unknown.length > 0) return blocked("on", `There is no contact field ${unknown.map((one) => `"${one}"`).join(", ")}. Match on email, phone or: ${listed(setup.fields.map((one) => one.key))}.`);
      return { ok: true };
    },
    preview: (args) => {
      const held = args.rule ? setup.matchRules.find((one) => one.id === args.rule) : undefined;
      const words = (rule: Pick<ContactMatchRule, "connection" | "entity" | "on">) => `${rule.connection} ${rule.entity}: ${rule.on.map((pair) => `${pair.contact} = ${pair.record}`).join(" and ")}`;
      return { title: held ? "Change a match rule" : "Add a match rule", summary: "Contacts are matched to exactly one record; several leave a pick.", rows: [{ label: "Matches", value: held ? `${words(held)} → ${words(args)}` : words(args) }] };
    },
    handler: async (args, ctx) => {
      const saved = await contacts.putMatchRule(args.rule ?? null, { connection: args.connection, entity: args.entity, on: args.on }, actor(ctx));
      deps.changed();
      return landed({ saved: true, id: saved.id }, SCREEN, { title: "Match rules", item: saved.id, summary: `${args.rule ? "Changed" : "Added"} the match rule for ${saved.connection} ${saved.entity}.` });
    },
  };

  const removeRule: ActionDefinition<{ rule: string }, unknown, unknown> = {
    id: "remove_match_rule",
    description: "Remove a match rule. Contacts already linked stay linked. Shown on a card first.",
    schema: z.object({ rule: z.string().min(1).describe("The rule's id, from list_contact_setup.") }),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => (setup.matchRules.some((one) => one.id === args.rule) ? { ok: true } : blocked("rule", `There is no match rule "${args.rule}".`)),
    preview: (args) => {
      const held = setup.matchRules.find((one) => one.id === args.rule);
      return { title: "Remove a match rule", summary: "Contacts already linked stay linked.", rows: held ? [{ label: "Matched", value: `${held.connection} ${held.entity}: ${held.on.map((pair) => `${pair.contact} = ${pair.record}`).join(" and ")}` }] : [] };
    },
    handler: async (args) => {
      await contacts.removeMatchRule(args.rule);
      deps.changed();
      return landed({ removed: true, id: args.rule }, SCREEN, { title: "Match rules", summary: "Removed the match rule." });
    },
  };

  return screenComponent(
    SCREEN,
    [`CONTACT FIELDS: ${listed(setup.fields.map((one) => `${one.label} (${one.key}, ${one.kind})`), 40)}. MATCH RULES: ${listed(setup.matchRules.map((one) => `${one.id}: ${one.connection} ${one.entity}`), 20)}.`],
    [list, setField, removeField, setRule, removeRule],
  );
};
