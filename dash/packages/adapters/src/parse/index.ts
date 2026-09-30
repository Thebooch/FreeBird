import { AdapterError } from "../types.js";
import { parseDelimited, parseEvents, parseNdjson } from "./delimited.js";
import { XmlError, looksLikeXml, parseXml } from "./xml.js";

/**
 * An answer's body as plain values, whatever it was written in (plan, track A).
 *
 * The format is the answer's own word for itself — its content type — and
 * never a guess from its first characters, with one exception: a body that
 * is not JSON and says nothing useful about itself is read as XML when it is
 * plainly an XML document and not a web page. Anything else is the error it
 * always was: an error page, or the wrong address.
 */

export type BodyFormat = "json" | "ndjson" | "csv" | "tsv" | "xml" | "sse";

export const formatOf = (contentType: string | null | undefined): BodyFormat | null => {
  const type = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (type === "") return null;
  if (type === "text/event-stream") return "sse";
  if (/nd-?json|jsonl|jsonlines|json-seq/.test(type)) return "ndjson";
  if (/json/.test(type)) return "json";
  if (/csv|comma-separated/.test(type)) return "csv";
  if (/tab-separated|\btsv\b/.test(type)) return "tsv";
  if (/xml/.test(type) && !/xhtml/.test(type)) return "xml";
  return null;
};

const notReadable = (url: string, format: string, why?: string): AdapterError =>
  new AdapterError(`response from ${url} was not ${format}${why ? `: ${why}` : ""}`, {
    status: 502,
    userMessage:
      format === "JSON"
        ? "That endpoint returned something other than JSON. It may be an error page, or the wrong URL."
        : `That endpoint's answer could not be read as ${format}. It may be an error page, or the wrong URL.`,
  });

const xml = (text: string, url: string): unknown => {
  try {
    return parseXml(text);
  } catch (error) {
    /* A SOAP fault is the service's own refusal, said in its words. */
    if (error instanceof XmlError && error.fault !== undefined)
      throw new AdapterError(`${url} answered with a fault: ${error.fault}`, {
        status: 502,
        userMessage: `The service refused the request: ${error.fault}`,
        detail: error.fault,
      });
    throw notReadable(url, "XML", error instanceof Error ? error.message : undefined);
  }
};

export const parseBody = (text: string, contentType: string | null | undefined, url: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const format = formatOf(contentType);
  try {
    if (format === "sse") return parseEvents(text);
    if (format === "ndjson") return parseNdjson(text);
    if (format === "csv") return parseDelimited(text, ",");
    if (format === "tsv") return parseDelimited(text, "\t");
  } catch (error) {
    throw notReadable(url, format === "ndjson" ? "newline-delimited JSON" : "a table of rows", error instanceof Error ? error.message : undefined);
  }
  if (format === "xml") return xml(text, url);
  try {
    return JSON.parse(trimmed);
  } catch {
    /* Not JSON, whatever it called itself: an XML document says so by its first line. */
    if (looksLikeXml(trimmed)) return xml(text, url);
    throw notReadable(url, "JSON");
  }
};

export { parseDelimited, parseEvents, parseNdjson } from "./delimited.js";
export { XmlError, looksLikeXml, parseXml } from "./xml.js";
