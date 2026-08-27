import {
  safeParseManifest,
  type ManifestComponent,
  type RegistrationManifest,
} from "@freebirdai/manifest";

/**
 * Declarative registration for sites with no build step. Any element can
 * declare itself a FreeBird component:
 *
 *   <section id="hours"
 *            data-freebird-component="openingHours"
 *            data-freebird-title="Opening hours"
 *            data-freebird-description="Weekly opening hours"
 *            data-freebird-tags="hours,contact">
 *     <span data-freebird-field="monday" data-freebird-field-description="Monday hours">9–17</span>
 *   </section>
 *
 * The scanner turns these into `dom-region` manifest entries. Invalid entries
 * (bad ids, missing descriptions) are skipped with a console warning rather
 * than breaking the whole scan — host pages are wild territory.
 */

/** Build a unique-enough CSS selector for a scanned element. */
export const selectorFor = (el: Element): string => {
  if (el.id) return `#${cssEscape(el.id)}`;
  const attr = el.getAttribute("data-freebird-component");
  if (attr) return `[data-freebird-component="${cssEscape(attr)}"]`;
  // Fallback: positional path from the nearest id-anchored ancestor.
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    const parent: Element | null = node.parentElement;
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    if (!parent) break;
    const index = Array.from(parent.children).indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
};

const cssEscape = (value: string): string =>
  typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const titleCase = (id: string): string =>
  id
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

const scanFields = (root: Element): ManifestComponent["fields"] => {
  const fields: NonNullable<ManifestComponent["fields"]> = [];
  for (const el of Array.from(root.querySelectorAll("[data-freebird-field]"))) {
    const name = el.getAttribute("data-freebird-field")?.trim();
    if (!name) continue;
    const description = el.getAttribute("data-freebird-field-description")?.trim();
    fields.push({
      name,
      selector: `[data-freebird-field="${cssEscape(name)}"]`,
      ...(description ? { description } : {}),
    });
  }
  return fields.length > 0 ? fields : undefined;
};

const componentFromElement = (el: Element): ManifestComponent | null => {
  const id = el.getAttribute("data-freebird-component")?.trim();
  if (!id) return null;
  const description =
    el.getAttribute("data-freebird-description")?.trim() ||
    `The "${titleCase(id)}" section of this page.`;
  const tags = (el.getAttribute("data-freebird-tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const fields = scanFields(el);
  return {
    id,
    title: el.getAttribute("data-freebird-title")?.trim() || titleCase(id),
    description,
    ...(tags.length > 0 ? { tags } : {}),
    kind: "dom-region",
    source: { selector: selectorFor(el) },
    ...(fields ? { fields } : {}),
  };
};

/** Scan a document (or subtree) for declaratively registered components. */
export const scanDocument = (
  root: ParentNode = document,
  siteId?: string,
): RegistrationManifest => {
  const components: ManifestComponent[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(root.querySelectorAll("[data-freebird-component]"))) {
    const component = componentFromElement(el);
    if (!component) continue;
    if (seen.has(component.id)) {
      console.warn(
        `[freebird] duplicate data-freebird-component id "${component.id}" — keeping the first occurrence.`,
      );
      continue;
    }
    const candidate: RegistrationManifest = {
      version: 1,
      components: [component],
    };
    const check = safeParseManifest(candidate);
    if (!check.success) {
      console.warn(
        `[freebird] skipping invalid component "${component.id}":`,
        check.error.issues[0]?.message,
      );
      continue;
    }
    seen.add(component.id);
    components.push(component);
  }
  return {
    version: 1,
    ...(siteId !== undefined ? { siteId } : {}),
    components,
  };
};

/**
 * Watch for DOM changes that add/remove registered components (SPAs, WP page
 * builders). Debounced; fires `onChange` only when the scanned manifest's id
 * set or selectors actually changed.
 */
export const observeComponents = (
  onChange: () => void,
  opts: { debounceMs?: number } = {},
): (() => void) => {
  if (typeof MutationObserver === "undefined") return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
      return nodes.some(
        (n) =>
          n instanceof Element &&
          (n.hasAttribute("data-freebird-component") ||
            n.querySelector?.("[data-freebird-component]") != null),
      );
    });
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, opts.debounceMs ?? 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    if (timer) clearTimeout(timer);
    observer.disconnect();
  };
};
