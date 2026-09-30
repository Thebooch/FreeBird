import { AdapterError, type FetchContext, type FetchResult, type SourceAdapter } from "@freebirdai/dash-adapters";
import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import type { CredentialBroker } from "./broker.js";

/**
 * Every read may wait out a short rate limit and carry on.
 *
 * A read of forty-two pages behind a limit of about thirty requests was
 * refused at page thirty-one every time it was tried, and started again from
 * page one (checkpoint 2). The reader waits where the API says to — only for
 * reads safe to send twice, and only briefly (`RestAdapter`); this hands it
 * the clock to wait on.
 */
export class RateLimitWaitAdapter implements SourceAdapter {
  readonly kind: SourceAdapter["kind"];
  readonly transport: SourceAdapter["transport"];

  constructor(
    private readonly inner: SourceAdapter,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.kind = inner.kind;
    this.transport = inner.transport;
  }

  fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    return this.inner.fetch(connection, op, overrides, ctx.sleep ? ctx : { ...ctx, sleep: this.sleep });
  }
}

/**
 * A read refused for its token is read once more with a new one.
 *
 * Providers end tokens early — revoked, rotated, or simply shorter-lived than
 * they said — and the first anybody hears of it is a 401. For an OAuth
 * connection the broker can usually get a new token without anybody's help;
 * this asks it to, then reads again, once. A second refusal is an answer, and
 * the connection is left asking to be signed in again. Only reads come
 * through here: a change is never sent twice.
 */
export class OAuthRetryAdapter implements SourceAdapter {
  readonly kind: SourceAdapter["kind"];
  readonly transport: SourceAdapter["transport"];

  constructor(
    private readonly inner: SourceAdapter,
    private readonly broker: CredentialBroker,
  ) {
    this.kind = inner.kind;
    this.transport = inner.transport;
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    if (connection.auth.type !== "oauth2") return this.inner.fetch(connection, op, overrides, ctx);
    try {
      return await this.inner.fetch(connection, op, overrides, {
        ...ctx,
        renew: () => this.broker.refresh(connection),
      });
    } catch (error) {
      if (!(error instanceof AdapterError) || error.status !== 401) throw error;
      throw new AdapterError(error.message, {
        status: 401,
        userMessage: `${connection.title} needs signing in again.`,
        ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}),
      });
    }
  }
}
