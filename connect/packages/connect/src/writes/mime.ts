import { MIME_FIELDS, readField, setField } from "@freebirdai/connect-spec";

/**
 * An email as the body of a change: what a person reviewed — to, cc, subject,
 * the text — written as one plain-text message (RFC 5322) and encoded the way
 * the provider takes it. Gmail wants it base64url inside JSON (`raw`);
 * Microsoft Graph takes the base64 message as the whole body.
 *
 * Pure. Every header value has its line breaks taken out, so nothing typed
 * into a field can add a header of its own.
 */

export interface MimeEncoding {
  readonly into?: string | undefined;
  readonly encoding: "base64url" | "base64";
}

export interface MailParts {
  readonly to?: string | undefined;
  readonly cc?: string | undefined;
  readonly bcc?: string | undefined;
  readonly subject?: string | undefined;
  readonly text?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
}

/** One line, whatever was typed: a header cannot be ended early. */
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047: plain ASCII stays as it is; anything else is UTF-8, base64'd. */
const encodeWord = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** Base64 in lines of 76, as a message body is carried. */
const wrapped = (text: string): string => (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");

/** The message as text, headers then body, ready to be encoded. */
export const composeMessage = (parts: MailParts): string => {
  const headers: string[] = [];
  const header = (name: string, value: string | undefined, encode = false): void => {
    const line = value === undefined ? "" : oneLine(value);
    if (line) headers.push(`${name}: ${encode ? encodeWord(line) : line}`);
  };
  header("To", parts.to);
  header("Cc", parts.cc);
  header("Bcc", parts.bcc);
  header("Subject", parts.subject ?? "", true);
  header("In-Reply-To", parts.inReplyTo);
  header("References", parts.references);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  const body = (parts.text ?? "").replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${wrapped(body)}\r\n`;
};

const encode = (message: string, encoding: MimeEncoding["encoding"]): string =>
  Buffer.from(message, "utf8").toString(encoding === "base64url" ? "base64url" : "base64");

/**
 * The body to send: the message fields taken out of the built body and
 * written as one encoded message, at `into` beside whatever else it holds —
 * or, without `into`, as the whole body.
 */
export const encodeMimeBody = (body: Readonly<Record<string, unknown>> | undefined, mime: MimeEncoding): Record<string, unknown> | string => {
  const source = body ?? {};
  const text = (name: string): string | undefined => {
    const value = readField(source, name);
    return value === undefined || value === null ? undefined : String(value);
  };
  const parts: MailParts = Object.fromEntries(MIME_FIELDS.map((name) => [name, text(name)]).filter(([, value]) => value !== undefined));
  const encoded = encode(composeMessage(parts), mime.encoding);
  if (!mime.into) return encoded;
  let out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) if (!(MIME_FIELDS as readonly string[]).includes(key)) out = setField(out, key, value);
  return setField(out, mime.into, encoded);
};
