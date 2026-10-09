/**
 * The renderer for message templates: `{{ name }}` replaced by a value, and
 * nothing else — no conditions, no loops, no code. In HTML every value is
 * escaped; `{{ name | paragraphs }}` escapes it and keeps its blank-line
 * paragraphs and line breaks. A link is built on the server and must start
 * with our own origin before it is ever passed in (`ownLink`).
 */

export interface MessageTemplate {
  readonly name: string;
  /** Every variable it uses, and no other. A test holds the two together. */
  readonly vars: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const VARIABLE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*(?:\|\s*(paragraphs)\s*)?\}\}/g;

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const paragraphs = (value: string): string =>
  value
    .trim()
    .split(/\n\s*\n/)
    .map((one) => `<p style="margin:0 0 14px 0;">${escapeHtml(one.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

/** The variables a template uses, in order of first use. */
export const variablesOf = (template: Pick<MessageTemplate, "subject" | "html" | "text">): string[] => {
  const seen: string[] = [];
  for (const source of [template.subject, template.html, template.text]) {
    for (const match of source.matchAll(VARIABLE)) if (!seen.includes(match[1]!)) seen.push(match[1]!);
  }
  return seen;
};

export class TemplateVariableError extends Error {}

/** Fills one template. A variable it uses that is not given is an error, never a blank. */
export const render = (template: MessageTemplate, vars: Readonly<Record<string, string>>): { readonly subject: string; readonly html: string; readonly text: string } => {
  const missing = variablesOf(template).filter((name) => typeof vars[name] !== "string");
  if (missing.length > 0) throw new TemplateVariableError(`${template.name} needs ${missing.join(", ")}.`);
  const plain = (source: string) => source.replace(VARIABLE, (_all, name: string) => vars[name]!.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
  return {
    subject: plain(template.subject).replace(/\s+/g, " ").trim(),
    html: template.html.replace(VARIABLE, (_all, name: string, filter?: string) => (filter === "paragraphs" ? paragraphs(vars[name]!) : escapeHtml(vars[name]!))),
    text: plain(template.text),
  };
};

/** A link for a message: only one of our own pages, never anything else. */
export const ownLink = (url: string, origin: string): string => {
  const parsed = new URL(url);
  const own = new URL(origin);
  if (parsed.origin !== own.origin) throw new Error("A message may only link to this workspace's own pages.");
  return parsed.toString();
};
