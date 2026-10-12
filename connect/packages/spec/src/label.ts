/**
 * `Address_City` → `Address · City`; `unitNumber` → `Unit number`.
 *
 * Presentation only — no vocabulary, no vendor. Field names arrive in whatever
 * casing the API uses, and a label that still reads `postalCodeExtension` in a
 * record view makes the product look like a database browser.
 *
 * It sits in the spec rather than in the component library because the
 * concierge asks its questions on the server, where React cannot go, and the
 * label it puts on an option has to be the one the widget will later show.
 * It sits in the engine's spec because a record page is labelled with it too;
 * Dash's `presentation` re-exports it.
 */
export const humanLabel = (name: string): string => {
  // Only `.` separates levels. An underscore separates words *within* a
  // level, so `postal_code` is one label and `Address.City` is two.
  const parts = name.split(".").filter((part) => part.length > 0);

  /*
   * Past two levels, the middle is a container and the ends carry the meaning.
   *
   * `Property.Address.City` is a city, and the fact that it reached it through
   * an address object is plumbing — the reader already knows an address has a
   * city in it. Printing every level gives "Property · Address · City", which
   * is the database-browser look this function exists to avoid, and it gets
   * worse the deeper a schema goes.
   *
   * Root and leaf keeps the one thing the middle was carrying: *whose* city it
   * is. That matters, because a row holding both a property's and a unit's
   * address needs them told apart, and "City" twice would be worse than
   * either.
   */
  const spoken = parts.length > 2 ? [parts[0]!, parts[parts.length - 1]!] : parts;

  const words = spoken.map((part) => {
    /*
     * An acronym inside a mixed-case name stays one: `GLAccount` is "GL
     * account", not "Glaccount", and `workOrderID` is "Work order ID". Only
     * inside a mixed-case name, because there the capitals were chosen — a
     * name that is capitals throughout, `STATUS`, is just shouting.
     */
    const mixed = /[a-z]/.test(part) && /[A-Z]/.test(part);
    return part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_+/g, " ")
      .trim()
      .split(/\s+/)
      .map((word) => (mixed && /^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase()))
      .join(" ");
  });

  // Sentence case, not Title Case — "Unit number", because "Unit Number" reads
  // as a proper noun. Only the first level is capitalised where several are
  // spoken: "Property city", not "Property · City".
  const joined = parts.length > 2 ? words.join(" ") : words.map(sentenceCase).join(" · ");
  return parts.length > 2 ? sentenceCase(joined) : joined;
};

const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Values an API sends to mean "nothing here".
 *
 * `NotSet` on an enum nobody filled in, `None`, `N/A`, and the first day of
 * year one that a .NET API sends for a date nobody entered. Printed as sent,
 * these read as data — a lease "NotSet", a move-in on "Jan 1, 1" — so they
 * read as empty instead, like a null does.
 */
const NOTHING_WORDS: ReadonlySet<string> = new Set([
  "notset",
  "none",
  "null",
  "nil",
  "undefined",
  "unknown",
  "na",
  "notapplicable",
  "unspecified",
  "notspecified",
]);

/** Dates that are a database's floor or ceiling rather than a day anything happened. */
const PLACEHOLDER_DATE = /^(0001-01-01|0000-00-00|1753-01-01|1900-01-01T00:00:00|9999-12-31)/;

export const isNothingValue = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 20) return false;
  if (PLACEHOLDER_DATE.test(text)) return true;
  return NOTHING_WORDS.has(text.toLowerCase().replace(/[^a-z]/g, ""));
};

/** `InProgress`, `GLAccount`, `PastDue` — capitals mark where the words start. */
const PASCAL = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;
/** `inProgress`, `notSet` — but not `iPhone` or `eBay`, which are names. */
const CAMEL = /^[a-z]{2,}(?:[A-Z][a-z0-9]*)+$/;
/** `in_progress`, `PAST_DUE`, `gl_account`. */
const SNAKE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
/**
 * Surnames whose capitals are part of the name: McDonald, DeAngelo, LaToya,
 * VanBuren. A value like these is somebody's name, not a token to split.
 */
const NAME_CAPITALS = /^(Mc|Mac|De|Di|Da|Du|La|Le|Lo|Van|Von|St|O)[A-Z][a-z]+$/;

/** Whether a string looks like a code value rather than words somebody typed. */
export const looksLikeToken = (text: string): boolean => {
  if (text.length > 40 || /\s/.test(text)) return false;
  if (SNAKE.test(text)) return true;
  if (CAMEL.test(text)) return true;
  if (!PASCAL.test(text) || NAME_CAPITALS.test(text)) return false;
  // At least two words: `Active` is already a word.
  return /[a-z0-9][A-Z]|[A-Z][A-Z][a-z]/.test(text);
};

/**
 * `InProgress` → "In progress"; `GLAccount` → "GL account"; `past_due` →
 * "Past due".
 *
 * The value-side twin of `humanLabel`, and it uses the same rules — split on
 * the capitals and underscores, sentence case, acronyms kept — so a field
 * called `PastDue` and a status whose value is `PastDue` read the same.
 *
 * `enumLike` says the value is one of a set (a status, a category). Then any
 * single token is spoken, `ACTIVE` included. Otherwise only a string that
 * plainly is a code — PascalCase with two words or more, camelCase, or
 * snake_case — is touched, so a name or a sentence comes back exactly as
 * sent.
 */
export const humanValue = (value: string, enumLike = false): string => {
  const text = value.trim();
  if (text.length === 0 || text.length > 40 || /\s/.test(text) || text.includes(".")) return value;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) return value;
  if (!enumLike && !looksLikeToken(text)) return value;
  // One all-capitals word in a set of values is shouting, unless it is short enough to be an acronym.
  if (enumLike && /^[A-Z0-9]+$/.test(text) && text.length <= 3) return value;
  // A number inside a code is a word of its own: `Every2Weeks` is "Every 2 weeks".
  return humanLabel(text.replace(/([A-Za-z])(\d)/g, "$1_$2"));
};
