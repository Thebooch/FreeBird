/**
 * CSV, TSV and newline-delimited JSON, read into records.
 *
 * The same rules connector code has had in its sandbox (`CSV.parse`,
 * `NDJSON.parse`), here for an endpoint that simply answers this way: no code
 * is needed to read a file of rows.
 */

const NUMBER = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,15})?$/;

/** A cell: empty is nothing, a plain number is a number, anything else its text. */
const cell = (text: string): unknown => (text === "" ? null : NUMBER.test(text) ? Number(text) : text);

/**
 * RFC 4180: quoted fields, doubled quotes, CRLF or LF. The first row names
 * the columns, and every other row is a record.
 */
export const parseDelimited = (source: string, delimiter: "," | "\t" | ";" = ","): Record<string, unknown>[] => {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const filled = rows.filter((one) => !(one.length === 1 && one[0] === ""));
  const names = (filled[0] ?? []).map((name) => name.trim());
  return filled.slice(1).map((one) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (name !== "") record[name] = cell(one[index] ?? "");
    });
    return record;
  });
};

/**
 * Server-sent events, one record each: its data, read as JSON where it is
 * JSON (an object's fields become the record's), with the event's name and
 * id beside it. A comment, and an event with no data, are nothing.
 */
export const parseEvents = (source: string): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  for (const block of source.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
    const data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }
    if (data.length === 0) continue;
    const text = data.join("\n");
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* Not JSON: the text is the record's data. */
    }
    const fields = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { data: value };
    records.push({ ...(event !== undefined ? { event } : {}), ...(id !== undefined ? { id } : {}), ...fields });
  }
  return records;
};

/** One JSON value a line; blank lines are nothing. */
export const parseNdjson = (source: string): unknown[] =>
  source
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
