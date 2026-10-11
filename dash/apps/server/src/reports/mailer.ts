import { ResendAdapter } from "@freebirdai/adapters-email-resend";
import { SmtpAdapter, type SmtpAdapterOptions } from "@freebirdai/adapters-email-smtp";
import type { EmailAdapter } from "@freebirdai/core";

/**
 * What sends reports, from the environment:
 *
 * - `DASH_EMAIL=resend`: Resend, with `RESEND_API_KEY`.
 * - `DASH_EMAIL=smtp`: any SMTP server, at `DASH_SMTP_URL`
 *   (`smtp://user:pass@host:587`, or `smtp://localhost:1025` for a local Mailpit).
 * - `DASH_EMAIL_FROM`: the address it comes from, e.g. `Reports <reports@example.com>`.
 *
 * Unset, or set wrong: no adapter, and the problem in words, which the
 * Reports pop-up shows. Reports can still be made and previewed.
 */
export const mailerFromEnv = (env: NodeJS.ProcessEnv = process.env): { readonly email: EmailAdapter | null; readonly problem?: string } => {
  const kind = env["DASH_EMAIL"]?.trim().toLowerCase();
  if (!kind) return { email: null };
  const from = env["DASH_EMAIL_FROM"]?.trim();
  if (!from) return { email: null, problem: "DASH_EMAIL is set, but DASH_EMAIL_FROM (the address reports come from) is not." };
  if (kind === "resend") {
    const apiKey = env["RESEND_API_KEY"]?.trim();
    if (!apiKey) return { email: null, problem: "DASH_EMAIL is resend, but RESEND_API_KEY is not set." };
    return { email: new ResendAdapter({ apiKey, from }) };
  }
  if (kind === "smtp") {
    let url: URL;
    try {
      url = new URL(env["DASH_SMTP_URL"]?.trim() || "smtp://localhost:1025");
    } catch {
      return { email: null, problem: "DASH_SMTP_URL is not an address: use smtp://user:pass@host:587." };
    }
    const secure = url.protocol === "smtps:";
    const transport = {
      host: url.hostname,
      port: Number(url.port) || (secure ? 465 : 587),
      secure,
      ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
    };
    /* SMTP options are one of nodemailer's overloads, which its parameter type does not name. */
    return { email: new SmtpAdapter({ transport: transport as SmtpAdapterOptions["transport"], from }) };
  }
  return { email: null, problem: `DASH_EMAIL is "${kind}": use resend or smtp.` };
};
