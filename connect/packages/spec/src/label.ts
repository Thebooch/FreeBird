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
