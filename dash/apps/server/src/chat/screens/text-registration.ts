import { readFileSync } from "node:fs";
import type { ActionDefinition, ComponentDefinition } from "@freebirdai/core";
import { OPT_IN_METHODS, REGISTRATION_STEP_WORDS, type RegistrationDraftView } from "@freebirdai/dash-spec";
import { z } from "zod";
import type { PhoneLines } from "../../phone/lines.js";
import { RegistrationError, type DraftSource, type RegistrationService } from "../../phone/registration.js";
import { SCREENS, allowedTo, argsOf, blocked, landed, listed, screenComponent, shown, type ScreenAccess } from "./common.js";

/**
 * Text registration (`text-registration`): the six-step wizard as the chat
 * knows it. The knowledge pack (`phone/knowledge/text-registration.md`, a
 * draft until the reviewed pack replaces it) is the screen's knowledge;
 * the live draft (EIN masked), the failing checks and what the description
 * was drafted from are read on demand (`read_draft`), so the prefix the
 * chat caches does not change as the person types.
 *
 * What the chat may do goes through the wizard's own service:
 *
 * - `read_draft`, `explain_field`, `check_draft`, `explain_rejection`: read.
 * - `redraft_use`: writes a new proposal into the drafted box; the person
 *   ticks "Use this" in the wizard.
 * - `fill_field`: puts a value the person said into a non-sensitive field,
 *   on an approval card.
 *
 * What it will not do: take an EIN, the legal name or other tax details
 * (it points to the field), submit (only the Submit button does), quote fees
 * or waits as fixed, or give legal advice.
 */

export interface TextRegistrationDeps extends ScreenAccess {
  readonly registration: RegistrationService;
  readonly lines: Pick<PhoneLines, "all">;
  readonly sources: () => Promise<DraftSource[]>;
}

const SCREEN = SCREENS.textRegistration;
const MANAGE = "Your role here does not allow changing phone lines.";

/** The knowledge pack, by its `## ` sections. Read once. */
export const KNOWLEDGE_PACK = (() => {
  try {
    const text = readFileSync(new URL("../../phone/knowledge/text-registration.md", import.meta.url), "utf8");
    return text
      .replace(/<!--[\s\S]*?-->/g, "")
      .split(/^## /m)
      .map((part, index) => (index === 0 ? part.trim() : `## ${part.trim()}`))
      .filter(Boolean);
  } catch {
    return ["The text registration knowledge pack could not be read; answer from the wizard's own words and the checks."];
  }
})();

/** What each field is and why the registry needs it, for `explain_field`. */
export const FIELD_HELP: Readonly<Record<string, string>> = {
  legalName: "The business's legal name exactly as on its IRS letter (CP 575 or 147C). The registry matches it to the EIN character for character. Type it in the field, not in the chat.",
  businessType: "LLC, corporation, partnership, nonprofit, or sole proprietor. A business with no EIN picks sole proprietor: it registers with the owner's details and is limited to one campaign and lower volume.",
  ein: "The nine-digit federal tax number on the IRS letter. It is sealed as soon as it is typed and shown only as its last four digits. Type it in the field on step 1; the chat never takes it.",
  street: "The business's address as registered. The registry checks it.",
  website: "The business's own website, on https, showing the same business name. Reviewers open it.",
  industry: "What the business does, in a word or two, like Home services or Healthcare.",
  contactName: "The person responsible for the texting. The registry may contact them.",
  contactEmail: "An email the responsible person reads.",
  use: "The campaign use: the kind of texting, from the registry's list for this business. Reminders and confirmations are Account notifications; offers are Marketing; several kinds are Mixed.",
  description: "Who you text, why, and how often, in two or three plain sentences. It is what reviewers compare the samples and the texts you send against.",
  samples: "Two to five real examples of what you will send. Name the business in one, mark templated parts in brackets like [first name], and end one with \"Reply STOP to opt out\". No link shorteners.",
  frequency: "How often a person gets texts, in plain words, like \"one or two per appointment\".",
  containsLinks: "Whether any text will carry a link. It must match the samples.",
  containsPhoneNumbers: "Whether any text will carry a phone number. It must match the samples.",
  optInMethods: "Where people agree to texts: a website form, the booking page's box, in person, or texting a keyword.",
  optInDescription: "How people agree, step by step, as a reviewer would see it: where the box is and what it says.",
  pageUrl: "The opt-in page. Dash can host one, or place the form on your own site; reviewers check your own site, so that is recommended.",
  privacyUrl: "The privacy policy. It must say mobile numbers are not shared or sold.",
  termsUrl: "The messaging terms: what you text, how often, STOP, HELP and that rates may apply.",
  confirmed: "On step 5 you confirm the legal name and EIN are exactly as on the IRS letter. Only you can.",
};

/** Fields the chat may fill when the person says the value: never the legal name, the EIN or a confirmation. */
const FILLABLE: Readonly<Record<string, { readonly path: readonly [string, string]; readonly schema: z.ZodTypeAny }>> = {
  website: { path: ["business", "website"], schema: z.string().url().max(500) },
  industry: { path: ["business", "industry"], schema: z.string().trim().min(1).max(100) },
  street: { path: ["business", "street"], schema: z.string().trim().min(1).max(200) },
  city: { path: ["business", "city"], schema: z.string().trim().min(1).max(100) },
  region: { path: ["business", "region"], schema: z.string().trim().min(1).max(100) },
  postalCode: { path: ["business", "postalCode"], schema: z.string().trim().min(1).max(20) },
  contactName: { path: ["contact", "name"], schema: z.string().trim().min(1).max(200) },
  contactTitle: { path: ["contact", "title"], schema: z.string().trim().min(1).max(100) },
  contactEmail: { path: ["contact", "email"], schema: z.string().email().max(320) },
  contactPhone: { path: ["contact", "phone"], schema: z.string().trim().min(7).max(20) },
  use: { path: ["campaign", "use"], schema: z.string().trim().min(1).max(80) },
  description: { path: ["campaign", "description"], schema: z.string().trim().min(1).max(4096) },
  frequency: { path: ["campaign", "frequency"], schema: z.string().trim().min(1).max(500) },
  containsLinks: { path: ["campaign", "containsLinks"], schema: z.boolean() },
  containsPhoneNumbers: { path: ["campaign", "containsPhoneNumbers"], schema: z.boolean() },
  optInDescription: { path: ["optIn", "description"], schema: z.string().trim().min(1).max(2048) },
  optInMethods: { path: ["optIn", "methods"], schema: z.array(z.enum(OPT_IN_METHODS)).min(1) },
};

/** Never through the chat: point to the field instead. */
const NEVER = new Set(["ein", "legalName", "confirmed", "businessType"]);

const lineArg = z.string().optional().describe("The phone line's id. Left out: the only line there is.");

export const textRegistrationScreen = (deps: TextRegistrationDeps): ComponentDefinition => {
  const { registration } = deps;
  const read = allowedTo(deps, "records.read", "Your role here does not allow reading phone lines.");
  const manage = allowedTo(deps, "connections.manage", MANAGE);

  /** The line meant: the one named, or the only one. */
  const lineOf = (named: string | undefined): string | null => {
    const lines = deps.lines.all();
    if (named) return lines.some((one) => one.id === named) ? named : null;
    return lines.length === 1 ? lines[0]!.id : null;
  };
  const needLine = (named: string | undefined) => {
    const line = lineOf(named);
    if (line) return { ok: true as const, resolvedArgs: { line } };
    const lines = deps.lines.all();
    return blocked("line", lines.length === 0 ? "There is no phone line yet: add one in Comms first." : `Which line? ${listed(lines.map((one) => `${one.phone.number ?? one.title} (${one.id})`))}.`);
  };

  const readDraft: ActionDefinition<{ line?: string }, unknown, unknown> = {
    id: "read_draft",
    description: "Read a line's registration draft as it stands (the EIN masked), the step and field the person is on, the checks that fail, where the submission stands, and what in the workspace sends texts.",
    schema: z.object({ line: lineArg }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    preflight: async (args) => needLine(args.line),
    handler: async (args) => {
      const line = lineOf(args.line)!;
      const draft = await registration.view(line);
      const problems = await registration.check(line).catch(() => []);
      return { draft, step: REGISTRATION_STEP_WORDS[draft.step], problems, textsFrom: (await deps.sources()).map((one) => `${one.kind}: ${one.name}`) };
    },
  };

  const explainField: ActionDefinition<{ field: string; line?: string }, unknown, unknown> = {
    id: "explain_field",
    description: "Say what a wizard field is and why the registry needs it, with what the person has filled in so far (never the EIN). For 'what is this?' about the focused field.",
    schema: z.object({ field: z.string().min(1).describe(`The field: ${Object.keys(FIELD_HELP).join(", ")}.`), line: lineArg }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    preflight: async (args) => (FIELD_HELP[args.field] ? { ok: true } : blocked("field", `There is no field "${args.field}". Fields: ${listed(Object.keys(FIELD_HELP), 30)}.`)),
    handler: async (args) => {
      const line = lineOf(args.line);
      const draft: RegistrationDraftView | null = line ? await registration.view(line) : null;
      const now = draft ? valueOf(draft, args.field) : undefined;
      return { field: args.field, help: FIELD_HELP[args.field], ...(now !== undefined ? { now: shown(now) } : {}) };
    },
  };

  const checkDraft: ActionDefinition<{ line?: string }, unknown, unknown> = {
    id: "check_draft",
    description: "Run the pre-submit checks on the draft and say, for each that fails, what is wrong and which field fixes it. Submits nothing.",
    schema: z.object({ line: lineArg }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    preflight: async (args) => needLine(args.line),
    handler: async (args) => {
      const problems = await registration.check(lineOf(args.line)!);
      return problems.length === 0 ? { ready: true, note: "Every check passes. Only the Submit button on step 5 submits it." } : { ready: false, problems: problems.map((one) => ({ ...one, step: REGISTRATION_STEP_WORDS[one.step] })) };
    },
  };

  const explainRejection: ActionDefinition<{ code: string; line?: string }, unknown, unknown> = {
    id: "explain_rejection",
    description: "Turn a registry rejection code into its cause and the field that fixes it.",
    schema: z.object({ code: z.string().min(1).max(40).describe("The code on the timeline, like 30794."), line: lineArg }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: read,
    preflight: async (args) => needLine(args.line),
    handler: async (args) => registration.explain(lineOf(args.line)!, args.code),
  };

  const redraft: ActionDefinition<{ instructions?: string; line?: string }, unknown, unknown> = {
    id: "redraft_use",
    description: "Write a new use description and sample messages from the workspace's texting workflows and agents, and the person's words. It is only a proposal: it appears in the wizard's drafted box, and goes into the registration only when the person ticks Use this there.",
    schema: z.object({ instructions: z.string().max(1000).optional().describe("What the person asked for, in their words."), line: lineArg }),
    requiresConfirmation: "none",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => needLine(args.line),
    handler: async (args) => {
      const line = lineOf(args.line)!;
      const view = await registration.draftUse(line, args.instructions);
      const drafted = view.campaign.drafted;
      return landed(
        drafted ? { proposed: true, from: drafted.from, description: drafted.description, samples: drafted.samples, note: "Proposed in the wizard's drafted box. Tick Use this there to use it." } : { proposed: false, note: "Nothing in the workspace sends texts yet, so there is nothing to draft from: the box stays blank." },
        SCREEN,
        { title: "Text registration", summary: "A new draft of the use description is waiting in step 3.", item: line, field: "description" },
      );
    },
  };

  const fill: ActionDefinition<{ field: string; value: unknown; line?: string }, unknown, unknown> = {
    id: "fill_field",
    description: "Put a value the person said into one non-sensitive wizard field. Never the EIN, the legal name, the business type or a confirmation: point to those fields instead. Shown on a card first.",
    schema: argsOf<{ field: string; value: unknown; line?: string }>(
      z.object({ field: z.string().min(1).describe(`One of: ${Object.keys(FILLABLE).join(", ")}.`), value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe("The value, as the person said it."), line: lineArg }),
    ),
    requiresConfirmation: "preview",
    mcp: { expose: false },
    authorize: manage,
    preflight: async (args) => {
      if (NEVER.has(args.field)) return blocked("field", `The chat never takes the ${args.field === "ein" ? "EIN" : args.field === "legalName" ? "legal name" : args.field}: type it in its field on step ${args.field === "confirmed" ? "5" : "1"}, so it stays out of the chat history.`);
      const target = FILLABLE[args.field];
      if (!target) return blocked("field", `The chat cannot fill "${args.field}". It can fill: ${listed(Object.keys(FILLABLE), 30)}.`);
      const valid = target.schema.safeParse(args.value);
      if (!valid.success) return blocked("value", `That is not a value "${args.field}" takes: ${valid.error.issues[0]?.message ?? "check it"}.`);
      const line = needLine(args.line);
      return line.ok ? { ok: true, resolvedArgs: { ...line.resolvedArgs, value: valid.data } } : line;
    },
    preview: (args) => ({ title: `Fill "${args.field}" in the text registration`, summary: "Only this field changes. Nothing is submitted.", rows: [{ label: args.field, value: shown(args.value), multiline: String(args.value).length > 60 }] }),
    handler: async (args) => {
      const target = FILLABLE[args.field];
      if (!target || NEVER.has(args.field)) throw new RegistrationError(`The chat cannot fill "${args.field}".`, 403);
      const line = lineOf(args.line);
      if (!line) throw new RegistrationError("Which line?", 400);
      const [section, key] = target.path;
      await registration.save(line, { [section]: { [key]: target.schema.parse(args.value) } });
      deps.changed();
      return landed({ filled: true, field: args.field }, SCREEN, { title: "Text registration", summary: `Filled "${args.field}".`, item: line, field: args.field });
    },
  };

  return screenComponent(SCREEN, KNOWLEDGE_PACK, [readDraft, explainField, checkDraft, explainRejection, redraft, fill]);
};

/** A field's value on the draft, by the wizard's field names. */
const valueOf = (draft: RegistrationDraftView, field: string): unknown => {
  if (field === "ein") return draft.business.ein;
  const target = FILLABLE[field];
  if (target) {
    const [section, key] = target.path;
    return (draft as unknown as Record<string, Record<string, unknown>>)[section]?.[key];
  }
  if (field === "legalName") return draft.business.legalName;
  if (field === "businessType") return draft.business.businessType;
  if (field === "samples") return draft.campaign.samples;
  if (field === "pageUrl" || field === "privacyUrl" || field === "termsUrl") return draft.optIn[field];
  if (field === "confirmed") return draft.confirmed;
  return undefined;
};
