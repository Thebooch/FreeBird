import type { WidgetSpec } from "./dashboard.js";

/**
 * A widget rebuilt from an edited brief, keeping what the compiler does not own.
 *
 * `compileBrief` builds from nothing every time, which is exactly what makes it
 * trustworthy — the same brief over the same record type always produces the
 * same widget, with no memory of what was there before. That property is also
 * the hazard: handing its output straight back would silently discard every
 * decision somebody made *outside* the brief. Restyling a widget, pinning a
 * currency, approving it, laying out the record page its rows open — none of
 * those are things a brief can say, and all of them are things a person did on
 * purpose.
 *
 * So the merge is explicit and the list is named. A field added to the widget
 * schema later is, by default, *lost* on the next edit — which is the right
 * default, because it fails where somebody can see it rather than quietly
 * carrying a stale value forward.
 *
 * Two things deliberately not carried:
 *
 * - **The id.** The caller owns it, because an edit must keep the widget's own
 *   id or its layout cell orphans — and for a widget in a group, the group
 *   drops below two members and the *whole board* stops being storable.
 * - **`schemaHash`.** It records the response shape a binding was built
 *   against. The new widget was built against whatever the record type says
 *   now, so the old hash would be a claim about a check nobody ran.
 */
export const recompileWidget = (previous: WidgetSpec, compiled: WidgetSpec): WidgetSpec => ({
  ...compiled,
  /*
   * The id is the widget's identity on a board, not a property of the request
   * — `compileBrief` mints a fresh one because it is usually building
   * something new, and an edit is the case where it must not.
   */
  id: previous.id,
  /*
   * How it looks, which no brief describes. Density, a chosen size, a colour:
   * all of it survives a change to what the widget shows.
   */
  ...(previous.presentation ? { presentation: previous.presentation } : {}),
  /*
   * This widget's own changes to the record page its rows open. Editing the
   * columns of a list has nothing to say about the layout of the record behind
   * a row.
   */
  ...(previous.record ? { record: previous.record } : {}),
  /*
   * Ambiguities a person has already answered — "amount is in cents". Asking
   * again because somebody added a column would be the machine forgetting on
   * their behalf.
   */
  confirmed: [...new Set([...previous.confirmed, ...compiled.confirmed])],
  /*
   * Who designed the binding, and when. An edit by a person does not make a
   * model responsible for their choice, and it does not erase the record of
   * the one that made the original either.
   */
  ...(previous.producedBy ? { producedBy: previous.producedBy } : {}),
  /*
   * Chrome the brief has no word for yet. Both are statements about finished
   * rows rather than steps that produce them, so a recompiled pipeline does
   * not invalidate them — but a column one of them names might be gone, which
   * is what `validateFacets` and the highlight evaluation already report
   * without failing the widget.
   */
  highlights: previous.highlights.length > 0 ? previous.highlights : compiled.highlights,
  states: Object.keys(previous.states).length > 0 ? previous.states : compiled.states,
  refresh: previous.refresh,
  /*
   * Formatting the compiler did not write.
   *
   * It owns the columns it produces — a bucketed axis, a coerced amount — and
   * those must follow the new brief or a renamed column keeps a format that no
   * longer applies to it. Anything else was set by hand and is kept.
   */
  format: { ...previous.format, ...compiled.format },
});
