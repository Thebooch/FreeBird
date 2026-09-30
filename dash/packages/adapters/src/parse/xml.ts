/**
 * XML, read into the same plain values JSON gives (plan, track A).
 *
 * Hand-rolled and small on purpose, like `@freebirdai/dash-expr`: an API's
 * answer is untrusted input, and the dangerous parts of XML are the parts a
 * data answer never needs. So there is no DTD processing at all — a DOCTYPE is
 * stepped over, its entity declarations never read — and the only entities
 * expanded are the five XML defines and numeric character references. An
 * entity bomb is therefore a string of `&name;` left as written, and an
 * external entity is never fetched because nothing here can fetch.
 *
 * What comes out:
 * - an element holding only text is that text — a number where it is plainly
 *   one, `true`/`false`, otherwise a string; empty (or `xsi:nil`) is null;
 * - an element holding elements is an object; a name that repeats is a list;
 * - attributes are fields like any other — `id="7"` is `id` — and text beside
 *   them or beside elements is `value`; only where an element of the same name
 *   is already there do they take the names `@id` and `#text`, so nothing is
 *   ever overwritten;
 * - namespace prefixes and declarations are dropped: `ns2:item` is `item`;
 * - a SOAP envelope is opened: the answer is what its Body holds, and a Fault
 *   is an error, said in the fault's own words.
 */

export class XmlError extends Error {
  /** A SOAP Fault's own message, where that is what went wrong. */
  readonly fault?: string;
  constructor(message: string, fault?: string) {
    super(message);
    this.name = "XmlError";
    if (fault !== undefined) this.fault = fault;
  }
}

const MAX_DEPTH = 200;
/** Long digit strings are ids, and lose digits as numbers. */
const NUMBER = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,15})?$/;

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The five entities XML defines, and character references. Anything else is left as written. */
const decode = (text: string): string =>
  text.includes("&")
    ? text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,20});/g, (whole, name: string) => {
        if (name.startsWith("#")) {
          const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
          return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
            ? String.fromCodePoint(code)
            : whole;
        }
        return NAMED[name] ?? whole;
      })
    : text;

const scalar = (raw: string): unknown => {
  const text = raw.trim();
  if (text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  return NUMBER.test(text) ? Number(text) : text;
};

/** `ns:name` → `name`. */
const local = (name: string): string => {
  const at = name.indexOf(":");
  return at < 0 ? name : name.slice(at + 1);
};

interface Open {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  readonly children: Map<string, unknown[]>;
  text: string;
  nil: boolean;
}

const close = (node: Open): unknown => {
  if (node.nil) return null;
  const attributes = Object.entries(node.attributes);
  if (node.children.size === 0 && attributes.length === 0) return scalar(node.text);
  const out: Record<string, unknown> = {};
  for (const [name, values] of node.children) out[name] = values.length === 1 ? values[0] : values;
  for (const [name, value] of attributes) out[name in out ? `@${name}` : name] = value;
  if (node.text.trim() !== "") out["value" in out ? "#text" : "value"] = scalar(node.text);
  return out;
};

const NAME = /[^\s/>=]+/y;
const SPACE = /\s*/y;

/** Parse one XML document into plain values: `{ root: … }`. */
export const parseXml = (source: string): unknown => {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const stack: Open[] = [];
  let root: { name: string; value: unknown } | null = null;
  let i = 0;

  const fail = (message: string): never => {
    throw new XmlError(`${message} (at character ${i})`);
  };
  const skipTo = (end: string, from: number): number => {
    const at = text.indexOf(end, from);
    if (at < 0) fail(`an unclosed "${end}" section`);
    return at + end.length;
  };
  const addText = (value: string): void => {
    const top = stack[stack.length - 1];
    if (top) top.text += value;
    else if (value.trim() !== "") fail("text outside the document's element");
  };
  const emit = (name: string, value: unknown): void => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (root) fail("more than one top element");
      root = { name, value };
      return;
    }
    const list = parent.children.get(name);
    if (list) list.push(value);
    else parent.children.set(name, [value]);
  };

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      addText(decode(text.slice(i)));
      break;
    }
    if (lt > i) addText(decode(text.slice(i, lt)));
    i = lt;
    if (text.startsWith("<!--", i)) {
      i = skipTo("-->", i + 4);
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) fail("an unclosed CDATA section");
      addText(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      i = skipTo("?>", i + 2);
      continue;
    }
    if (text.startsWith("<!", i)) {
      /* A DOCTYPE, stepped over whole — its internal subset too — and never read. */
      let depth = 0;
      let at = i + 2;
      for (; at < text.length; at++) {
        const char = text[at];
        if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ">" && depth <= 0) break;
      }
      if (at >= text.length) fail("an unclosed declaration");
      i = at + 1;
      continue;
    }
    if (text.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const name = NAME.exec(text)?.[0] ?? fail("a closing tag with no name");
      const end = text.indexOf(">", i);
      if (end < 0) fail("an unclosed closing tag");
      const open = stack.pop();
      if (!open || open.name !== name) fail(`</${name}> closes nothing that is open`);
      i = end + 1;
      emit(local(name), close(open!));
      continue;
    }

    /* An opening tag: its name, its attributes, and whether it closes itself. */
    NAME.lastIndex = i + 1;
    const name = NAME.exec(text)?.[0] ?? fail("a tag with no name");
    i += 1 + name.length;
    const node: Open = { name, attributes: {}, children: new Map(), text: "", nil: false };
    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = i;
      i += SPACE.exec(text)?.[0].length ?? 0;
      if (i >= text.length) fail(`<${name}> is never finished`);
      if (text[i] === ">") {
        i++;
        break;
      }
      if (text.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      NAME.lastIndex = i;
      const attribute = NAME.exec(text)?.[0] ?? fail(`an attribute of <${name}> with no name`);
      i += attribute.length;
      SPACE.lastIndex = i;
      i += SPACE.exec(text)?.[0].length ?? 0;
      if (text[i] !== "=") fail(`the attribute ${attribute} has no value`);
      i++;
      SPACE.lastIndex = i;
      i += SPACE.exec(text)?.[0].length ?? 0;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") fail(`the value of ${attribute} is not quoted`);
      const end = text.indexOf(quote!, i + 1);
      if (end < 0) fail(`the value of ${attribute} is never closed`);
      const value = decode(text.slice(i + 1, end));
      i = end + 1;
      /* Namespace declarations and schema hints describe the document, not the data. */
      if (attribute === "xmlns" || attribute.startsWith("xmlns:")) continue;
      if (/^(xsi|i):nil$/.test(attribute)) {
        if (value === "true" || value === "1") node.nil = true;
        continue;
      }
      if (/^(xsi|i):(type|schemaLocation|noNamespaceSchemaLocation)$/.test(attribute)) continue;
      node.attributes[local(attribute)] = scalar(value);
    }
    if (selfClosing) emit(local(name), close(node));
    else {
      if (stack.length >= MAX_DEPTH) fail("elements nested too deeply");
      stack.push(node);
    }
  }

  if (stack.length > 0) {
    i = text.length;
    fail(`<${stack[stack.length - 1]!.name}> is never closed`);
  }
  const found = root as { name: string; value: unknown } | null;
  if (!found) throw new XmlError("no element in the document");
  return unwrapSoap(found.name, found.value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A SOAP envelope is packaging: the answer is what its Body holds. */
const unwrapSoap = (name: string, value: unknown): unknown => {
  if (name !== "Envelope" || !isRecord(value) || !("Body" in value)) return { [name]: value };
  const body = value.Body;
  if (isRecord(body) && "Fault" in body) {
    const fault = body.Fault;
    const said = isRecord(fault)
      ? (fault.faultstring ?? (isRecord(fault.Reason) ? (fault.Reason.Text as unknown) : fault.Reason) ?? fault.faultcode)
      : fault;
    const words = isRecord(said) ? String(said.value ?? said["#text"] ?? "") : String(said ?? "");
    throw new XmlError(`the service answered with a fault: ${words || "no reason given"}`, words || "no reason given");
  }
  return isRecord(body) ? body : { Body: body };
};

/** Whether text that is not JSON looks like an XML document rather than a web page. */
export const looksLikeXml = (text: string): boolean => {
  const start = text.replace(/^﻿/, "").trimStart().slice(0, 400);
  if (!start.startsWith("<")) return false;
  if (/^<!doctype\s+html|^<html[\s>]/i.test(start)) return false;
  return /^<\?xml\b|^<[A-Za-z_][\w.:-]*[\s>/]/.test(start);
};
