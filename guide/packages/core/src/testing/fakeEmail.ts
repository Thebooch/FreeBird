import type { EmailAdapter, EmailMessage } from "../adapters/email.js";

/** Email adapter that keeps an in-memory log. Great for snapshot-style tests. */
export class FakeEmail implements EmailAdapter {
  readonly defaultFrom: string;
  readonly sent: EmailMessage[] = [];

  constructor(from = "freebird-tests@example.com") {
    this.defaultFrom = from;
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    this.sent.push(msg);
    return { id: `fake_${this.sent.length}` };
  }
}

export const createFakeEmail = (from?: string): FakeEmail => new FakeEmail(from);
