import { Resend } from "resend";
import type { EmailAdapter, EmailMessage } from "@freebirdai/core";

export interface ResendAdapterOptions {
  apiKey?: string;
  /** Default "from" address (must be verified in Resend). */
  from: string;
}

export class ResendAdapter implements EmailAdapter {
  readonly defaultFrom: string;
  private readonly client: Resend;

  constructor(opts: ResendAdapterOptions) {
    this.defaultFrom = opts.from;
    this.client = new Resend(opts.apiKey ?? process.env.RESEND_API_KEY);
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    const res = await this.client.emails.send({
      from: msg.from ?? this.defaultFrom,
      to: Array.isArray(msg.to) ? msg.to : [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    if (res.error) {
      throw new Error(`Resend error: ${res.error.message}`);
    }
    return { id: res.data?.id ?? "" };
  }
}

export const createResendAdapter = (opts: ResendAdapterOptions): ResendAdapter =>
  new ResendAdapter(opts);
