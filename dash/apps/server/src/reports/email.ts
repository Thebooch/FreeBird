import type { Change, ReportPart, ReportSection, ReportVisual } from "./build.js";

/**
 * A report as an email: HTML for mail apps, and the same words as plain text,
 * which always goes too. Inline styles and tables only, because that is what
 * mail apps draw: bars and trend columns are table cells, never images, so
 * they show everywhere. Pure: the same inputs make the same email, which is
 * what the preview shows.
 *
 * Each part reads top to bottom: a whole tab is its name, its summary, then
 * each widget's picture; a widget on its own is its name, its summary, then
 * its picture.
 */

export interface EmailParts {
  readonly reportName: string;
  /** The workspace's name and colour. */
  readonly brand: { readonly name: string; readonly accent: string };
  /** The agent it comes from, when one is set: its name and colour on top. */
  readonly agent?: { readonly name: string; readonly color: string } | undefined;
  readonly parts: readonly ReportPart[];
  /** Each part's summary, by its key. A part without one has none. */
  readonly summaries: Readonly<Record<string, string>>;
  /** "Monday, March 3", in the report's zone. */
  readonly dateLine: string;
  readonly scheduleLine: string;
  /** Where the report is changed, in the app. */
  readonly manageUrl: string;
  /** This recipient's own link to stop getting it. */
  readonly unsubscribeUrl: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A colour safe to put in a style: a hex colour, or the fallback. */
const colour = (value: string | undefined, fallback: string): string => (value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : fallback);

/** Paragraphs, **bold** and line breaks: all a note or a summary needs. */
const prose = (markdown: string, style: string): string =>
  markdown
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => `<p style="${style}">${escape(paragraph.trim()).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</p>`)
    .join("");

const plainProse = (markdown: string): string => markdown.trim().replace(/\*\*(.+?)\*\*/g, "$1");

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MUTED = "#6b7280";
const INK = "#111827";
const LINE = "#e5e7eb";
const TRACK = "#eef0f3";

const changeColour = (direction: Change["direction"]): string => (direction === "flat" ? MUTED : direction === "up" ? "#047857" : "#b91c1c");

const small = (text: string, color = MUTED, margin = "4px 0 0") => `<p style="${FONT}margin:${margin};font-size:12px;color:${color};">${escape(text)}</p>`;
const big = (value: string) => `<p style="${FONT}margin:4px 0 0;font-size:26px;font-weight:700;color:${INK};">${escape(value)}</p>`;
const changeLine = (change: Change | null) => (change ? `<p style="${FONT}margin:2px 0 0;font-size:13px;color:${changeColour(change.direction)};">${escape(change.text)}</p>` : "");

/* ── pictures ──────────────────────────────────────────────────────────── */

const barsHtml = (visual: Extract<ReportVisual, { kind: "bars" }>, accent: string): string => {
  if (visual.bars.length === 0) return small("Nothing to show.");
  const top = Math.max(...visual.bars.map((bar) => Math.abs(bar.value)), 1);
  const rows = visual.bars
    .map((bar) => {
      const width = Math.max(2, Math.round((Math.abs(bar.value) / top) * 100));
      return `<tr>
<td style="${FONT}padding:4px 10px 4px 0;font-size:13px;color:${INK};width:38%;vertical-align:middle;">${escape(bar.label)}</td>
<td style="padding:4px 0;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td width="${width}%" style="background:${accent};height:10px;font-size:0;line-height:0;border-radius:3px;">&nbsp;</td>${width < 100 ? `<td style="background:${TRACK};height:10px;font-size:0;line-height:0;">&nbsp;</td>` : ""}</tr></table></td>
<td align="right" style="${FONT}padding:4px 0 4px 10px;font-size:13px;font-weight:600;color:${INK};white-space:nowrap;vertical-align:middle;">${escape(bar.text)}</td>
</tr>`;
    })
    .join("");
  const more = visual.more > 0 ? small(`and ${visual.more} more${visual.moreText ? ` (${visual.moreText} in all)` : ""}`) : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;">${rows}</table>${more}`;
};

const trendHtml = (visual: Extract<ReportVisual, { kind: "trend" }>, accent: string): string => {
  const values = visual.points.map((point) => point.value);
  const low = Math.min(0, ...values);
  const high = Math.max(...values, low + 1);
  const columns = visual.points
    .map((point) => {
      const height = Math.max(2, Math.round(((point.value - low) / (high - low)) * 56));
      return `<td valign="bottom" style="padding:0 1px;"><div title="${escape(`${point.label}: ${point.value}`)}" style="background:${accent};height:${height}px;border-radius:2px 2px 0 0;font-size:0;line-height:0;">&nbsp;</div></td>`;
    })
    .join("");
  const first = visual.points[0]?.label ?? "";
  const last = visual.points[visual.points.length - 1]?.label ?? "";
  return (
    big(visual.latest) +
    changeLine(visual.change) +
    (visual.points.length > 1
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;height:60px;border-bottom:1px solid ${LINE};"><tr>${columns}</tr></table>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="${FONT}font-size:11px;color:${MUTED};padding-top:3px;">${escape(first)}</td><td align="right" style="${FONT}font-size:11px;color:${MUTED};padding-top:3px;">${escape(last)}</td></tr></table>`
      : "")
  );
};

const listHtml = (visual: Extract<ReportVisual, { kind: "list" }>): string => {
  const count = `<p style="${FONT}margin:4px 0 0;font-size:20px;font-weight:700;color:${INK};">${visual.count.toLocaleString("en-US")} <span style="font-size:13px;font-weight:400;color:${MUTED};">${visual.count === 1 ? "record" : "records"}</span></p>`;
  if (visual.items.length === 0) return count;
  const items = visual.items
    .map(
      (item) =>
        `<tr><td style="${FONT}padding:6px 0;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">${escape(item.title)}${item.detail ? `<br><span style="font-size:12px;color:${MUTED};">${escape(item.detail)}</span>` : ""}</td></tr>`,
    )
    .join("");
  return `${count}<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:6px;">${items}</table>${visual.more > 0 ? small(`and ${visual.more.toLocaleString("en-US")} more`) : ""}`;
};

const visualHtml = (visual: ReportVisual, accent: string): string => {
  switch (visual.kind) {
    case "number":
      return big(visual.value) + changeLine(visual.change);
    case "bars":
      return barsHtml(visual, accent);
    case "trend":
      return trendHtml(visual, accent);
    case "list":
      return listHtml(visual);
  }
};

const title = (text: string, size = 14) => `<p style="${FONT}margin:0;font-size:${size}px;font-weight:600;color:${INK};">${escape(text)}</p>`;
const problem = (text: string) => `<p style="${FONT}margin:4px 0 0;font-size:13px;color:#b45309;">${escape(text)}</p>`;

const sectionHtml = (section: ReportSection, accent: string, withTitle: boolean): string => {
  switch (section.kind) {
    case "text":
      return prose(section.markdown, `${FONT}margin:0 0 8px;font-size:14px;line-height:1.5;color:${INK};`);
    case "value":
      return (
        (withTitle ? title(section.name) : "") +
        (section.visual ? visualHtml(section.visual, accent) : "") +
        (section.since ? small(`Kept since ${section.since}`) : "") +
        (section.error ? problem(section.error) : "")
      );
    case "widget":
      return (withTitle ? title(section.title) : "") + (section.error ? problem(section.error) : section.visual ? visualHtml(section.visual, accent) : "");
  }
};

const summaryHtml = (summary: string | undefined): string =>
  summary ? `<div style="margin:6px 0 4px;">${prose(summary, `${FONT}margin:0 0 8px;font-size:15px;line-height:1.55;color:${INK};`)}</div>` : "";

const partHtml = (part: ReportPart, summary: string | undefined, accent: string): string => {
  const cell = (inner: string, top = 16) => `<tr><td style="padding:${top}px 0 4px;">${inner}</td></tr>`;
  if (part.heading) {
    /* A whole tab: its name, one summary, then each widget's picture. */
    return (
      `<tr><td style="padding:20px 0 0;border-top:1px solid ${LINE};"><p style="${FONT}margin:0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">${escape(part.heading)}</p>${summaryHtml(summary)}</td></tr>` +
      part.sections.map((section) => cell(sectionHtml(section, accent, true), 12)).join("")
    );
  }
  const [only] = part.sections;
  if (!only) return "";
  if (only.kind === "text") return cell(sectionHtml(only, accent, false));
  /* One widget or value: its name, its summary, then its picture. */
  const name = only.kind === "widget" ? only.title : only.name;
  return `<tr><td style="padding:20px 0 4px;border-top:1px solid ${LINE};">${title(name, 15)}${summaryHtml(summary)}${sectionHtml(only, accent, false)}</td></tr>`;
};

/* ── plain text ────────────────────────────────────────────────────────── */

const visualText = (visual: ReportVisual): string[] => {
  switch (visual.kind) {
    case "number":
      return [`  ${visual.value}${visual.change ? ` (${visual.change.text})` : ""}`];
    case "trend":
      return [`  ${visual.latest}${visual.change ? ` (${visual.change.text})` : ""}`];
    case "bars":
      return [...visual.bars.map((bar) => `  ${bar.label}: ${bar.text}`), ...(visual.more > 0 ? [`  and ${visual.more} more${visual.moreText ? ` (${visual.moreText} in all)` : ""}`] : [])];
    case "list":
      return [
        `  ${visual.count} ${visual.count === 1 ? "record" : "records"}`,
        ...visual.items.map((item) => `  - ${item.title}${item.detail ? ` (${item.detail})` : ""}`),
        ...(visual.more > 0 ? [`  and ${visual.more} more`] : []),
      ];
  }
};

const sectionText = (section: ReportSection, withTitle: boolean): string[] => {
  switch (section.kind) {
    case "text":
      return [plainProse(section.markdown)];
    case "value":
      return [...(withTitle ? [section.name] : []), ...(section.visual ? visualText(section.visual) : []), ...(section.error ? [`  ${section.error}`] : [])];
    case "widget":
      return [...(withTitle ? [section.title] : []), ...(section.error ? [`  ${section.error}`] : section.visual ? visualText(section.visual) : [])];
  }
};

const partText = (part: ReportPart, summary: string | undefined): string[] => {
  if (part.heading) return ["", part.heading.toUpperCase(), ...(summary ? [plainProse(summary)] : []), ...part.sections.flatMap((section) => ["", ...sectionText(section, true)])];
  const [only] = part.sections;
  if (!only) return [];
  if (only.kind === "text") return ["", ...sectionText(only, false)];
  return ["", only.kind === "widget" ? only.title : only.name, ...(summary ? [plainProse(summary)] : []), ...sectionText(only, false)];
};

export const renderReportEmail = (parts: EmailParts): RenderedEmail => {
  const accent = colour(parts.agent?.color, colour(parts.brand.accent, "#4f46e5"));
  const from = parts.agent ? `${parts.agent.name} · ${parts.brand.name}` : parts.brand.name;
  const subject = `${parts.reportName} · ${parts.dateLine}`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:10px;border-top:4px solid ${accent};">
<tr><td style="padding:24px 28px 8px;">
<p style="${FONT}margin:0;font-size:12px;font-weight:600;color:${accent};">${escape(from)}</p>
<h1 style="${FONT}margin:6px 0 2px;font-size:22px;color:${INK};">${escape(parts.reportName)}</h1>
<p style="${FONT}margin:0;font-size:13px;color:${MUTED};">${escape(parts.dateLine)}</p>
</td></tr>
<tr><td style="padding:0 28px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${parts.parts.map((part) => partHtml(part, parts.summaries[part.key], accent)).join("")}</table></td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${LINE};">
<p style="${FONT}margin:0;font-size:12px;color:${MUTED};">${escape(parts.scheduleLine)}. <a href="${escape(parts.manageUrl)}" style="color:${accent};">Manage this report</a> · <a href="${escape(parts.unsubscribeUrl)}" style="color:${MUTED};">Unsubscribe</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    from,
    parts.reportName,
    parts.dateLine,
    ...parts.parts.flatMap((part) => partText(part, parts.summaries[part.key])),
    "",
    "--",
    `${parts.scheduleLine}.`,
    `Manage this report: ${parts.manageUrl}`,
    `Unsubscribe: ${parts.unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
};
