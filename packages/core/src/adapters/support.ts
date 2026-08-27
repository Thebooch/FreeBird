import type { AuthContext } from "../types.js";
import type { Ticket } from "../support/ticket.js";

export interface SupportSinkResult {
  externalId?: string;
  url?: string;
}

/**
 * Host-provided callback invoked when a ticket is filed. FreeBird does not
 * persist tickets — the sink decides (save, email, webhook, display, etc.).
 */
export interface SupportSink {
  fileTicket(
    ticket: Ticket,
    ctx: { auth: AuthContext; sessionId: string },
  ): Promise<SupportSinkResult | void>;
}
