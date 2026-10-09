/**
 * The parts every message is built from: a 600px table layout with inline
 * styles (what mail clients reliably draw), bulletproof buttons, and a
 * dark-mode block for the clients that read one. Each part returns template
 * source with `{{ name }}` left in place for `render` to fill.
 *
 * `{{ brandName }}` and `{{ accent }}` are in every frame: the workspace's
 * name and color (`brandOf` keeps the color a plain hex value).
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#111827";
const SOFT = "#4b5563";
const FAINT = "#6b7280";
const LINE = "#e5e7eb";

const DARK = `
  @media (prefers-color-scheme: dark) {
    .fb-page { background:#0f1115 !important; }
    .fb-card { background:#171a20 !important; border-color:#2a2f38 !important; }
    .fb-panel { background:#1d2129 !important; border-color:#2a2f38 !important; }
    .fb-ink { color:#e8eaee !important; }
    .fb-soft { color:#b4bac4 !important; }
    .fb-faint { color:#8b93a1 !important; }
    .fb-line { border-color:#2a2f38 !important; }
    .fb-quiet { background:#171a20 !important; border-color:#3a404b !important; }
    .fb-quiet a { color:#e8eaee !important; }
  }
  @media (max-width:620px) {
    .fb-wrap { width:100% !important; }
    .fb-pad { padding:24px 20px !important; }
    .fb-label { width:84px !important; }
  }`;

/** A whole message: the brand line, one card holding `body`, and the small print under it. */
export const frame = (parts: { readonly preheader: string; readonly body: string; readonly footer: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>${DARK}
</style>
</head>
<body class="fb-page" style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;">${parts.preheader}</div>
<table role="presentation" class="fb-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="fb-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td class="fb-ink" style="padding:0 4px 14px 4px;font:600 15px/20px ${FONT};color:${INK};"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:{{ accent }};margin-right:8px;vertical-align:1px;"></span>{{ brandName }}</td></tr>
<tr><td class="fb-card" style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="height:4px;line-height:4px;font-size:0;background:{{ accent }};border-radius:12px 12px 0 0;">&nbsp;</td></tr>
<tr><td class="fb-pad" style="padding:32px 36px;">
${parts.body}
</td></tr>
</table>
</td></tr>
<tr><td class="fb-faint" style="padding:16px 4px 0 4px;font:12px/18px ${FONT};color:${FAINT};">${parts.footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

export const heading = (source: string): string =>
  `<h1 class="fb-ink" style="margin:0 0 12px 0;font:600 22px/28px ${FONT};color:${INK};letter-spacing:-0.2px;">${source}</h1>`;

export const lead = (source: string): string => `<p class="fb-soft" style="margin:0 0 24px 0;font:15px/23px ${FONT};color:${SOFT};">${source}</p>`;

export const small = (source: string): string => `<p class="fb-faint" style="margin:20px 0 0 0;font:13px/20px ${FONT};color:${FAINT};">${source}</p>`;

/** A labelled box of rows: what, when, where, who. */
export const details = (rows: ReadonlyArray<readonly [label: string, value: string]>): string => {
  const lines = rows
    .map(
      ([label, value], index) => `<tr>
<td class="fb-faint fb-label fb-line" valign="top" style="width:96px;padding:${index === 0 ? "0" : "10px"} 12px 10px 0;font:600 12px/20px ${FONT};color:${FAINT};text-transform:uppercase;letter-spacing:0.4px;${index === rows.length - 1 ? "" : `border-bottom:1px solid ${LINE};`}">${label}</td>
<td class="fb-ink fb-line" valign="top" style="padding:${index === 0 ? "0" : "10px"} 0 10px 0;font:15px/20px ${FONT};color:${INK};${index === rows.length - 1 ? "" : `border-bottom:1px solid ${LINE};`}">${value}</td>
</tr>`,
    )
    .join("\n");
  return `<table role="presentation" class="fb-panel" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border:1px solid ${LINE};border-radius:10px;margin:0 0 24px 0;">
<tr><td style="padding:16px 18px 6px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${lines}
</table>
</td></tr>
</table>`;
};

/** A titled block of text; use `{{ name | paragraphs }}` for several lines. */
export const section = (title: string, source: string): string => `<p class="fb-faint" style="margin:0 0 6px 0;font:600 12px/18px ${FONT};color:${FAINT};text-transform:uppercase;letter-spacing:0.4px;">${title}</p>
<div class="fb-ink" style="margin:0 0 20px 0;font:14px/21px ${FONT};color:${INK};">${source}</div>`;

/** A button drawn by a table cell, so it shows in clients that drop padding on links. */
export const button = (href: string, label: string, kind: "primary" | "quiet" = "primary"): string =>
  kind === "primary"
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:0 8px 8px 0;"><tr><td align="center" bgcolor="{{ accent }}" style="border-radius:8px;background:{{ accent }};"><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;font:600 14px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a></td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:0 8px 8px 0;"><tr><td class="fb-quiet" align="center" bgcolor="#ffffff" style="border-radius:8px;background:#ffffff;border:1px solid #d1d5db;"><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:11px 20px;font:600 14px/20px ${FONT};color:${INK};text-decoration:none;border-radius:8px;">${label}</a></td></tr></table>`;

export const buttons = (...each: string[]): string => `<div style="margin:4px 0 0 0;">${each.join("")}</div>`;
