/**
 * The public pages' API: `/api/public/<workspace>/…`, with the token in the
 * path. Nobody is signed in; what a page may do comes from its token.
 */

export interface Brand {
  readonly name: string;
  readonly accent: string;
}

export interface PublicType {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly minutes: number;
  readonly location: { readonly kind: string; readonly words: string };
  /** Requests wait for the team to confirm them. */
  readonly approval: boolean;
  readonly showHostName: boolean;
  /** People to pick between, when the person picks their host. */
  readonly hosts: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export type BookingStatus = "pending" | "confirmed" | "suggested" | "denied" | "cancelled" | "expired" | "completed" | "no_show";

export interface PublicBooking {
  readonly id: string;
  readonly status: BookingStatus;
  readonly statusWords: string;
  readonly type: string;
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly host?: string;
  readonly where: string;
  readonly holdUntil?: string;
  readonly suggestions?: ReadonlyArray<{ readonly id: string; readonly start: string; readonly end: string; readonly holdUntil: string; readonly host?: string }>;
  /** A move waiting for the team to approve it; the booking keeps its time meanwhile. */
  readonly change?: { readonly start: string; readonly end: string };
  readonly message?: string;
  readonly canCancel: boolean;
  readonly canReschedule: boolean;
  readonly insideCutoff: boolean;
}

export interface LinkState {
  readonly workspace: Brand;
  readonly contact: { readonly name: string; readonly timezone: string | null };
  readonly type: PublicType | null;
  readonly types: readonly PublicType[];
  readonly booking: PublicBooking | null;
  readonly canBook: boolean;
}

export interface Slot {
  readonly start: string;
  readonly end: string;
  readonly approval: boolean;
  readonly recommended: boolean;
}

export interface Question {
  readonly field: string;
  readonly question: string;
  readonly kind: string;
  readonly choices?: readonly string[];
  readonly required: boolean;
}

export interface TimesResult {
  readonly slots: readonly Slot[];
  readonly questions: readonly Question[];
  /** Only times next to a matching appointment were kept; `more` says others exist. */
  readonly consolidatedOnly: boolean;
  readonly more: boolean;
  /** The type doesn't take them, in its own words: nothing is offered. */
  readonly notEligible?: string;
}

export interface TypePage {
  readonly workspace: Brand;
  readonly type: PublicType;
  readonly open: boolean;
  /** This browser started already: its own page. */
  readonly personal?: string;
}

export interface ApprovalState {
  readonly workspace: Brand;
  readonly member: { readonly name: string; readonly email: string; readonly timezone: string };
  readonly booking: {
    readonly id: string;
    readonly type: string;
    readonly description: string;
    readonly start: string;
    readonly end: string;
    readonly status: BookingStatus;
    readonly statusWords: string;
    readonly where: string;
    readonly holdUntil?: string;
    readonly change?: { readonly start: string; readonly end: string };
    readonly contact: { readonly name: string; readonly email: string; readonly phone: string };
    readonly notes: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    readonly facts: readonly string[];
    readonly suggestions?: ReadonlyArray<{ readonly start: string; readonly end: string }>;
  };
  readonly ask: { readonly question: string; readonly allowSuggest: boolean; readonly allowDeny: boolean; readonly maxSuggestions: number } | null;
  readonly open: boolean;
  readonly closed?: string;
  readonly decided?: { readonly outcome: "approved" | "suggested" | "denied"; readonly by: string; readonly at: string; readonly message?: string };
  readonly day: ReadonlyArray<{ readonly start: string; readonly end: string; readonly label: string; readonly status: string; readonly current: boolean }>;
}

export class PublicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly slots?: readonly Slot[],
  ) {
    super(message);
  }
}

const call = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; slots?: Slot[] };
  if (!response.ok) {
    const message = response.status === 429 ? "Too many requests. Wait a minute, then try again." : (data.error ?? "Something went wrong. Try again.");
    throw new PublicApiError(message, response.status, data.slots);
  }
  return data as T;
};

const base = (workspace: string) => `/api/public/${encodeURIComponent(workspace)}`;

export const bookingApi = (workspace: string, token: string) => {
  const root = `${base(workspace)}/book/${encodeURIComponent(token)}`;
  return {
    state: () => call<LinkState>(root),
    times: (input: { readonly type?: string; readonly from: string; readonly to: string; readonly all?: boolean; readonly host?: string; readonly request?: Readonly<Record<string, string>> }) => call<TimesResult>(`${root}/times`, input),
    answers: (answers: Readonly<Record<string, unknown>>) => call<{ problems: Record<string, string> }>(`${root}/answers`, { answers }),
    request: (input: { readonly type?: string; readonly start: string; readonly host?: string; readonly notes?: string; readonly where?: string; readonly timezone?: string; readonly request?: Readonly<Record<string, string>> }) =>
      call<LinkState>(`${root}/request`, input),
    cancel: (booking: string) => call<LinkState>(`${root}/cancel`, { booking }),
    reschedule: (booking: string, start: string, host?: string) => call<LinkState>(`${root}/reschedule`, { booking, start, ...(host ? { host } : {}) }),
    accept: (booking: string, suggestion: string) => call<LinkState>(`${root}/accept`, { booking, suggestion }),
    decline: (booking: string) => call<LinkState>(`${root}/decline`, { booking }),
    icsUrl: () => `${root}/ics`,
  };
};

export const typeApi = (workspace: string, slug: string) => {
  const root = `${base(workspace)}/types/${encodeURIComponent(slug)}`;
  return {
    page: () => call<TypePage>(root),
    start: (input: { readonly name: string; readonly email: string; readonly phone?: string; readonly timezone?: string; readonly website: string }) => call<{ page: string }>(`${root}/start`, input),
  };
};

export const approvalApi = (workspace: string, token: string) => {
  const root = `${base(workspace)}/approve/${encodeURIComponent(token)}`;
  return {
    state: () => call<ApprovalState>(root),
    times: (from: string, to: string) => call<{ host: { name: string; self: boolean }; slots: Slot[] }>(`${root}/times`, { from, to }),
    answer: (input: { readonly answer: "approve" | "suggest" | "deny"; readonly times?: ReadonlyArray<{ readonly start: string }>; readonly message?: string; readonly reason?: string; readonly allowOutside?: boolean }) =>
      call<ApprovalState>(root, input),
  };
};
