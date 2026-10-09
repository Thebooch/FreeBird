import type { ReportSection, ReportTable } from "./build.js";

/**
 * A report as an email: HTML for mail apps, and the same words as plain text,
 * which always goes too. Inline styles and tables only, because that is what
 * mail apps draw. Pure: the same inputs make the same email, which is what
 * the preview shows.
 */

export interface EmailParts {
  readonly reportName: string;
  /** The workspace's name and colour. */
  readonly brand: { readonly name: string; readonly accent: string };
  /** The agent it comes from, when one is set: its name and colour on top. */
  readonly agent?: { readonly name: string; readonly color: string } | undefined;
  /** The written summary, in paragraphs. Absent: none. */
  readonly summary?: string | undefined;
  readonly sections: readonly ReportSection[];
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

const changeColour = (direction: "up" | "down" | "flat"): string => (direction === "flat" ? MUTED : direction === "up" ? "#047857" : "#b91c1c");

const tableHtml = (table: ReportTable): string => {
  if (table.rows.length === 0) return `<p style="${FONT}margin:4px 0 0;font-size:13px;color:${MUTED};">Nothing to show.</p>`;
  const head = table.headers.map((one) => `<th align="left" style="${FONT}padding:6px 8px;font-size:12px;font-weight:600;color:${MUTED};border-bottom:1px solid ${LINE};">${escape(one)}</th>`).join("");
  const body = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td style="${FONT}padding:6px 8px;font-size:13px;color:${INK};border-bottom:1px solid ${LINE};">${escape(cell)}</td>`).join("")}</tr>`)
    .join("");
  const more = table.more > 0 ? `<p style="${FONT}margin:6px 0 0;font-size:12px;color:${MUTED};">and ${table.more.toLocaleString("en-US")} more</p>` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-top:6px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
};

const sectionHtml = (section: ReportSection): string => {
  const card = (inner: string) => `<tr><td style="padding:12px 0;border-top:1px solid ${LINE};">${inner}</td></tr>`;
  const title = (text: string, note?: string) =>
    `<p style="${FONT}margin:0;font-size:14px;font-weight:600;color:${INK};">${escape(text)}${note ? ` <span style="font-weight:400;color:${MUTED};">· ${escape(note)}</span>` : ""}</p>`;
  const error = (text: string) => `<p style="${FONT}margin:4px 0 0;font-size:13px;color:#b45309;">${escape(text)}</p>`;
  const big = (value: string) => `<p style="${FONT}margin:4px 0 0;font-size:26px;font-weight:700;color:${INK};">${escape(value)}</p>`;
  const change = (text: string, direction: "up" | "down" | "flat") => `<p style="${FONT}margin:2px 0 0;font-size:13px;color:${changeColour(direction)};">${escape(text)}</p>`;
  switch (section.kind) {
    case "heading":
      return `<tr><td style="padding:20px 0 4px;"><p style="${FONT}margin:0;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">${escape(section.title)}</p></td></tr>`;
    case "text":
      return card(prose(section.markdown, `${FONT}margin:0 0 8px;font-size:14px;line-height:1.5;color:${INK};`));
    case "value":
      return card(
        title(section.name) +
          (section.value !== null ? big(section.value) : "") +
          (section.change ? change(section.change.text, section.change.direction) : "") +
          (section.since ? `<p style="${FONT}margin:2px 0 0;font-size:12px;color:${MUTED};">Kept since ${escape(section.since)}</p>` : "") +
          (section.error ? error(section.error) : ""),
      );
    case "widget":
      return card(
        title(section.title) +
          (section.error
            ? error(section.error)
            : (section.headline !== undefined ? big(section.headline) : "") +
              (section.change ? change(section.change.text, section.change.direction) : "") +
              (section.table ? tableHtml(section.table) : "")),
      );
  }
};

const tableText = (table: ReportTable): string[] => {
  if (table.rows.length === 0) return ["  Nothing to show."];
  return [
    `  ${table.headers.join(" | ")}`,
    ...table.rows.map((row) => `  ${row.join(" | ")}`),
    ...(table.more > 0 ? [`  and ${table.more} more`] : []),
  ];
};

const sectionText = (section: ReportSection): string[] => {
  switch (section.kind) {
    case "heading":
      return ["", section.title.toUpperCase()];
    case "text":
      return ["", plainProse(section.markdown)];
    case "value":
      return [
        "",
        `${section.name}: ${section.value ?? "—"}${section.change ? ` (${section.change.text})` : ""}`,
        ...(section.error ? [`  ${section.error}`] : []),
      ];
    case "widget":
      return [
        "",
        section.headline !== undefined ? `${section.title}: ${section.headline}${section.change ? ` (${section.change.text})` : ""}` : section.title,
        ...(section.error ? [`  ${section.error}`] : section.table ? tableText(section.table) : []),
      ];
  }
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
${parts.summary ? `<tr><td style="padding:12px 28px 4px;">${prose(parts.summary, `${FONT}margin:0 0 10px;font-size:15px;line-height:1.55;color:${INK};`)}</td></tr>` : ""}
<tr><td style="padding:4px 28px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${parts.sections.map(sectionHtml).join("")}</table></td></tr>
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
    ...(parts.summary ? ["", plainProse(parts.summary)] : []),
    ...parts.sections.flatMap(sectionText),
    "",
    "--",
    `${parts.scheduleLine}.`,
    `Manage this report: ${parts.manageUrl}`,
    `Unsubscribe: ${parts.unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
};
