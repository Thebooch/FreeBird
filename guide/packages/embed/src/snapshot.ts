import type { RegistrationManifest } from "@freebirdai/manifest";

/**
 * Component snapshots are how a browser-registered component gets a
 * `dataSource` on the managed backend: the embed extracts a structured-text
 * digest of each registered region and posts it; the backend stores the
 * latest per (site, component) and serves it to the LLM.
 */
export interface ComponentSnapshot {
  componentId: string;
  /** Structured text extraction of the region. */
  text: string;
  /** Values of declared fields, keyed by field name. */
  fields?: Record<string, string>;
  capturedAt: string;
}

const MAX_SNAPSHOT_CHARS = 4000;

/** Collapse whitespace and cap length so snapshots stay prompt-friendly. */
const cleanText = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SNAPSHOT_CHARS
    ? `${collapsed.slice(0, MAX_SNAPSHOT_CHARS)}…`
    : collapsed;
};

/**
 * Extract visible-ish text. Form controls contribute their labels/values,
 * since `textContent` alone misses them.
 */
export const extractText = (root: Element): string => {
  const clone = root.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll("script, style, noscript"))) {
    el.remove();
  }
  const controls = Array.from(
    clone.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    ),
  );
  const controlText = controls
    .map((c) => {
      const name = c.getAttribute("name") ?? c.getAttribute("placeholder") ?? c.tagName.toLowerCase();
      return `[${name}]`;
    })
    .join(" ");
  return cleanText(`${clone.textContent ?? ""} ${controlText}`);
};

export const snapshotComponent = (
  componentId: string,
  root: Element,
): ComponentSnapshot => {
  const fields: Record<string, string> = {};
  for (const el of Array.from(root.querySelectorAll("[data-freebird-field]"))) {
    const name = el.getAttribute("data-freebird-field")?.trim();
    if (!name) continue;
    const value =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? el.value
        : (el.textContent ?? "");
    fields[name] = cleanText(value);
  }
  return {
    componentId,
    text: extractText(root),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    capturedAt: new Date().toISOString(),
  };
};

/** Snapshot every manifest component currently present in the document. */
export const captureSnapshots = (
  manifest: RegistrationManifest,
  doc: Document = document,
): ComponentSnapshot[] => {
  const out: ComponentSnapshot[] = [];
  for (const component of manifest.components) {
    const selector = component.source.selector;
    if (!selector) continue;
    const el = doc.querySelector(selector);
    if (!el) continue;
    out.push(snapshotComponent(component.id, el));
  }
  return out;
};
