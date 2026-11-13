import type { PolicyScan } from "@freebirdai/dash-spec";

/**
 * Reads a business's own website, privacy policy or opt-in page for what
 * registration reviewers look for: reachable over https, the business's
 * name on it, the clause that mobile numbers are not shared or sold, an
 * opt-in box that is not ticked before anyone ticks it and is not the same
 * box as the terms, and nothing from the prohibited content categories.
 *
 * Plain reading of the page's HTML: no script runs, and the page is fetched
 * through the server's SSRF guard (`fetchPublicDocument`). What it cannot
 * see (a box ticked by a script) it does not claim.
 */

export type FetchPage = (url: string) => Promise<{ readonly status: number; readonly text: string }>;

/** Words reviewers refuse: the SHAFT categories and other high-risk content. Matched as whole words. */
export const PROHIBITED_WORDS = [
  "cannabis",
  "marijuana",
  "cbd",
  "thc",
  "vape",
  "e-cigarette",
  "firearm",
  "firearms",
  "ammunition",
  "gambling",
  "casino",
  "sweepstakes",
  "payday loan",
  "debt relief",
  "debt forgiveness",
  "credit repair",
  "kratom",
] as const;

/** "We will not share or sell your mobile number", in its usual wordings. */
const NO_SHARING = [
  /(?:will|do|does|shall)\s+not\s+(?:be\s+)?(?:share|sell|rent|disclose|shared|sold|rented|disclosed)/i,
  /never\s+(?:be\s+)?(?:share|sell|rent|shared|sold|rented)/i,
  /not\s+be\s+(?:shared|sold|rented|disclosed)/i,
  /no\s+mobile\s+information\s+will\s+be\s+shared/i,
];

/** The visible words of a page: tags, scripts and styles taken out. */
export const pageWords = (html: string): string =>
  html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const comparable = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A business's name without its legal suffix, for finding it on a page or in a sample. */
export const shortName = (legalName: string): string =>
  comparable(legalName)
    .replace(/\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|pllc|lp|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const namesBusiness = (text: string, legalName: string): boolean => {
  const name = shortName(legalName);
  return name.length > 0 && comparable(text).includes(name);
};

export const prohibitedIn = (text: string): string[] => {
  const words = ` ${comparable(text)} `;
  return PROHIBITED_WORDS.filter((word) => words.includes(` ${comparable(word)} `));
};

/** Checkbox inputs, and whether each starts ticked and what its label says. */
const checkboxes = (html: string): Array<{ readonly checked: boolean; readonly near: string }> => {
  const out: Array<{ checked: boolean; near: string }> = [];
  const pattern = /<input\b[^>]*type\s*=\s*["']?checkbox["']?[^>]*>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const tag = match[0];
    /* Its label: the words after it, up to the next input. */
    const rest = html.slice(match.index + tag.length, match.index + tag.length + 600);
    const next = rest.search(/<input\b/i);
    const after = pageWords(next >= 0 ? rest.slice(0, next) : rest).slice(0, 300);
    out.push({ checked: /\schecked(?:\s|=|>|\/)/i.test(tag), near: after.toLowerCase() });
  }
  return out;
};

export const scanPolicy = async (url: string, options: { readonly fetch: FetchPage; readonly legalName: string }): Promise<PolicyScan> => {
  const base: PolicyScan = { url, reachable: false, https: url.startsWith("https://"), showsName: false, noSharing: false, checkedByDefault: false, consentWithTerms: false, prohibited: [] };
  let page: { status: number; text: string };
  try {
    page = await options.fetch(url);
  } catch (error) {
    return { ...base, problem: `It could not be opened: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (page.status < 200 || page.status >= 300) return { ...base, problem: `It answered ${page.status}, not the page.` };
  const words = pageWords(page.text);
  const boxes = checkboxes(page.text);
  const textBoxes = boxes.filter((one) => /\b(text|sms|message)/.test(one.near));
  return {
    ...base,
    reachable: true,
    showsName: namesBusiness(words, options.legalName),
    noSharing: NO_SHARING.some((pattern) => pattern.test(words)),
    checkedByDefault: textBoxes.some((one) => one.checked),
    /* One box that both agrees to texts and accepts the terms: reviewers want them apart. */
    consentWithTerms: textBoxes.some((one) => /\b(agree|accept)\b/.test(one.near.slice(0, 200)) && /\bterms\b/.test(one.near.slice(0, 200))),
    prohibited: prohibitedIn(words),
  };
};
