import type {
  EntityWritesView,
  WriteCommitView,
  WriteFieldError,
  WriteFormView,
  WriteReviewView,
} from "@freebirdai/dash-spec";

/**
 * Talking to the server about changes to connected accounts.
 *
 * Its own module rather than more of `api.ts`, because a refused change says
 * more than an error message: which values were wrong, whether anything was
 * sent, and — when the record moved under the review — the new review to look
 * at instead. All of that has to reach the screen intact.
 */

export class WriteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly fields?: readonly WriteFieldError[],
    readonly detail?: string,
    readonly outcome?: "not-sent" | "unknown",
    readonly review?: WriteReviewView,
  ) {
    super(message);
    this.name = "WriteApiError";
  }
}

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new WriteApiError("The Dash server isn't responding. Is it running?", 0);
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new WriteApiError(
      typeof payload?.["error"] === "string" ? payload["error"] : `Request failed (${response.status})`,
      response.status,
      typeof payload?.["code"] === "string" ? payload["code"] : undefined,
      Array.isArray(payload?.["fields"]) ? (payload["fields"] as WriteFieldError[]) : undefined,
      typeof payload?.["detail"] === "string" ? payload["detail"] : undefined,
      payload?.["outcome"] === "not-sent" || payload?.["outcome"] === "unknown" ? payload["outcome"] : undefined,
      payload?.["review"] ? (payload["review"] as WriteReviewView) : undefined,
    );
  }
  return payload as T;
};

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const at = (id: string) => `/api/connections/${encodeURIComponent(id)}`;

/** What each record type on a connection can have done to it, for the Changes panel and boards. */
export interface ConnectionWrites {
  readonly canManage: boolean;
  readonly writeOpCount: number;
  readonly writesVersion: number | null;
  readonly rereadable: boolean;
  readonly entities: ReadonlyArray<{
    readonly id: string;
    readonly name: { readonly one: string; readonly many: string };
    readonly writes: EntityWritesView;
    /** What whoever is asking may do — everything the API offers, in the open-source build. */
    readonly allowed?: EntityWritesView;
    readonly unmatched: ReadonlyArray<{ readonly op: string; readonly field: string; readonly label: string }>;
    readonly inferred: boolean;
  }>;
}

export interface ChangeAddress {
  readonly kind: "create" | "update" | "delete" | "action";
  readonly action?: string;
  readonly id?: string;
  readonly parents?: Readonly<Record<string, string>>;
}

export const writesApi = {
  connection: (id: string): Promise<ConnectionWrites> => call(`${at(id)}/writes`),

  form: (connection: string, entity: string, address: ChangeAddress): Promise<WriteFormView> =>
    call(`${at(connection)}/entities/${encodeURIComponent(entity)}/writes/form`, send("POST", address)),

  prepare: (
    connection: string,
    entity: string,
    address: ChangeAddress,
    values: Readonly<Record<string, unknown>>,
  ): Promise<WriteReviewView> =>
    call(`${at(connection)}/writes/prepare`, send("POST", { entity, ...address, values })),

  review: (pendingId: string): Promise<WriteReviewView> => call(`/api/writes/${encodeURIComponent(pendingId)}`),

  commit: (review: Pick<WriteReviewView, "pendingId" | "digest">): Promise<WriteCommitView> =>
    call(`/api/writes/${encodeURIComponent(review.pendingId)}/commit`, send("POST", { digest: review.digest })),

  discard: (pendingId: string): Promise<unknown> =>
    call(`/api/writes/${encodeURIComponent(pendingId)}`, { method: "DELETE" }),

  setField: (
    connection: string,
    opId: string,
    change: { field: string; readFrom?: string | null; label?: string; hidden?: boolean },
  ): Promise<unknown> => call(`${at(connection)}/writes/${encodeURIComponent(opId)}/fields`, send("PUT", change)),

  match: (connection: string, entity: string): Promise<{ matched: number; refused: string[]; unmatched: string[] }> =>
    call(`${at(connection)}/writes/map`, send("POST", { entity })),

  refresh: (catalogId: string): Promise<{ writes: number; added: number; removed: number }> =>
    call(`/api/catalog/${encodeURIComponent(catalogId)}/writes/refresh`, { method: "POST" }),
};
