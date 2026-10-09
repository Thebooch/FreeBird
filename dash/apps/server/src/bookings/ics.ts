/**
 * iCalendar (RFC 5545) for bookings: the "Add to calendar" file on a booking
 * page, and the read-only feed. Times are written in UTC, so no zone table is
 * needed; every text value is escaped and every line folded at 75 octets.
 */

export interface IcsEvent {
  /** Stable across changes, so a calendar app updates the event instead of adding another. */
  readonly uid: string;
  readonly start: string;
  readonly end: string;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly url?: string;
  readonly status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  /** Bumped on each change: the booking's revision. */
  readonly sequence?: number;
  readonly updatedAt?: string;
}

const stamp = (at: string | number): string => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Backslash, semicolon, comma and line breaks, as the format wants them. */
export const icsText = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** Lines of at most 75 octets, continued with a space, never splitting a character. */
export const fold = (line: string): string => {
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
};

export const icsCalendar = (events: readonly IcsEvent[], options: { readonly name?: string; readonly now: number }): string => {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FreeBird//Dash bookings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (options.name) lines.push(`X-WR-CALNAME:${icsText(options.name)}`);
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsText(event.uid)}`,
      `DTSTAMP:${stamp(event.updatedAt ?? options.now)}`,
      `DTSTART:${stamp(event.start)}`,
      `DTEND:${stamp(event.end)}`,
      `SUMMARY:${icsText(event.summary)}`,
      ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []),
      ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
      ...(event.url ? [`URL:${event.url}`] : []),
      `STATUS:${event.status ?? "CONFIRMED"}`,
      `SEQUENCE:${event.sequence ?? 0}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
};
