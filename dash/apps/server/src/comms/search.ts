import type { MailQuery } from "@freebirdai/dash-spec";

/**
 * The one query syntax (`parseMailQuery`), said the way each provider's own
 * index takes it.
 *
 * Gmail's `q` takes nearly all of it as it is. Microsoft Graph's `$search` is
 * KQL inside double quotes: it has no "unread", so that is checked after the
 * results come back (`graphAfter`), and its dates are `received`.
 */

/** A value with a space in it stays one term. */
const term = (value: string): string => (/\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value);

const slashed = (day: string): string => day.replace(/-/g, "/");

export const gmailQuery = (query: MailQuery): string =>
  [
    ...query.words.map(term),
    ...query.from.map((one) => `from:${term(one)}`),
    ...query.to.map((one) => `to:${term(one)}`),
    ...query.subject.map((one) => `subject:(${one.replace(/[()]/g, "")})`),
    ...(query.hasAttachment ? ["has:attachment"] : []),
    ...(query.unread ? ["is:unread"] : []),
    ...(query.before ? [`before:${slashed(query.before)}`] : []),
    ...(query.after ? [`after:${slashed(query.after)}`] : []),
  ].join(" ");

/** KQL has no double quotes inside the outer pair: they are taken out, and phrases kept with single words. */
const kql = (value: string): string => {
  const clean = value.replace(/["\\]/g, "").trim();
  return /\s/.test(clean) ? `'${clean.replace(/'/g, "")}'` : clean;
};

/** Graph's `$search` value, quotes included. Null when nothing in the query is searchable there. */
export const graphSearch = (query: MailQuery): string | null => {
  const parts = [
    ...query.words.map(kql),
    ...query.from.map((one) => `from:${kql(one)}`),
    ...query.to.map((one) => `to:${kql(one)}`),
    ...query.subject.map((one) => `subject:${kql(one)}`),
    ...(query.hasAttachment ? ["hasattachment:true"] : []),
    ...(query.before ? [`received<${query.before}`] : []),
    ...(query.after ? [`received>=${query.after}`] : []),
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? `"${parts.join(" ")}"` : null;
};
