export interface EmailMessage {
  to: string | string[];
  from?: string;
  subject: string;
  /** Plain-text body. Should always be present for deliverability. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export interface EmailAdapter {
  /** The "from" address used when a message doesn't specify one. */
  readonly defaultFrom: string;
  send: (msg: EmailMessage) => Promise<{ id: string } | void>;
}
