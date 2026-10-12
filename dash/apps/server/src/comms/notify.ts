import type { EmailAdapter } from "@freebirdai/core";
import type { CommsSettings } from "@freebirdai/dash-spec";
import type { HighlightNotifier } from "../agents/highlights.js";
import type { TeamNotice, TeamNotifier } from "../bookings/notify.js";

/**
 * Telling the team by email: approval requests, reminders, decisions and
 * booking changes (`TeamNotifier`), and highlights an agent found in a message
 * (`HighlightNotifier`).
 *
 * Sent through the system mail that sends reports (`DASH_EMAIL`), never from
 * a customer-facing mailbox. Each goes to the member's own email, or to the
 * workspace's notices address (`CommsSettings.noticesTo`) for a member with
 * none, which on a server nobody signs in to is every notice. Each is sent at
 * most once by its key, across servers.
 */

export interface NoticeDeps {
  readonly email: () => EmailAdapter | null;
  /** Why there is no email, in words, when there is none. */
  readonly emailProblem?: string;
  readonly settings: () => Promise<CommsSettings>;
  readonly claim: (key: string, at: string) => Promise<boolean>;
  readonly release: (key: string) => Promise<void>;
  /** Everyone on the team who should hear about a highlight. */
  readonly team: () => Promise<readonly { readonly email: string }[]>;
  readonly now: () => number;
}

type Outcome = Awaited<ReturnType<TeamNotifier["notify"]>>;

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const sendOnce = async (deps: NoticeDeps, key: string, to: string, message: { readonly subject: string; readonly text: string; readonly html: string }): Promise<Outcome> => {
  const email = deps.email();
  if (!email) return { status: "not_sent", detail: deps.emailProblem ?? "Email is not set up on this server (DASH_EMAIL), so nothing was sent." };
  if (!(await deps.claim(key, new Date(deps.now()).toISOString()))) return { status: "sent", detail: "Already sent." };
  try {
    await email.send({ to, subject: message.subject, text: message.text, html: message.html });
    return { status: "sent" };
  } catch (error) {
    await deps.release(key).catch(() => undefined);
    return { status: "not_sent", detail: error instanceof Error ? error.message : String(error) };
  }
};

/** The address a notice goes to: the member's own, else the workspace's notices address. */
const addressFor = async (deps: NoticeDeps, own: string | undefined): Promise<string | null> => {
  if (own?.trim()) return own.trim();
  const fallback = (await deps.settings()).noticesTo?.trim();
  return fallback ? fallback : null;
};

export const emailTeamNotifier = (deps: NoticeDeps): TeamNotifier => ({
  notify: async (notice: TeamNotice) => {
    const to = await addressFor(deps, notice.member.email);
    if (!to) return { status: "not_sent", detail: "There is no address for team notices: set one under Comms settings. The request is in Waiting for you." };
    return sendOnce(deps, `team:${notice.key}`, to, notice);
  },
});

export const emailHighlightNotifier = (deps: NoticeDeps): HighlightNotifier => ({
  notify: async (event) => {
    const members = (await deps.team()).map((one) => one.email.trim()).filter(Boolean);
    const fallback = await addressFor(deps, undefined);
    const to = [...new Set(members.length > 0 ? members : fallback ? [fallback] : [])];
    if (to.length === 0) return;
    const titles = event.matches.map((one) => one.title).join(", ");
    const subject = `${event.agent.name} flagged a message: ${titles}`;
    const lines = event.matches.map((one) => `- ${one.title}: ${one.reason}`);
    const text = `${event.agent.name} found something you asked to hear about.\n\n${lines.join("\n")}\n\nThe message:\n${event.message.slice(0, 4000)}`;
    const html =
      `<p>${escape(event.agent.name)} found something you asked to hear about.</p><ul>` +
      event.matches.map((one) => `<li><strong>${escape(one.title)}</strong>: ${escape(one.reason)}</li>`).join("") +
      `</ul><p>The message:</p><blockquote style="white-space:pre-wrap">${escape(event.message.slice(0, 4000))}</blockquote>`;
    for (const address of to) await sendOnce(deps, `highlight:${event.conversation ?? ""}:${event.agent.id}:${address}`, address, { subject, text, html });
  },
});
