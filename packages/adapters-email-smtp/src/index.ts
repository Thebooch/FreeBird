import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { EmailAdapter, EmailMessage } from "@freebirdai/core";

export interface SmtpAdapterOptions {
  /** nodemailer transport options (host/port/auth/etc.). */
  transport: Parameters<typeof nodemailer.createTransport>[0];
  /** Default "from" address used when a message doesn't provide one. */
  from: string;
}

export class SmtpAdapter implements EmailAdapter {
  readonly defaultFrom: string;
  private readonly transporter: Transporter;

  constructor(opts: SmtpAdapterOptions) {
    this.defaultFrom = opts.from;
    this.transporter = nodemailer.createTransport(opts.transport);
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    const info = await this.transporter.sendMail({
      from: msg.from ?? this.defaultFrom,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { id: info.messageId ?? "" };
  }
}

export const createSmtpAdapter = (opts: SmtpAdapterOptions): SmtpAdapter => new SmtpAdapter(opts);
