import { parseXml } from "@freebirdai/dash-adapters";
import { catalogEntrySchema, type CatalogEntry, type ParamDef } from "@freebirdai/dash-spec";

/**
 * A SOAP web service, from its WSDL.
 *
 * WSDL 1.1, document/literal — what almost every SOAP service in use today
 * describes itself as. Each operation that reads becomes an endpoint: a POST
 * of the envelope its WSDL describes, its inputs as parameters, and where its
 * records are, read off the answer's own schema where it says.
 *
 * An operation is a call, and nothing in SOAP says a call reads. As with an
 * MCP tool, an operation becomes an endpoint only when its name begins with a
 * word for reading and holds no word for a change — recorded as that
 * (`readSafety: docs-inferred`), so it is never warmed in the background,
 * never retried, and journalled each time. Every other operation is left out,
 * and the import says which.
 */

type Json = Record<string, unknown>;
type CatalogOp = CatalogEntry["ops"][number];

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
/** `tns:GetOrders` → `GetOrders`. */
const local = (name: unknown): string | undefined => str(name)?.replace(/^[^:]*:/, "");

const READ_VERBS = new Set(["get", "list", "search", "find", "query", "retrieve", "fetch", "lookup", "describe", "count", "read", "browse"]);
const CHANGE_WORDS = new Set([
  ...["create", "add", "new", "update", "edit", "set", "delete", "remove", "send", "submit", "cancel", "approve", "close", "void", "post"],
  ...["upload", "import", "export", "start", "stop", "run", "execute", "charge", "refund", "pay", "save", "insert", "upsert", "modify", "change"],
]);

const nameWords = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

export const readsByName = (name: string): boolean => {
  const words = nameWords(name);
  return words.length > 0 && READ_VERBS.has(words[0]!) && !words.some((word) => CHANGE_WORDS.has(word));
};

/** Whether a document is a WSDL 1.1 description. */
export const looksLikeWsdl = (text: string): boolean => {
  const start = text.replace(/^﻿/, "").trimStart().slice(0, 2000);
  return /<([A-Za-z_][\w.-]*:)?definitions[\s>]/.test(start) && /(wsdl|schemas\.xmlsoap\.org\/wsdl)/i.test(start);
};

interface Element {
  readonly name: string;
  readonly type?: string;
  readonly optional: boolean;
  readonly many: boolean;
  readonly children: readonly Element[];
}

interface Schema {
  readonly targetNamespace?: string;
  readonly qualified: boolean;
  readonly elements: Map<string, Json>;
  readonly types: Map<string, Json>;
}

const schemasOf = (definitions: Json): Schema[] => {
  const types = isRecord(definitions.types) ? definitions.types : {};
  return list(types.schema)
    .filter(isRecord)
    .map((schema) => ({
      ...(str(schema.targetNamespace) ? { targetNamespace: str(schema.targetNamespace)! } : {}),
      qualified: str(schema.elementFormDefault) === "qualified",
      elements: new Map(list(schema.element).filter(isRecord).map((one) => [str(one.name) ?? "", one])),
      types: new Map(list(schema.complexType).filter(isRecord).map((one) => [str(one.name) ?? "", one])),
    }));
};

/** An element's children, a few levels down, from its inline or named complex type. */
const childrenOf = (node: Json, schemas: readonly Schema[], depth: number): Element[] => {
  if (depth > 4) return [];
  const named = local(node.type);
  const complex = isRecord(node.complexType)
    ? node.complexType
    : named
      ? schemas.map((one) => one.types.get(named)).find(isRecord)
      : undefined;
  if (!complex) return [];
  const sequence = isRecord(complex.sequence) ? complex.sequence : isRecord(complex.all) ? complex.all : isRecord(complex.choice) ? complex.choice : null;
  if (!sequence) return [];
  return list(sequence.element)
    .filter(isRecord)
    .flatMap((child) => {
      const name = str(child.name) ?? local(child.ref);
      if (!name) return [];
      const type = local(child.type);
      return [
        {
          name,
          ...(type ? { type } : {}),
          optional: str(child.minOccurs) === "0" || child.minOccurs === 0 || child.nillable === true,
          many: child.maxOccurs === "unbounded" || (typeof child.maxOccurs === "number" && child.maxOccurs > 1),
          children: childrenOf(child, schemas, depth + 1),
        },
      ];
    });
};

const PARAM_TYPE: Readonly<Record<string, ParamDef["type"]>> = {
  int: "number",
  integer: "number",
  long: "number",
  short: "number",
  decimal: "number",
  double: "number",
  float: "number",
  boolean: "boolean",
  date: "date",
  dateTime: "date",
};

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Where the records are in an operation's answer: the path down its output
 * element to the one repeated element, when there is exactly one.
 */
const rowsPathOf = (output: string, element: Json | undefined, schemas: readonly Schema[]): string | undefined => {
  if (!element) return undefined;
  const path = [output];
  let children: readonly Element[] = childrenOf(element, schemas, 0);
  for (let depth = 0; depth < 4; depth++) {
    const repeated = children.filter((one) => one.many);
    if (repeated.length === 1) return `$.${[...path, repeated[0]!.name].join(".")}`;
    if (children.length !== 1) return undefined;
    path.push(children[0]!.name);
    children = children[0]!.children;
  }
  return undefined;
};

export interface WsdlImport {
  readonly entry: CatalogEntry;
  readonly warnings: string[];
}

/** A WSDL document as a catalog entry, or null when it describes nothing this can call. */
export const parseWsdl = (text: string, url: string): WsdlImport | null => {
  let document: unknown;
  try {
    document = parseXml(text);
  } catch {
    return null;
  }
  const definitions = isRecord(document) && isRecord(document.definitions) ? document.definitions : null;
  if (!definitions) return null;
  const schemas = schemasOf(definitions);
  const messages = new Map(list(definitions.message).filter(isRecord).map((one) => [str(one.name) ?? "", one]));
  const elementOf = (message: string | undefined): { name: string; node?: Json; schema?: Schema } | null => {
    const part = message ? list(messages.get(message)?.part).find(isRecord) : undefined;
    const name = part ? local(part.element) : undefined;
    if (!name) return null;
    const schema = schemas.find((one) => one.elements.has(name));
    return { name, ...(schema ? { node: schema.elements.get(name), schema } : {}) };
  };

  /* The address: the first SOAP port of the first service. */
  const port = list(definitions.service)
    .filter(isRecord)
    .flatMap((service) => list(service.port).filter(isRecord))
    .find((one) => isRecord(one.address) && str(one.address.location));
  const location = port && isRecord(port.address) ? str(port.address.location) : undefined;
  if (!location) return null;
  let address: URL;
  try {
    address = new URL(location, url);
  } catch {
    return null;
  }
  if (address.protocol !== "https:" && address.protocol !== "http:") return null;
  const bindingName = local(port?.binding);
  const binding = list(definitions.binding).filter(isRecord).find((one) => str(one.name) === bindingName) ?? list(definitions.binding).find(isRecord);
  const actions = new Map(
    list(isRecord(binding) ? binding.operation : undefined)
      .filter(isRecord)
      .map((one) => [str(one.name) ?? "", isRecord(one.operation) ? (str(one.operation.soapAction) ?? "") : ""]),
  );
  const portType = list(definitions.portType).filter(isRecord).find((one) => str(one.name) === local(isRecord(binding) ? binding.type : undefined)) ?? list(definitions.portType).find(isRecord);

  const ops: CatalogOp[] = [];
  const left: string[] = [];
  const title = str(definitions.name) ?? str(isRecord(list(definitions.service)[0]) ? (list(definitions.service)[0] as Json).name : undefined) ?? address.hostname;
  for (const operation of list(isRecord(portType) ? portType.operation : undefined).filter(isRecord)) {
    const name = str(operation.name);
    if (!name) continue;
    if (!readsByName(name)) {
      left.push(name);
      continue;
    }
    const input = elementOf(local(isRecord(operation.input) ? operation.input.message : undefined));
    const output = elementOf(local(isRecord(operation.output) ? operation.output.message : undefined));
    if (!input) {
      left.push(name);
      continue;
    }
    const fields = input.node ? childrenOf(input.node, schemas, 0) : [];
    const namespace = input.schema?.targetNamespace;
    const qualified = input.schema?.qualified ?? false;
    const open = namespace ? (qualified ? `<${input.name} xmlns="${escapeXml(namespace)}">` : `<m:${input.name} xmlns:m="${escapeXml(namespace)}">`) : `<${input.name}>`;
    const close = namespace && !qualified ? `</m:${input.name}>` : `</${input.name}>`;
    /* Only the simple inputs are the endpoint's to fill; each becomes a parameter. */
    const simple = fields.filter((one) => one.children.length === 0 && !one.many).slice(0, 40);
    const template = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>',
      open,
      ...simple.map((one) => `<${one.name}>{{param.${one.name}}}</${one.name}>`),
      close,
      "</soap:Body></soap:Envelope>",
    ].join("");
    const id = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
    const action = actions.get(name);
    const rowsPath = output ? rowsPathOf(output.name, output.node, schemas) : undefined;
    const parsed = catalogEntrySchema.shape.ops.removeDefault().element.safeParse({
      id,
      title: nameWords(name).map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" "),
      method: "POST",
      path: address.pathname + address.search,
      body: { type: "xml", template },
      readSafety: { basis: "docs-inferred", note: `A SOAP operation named ${name}: a name for reading, with no word for a change in it.` },
      headers: { soapaction: `"${action ?? ""}"` },
      archetype: "list",
      ...(rowsPath ? { rowsPath } : {}),
      params: simple.map((one) => ({
        name: one.name,
        in: "body",
        type: (one.type ? PARAM_TYPE[one.type] : undefined) ?? "string",
        required: !one.optional,
      })),
    });
    if (parsed.success) ops.push(parsed.data);
    else left.push(name);
  }
  if (ops.length === 0) return null;
  const entry = catalogEntrySchema.safeParse({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "soap",
    title,
    baseUrl: address.origin,
    dialect: { auth: { type: "none" }, pagination: { kind: "none" } },
    ops,
    resources: [],
    origin: "docs",
    verified: false,
    specUrl: url,
  });
  if (!entry.success) return null;
  return {
    entry: entry.data,
    warnings: [
      ...(left.length > 0
        ? [`${left.length} operation${left.length === 1 ? " is" : "s are"} not named for reading, and ${left.length === 1 ? "was" : "were"} left out: ${left.slice(0, 8).join(", ")}${left.length > 8 ? ", and others" : ""}.`]
        : []),
      "A SOAP service's sign-in lives in its envelope or its headers, which a WSDL does not describe; the check asks for a key if the service refuses without one.",
    ],
  };
};
