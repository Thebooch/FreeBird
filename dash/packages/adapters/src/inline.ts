import type { ConnectionSpec, OpSpec } from "@freebirdai/dash-spec";
import { AdapterError, type FetchContext, type FetchResult, type SourceAdapter } from "./types.js";

export type InlineResolver = (
  ctx: FetchContext,
  overrides: Readonly<Record<string, string | number | boolean>>,
) => unknown;

export type InlineFixture = unknown | InlineResolver;

/**
 * Serves canned payloads instead of making a request.
 *
 * This is not a toy: it is how every test in the repo exercises the real
 * pipeline, how the demo dashboard runs with no network and no keys, and how
 * the authoring agent previews a proposed binding against the exact sample it
 * was shown. Following the same philosophy as FreeBird's offline echo LLM, an
 * offline path that goes through the production code is worth more than a
 * mock that goes around it.
 */
export class InlineAdapter implements SourceAdapter {
  readonly kind = "inline" as const;
  readonly transport = "direct" as const;

  private readonly fixtures = new Map<string, InlineFixture>();
  /** Simulated latency, so loading states are visible in the demo. */
  private readonly delayMs: number;

  constructor(
    fixtures: Readonly<Record<string, InlineFixture>> = {},
    options: { delayMs?: number } = {},
  ) {
    for (const [key, fixture] of Object.entries(fixtures)) this.fixtures.set(key, fixture);
    this.delayMs = options.delayMs ?? 0;
  }

  static key(connectionId: string, opId: string): string {
    return `${connectionId}.${opId}`;
  }

  // `InlineFixture` is `unknown | InlineResolver`, which TypeScript collapses
  // to `unknown` — the resolver overload exists so a callback passed inline
  // still gets its parameters typed.
  register(connectionId: string, opId: string, resolver: InlineResolver): this;
  register(connectionId: string, opId: string, fixture: unknown): this;
  register(connectionId: string, opId: string, fixture: InlineFixture): this {
    this.fixtures.set(InlineAdapter.key(connectionId, opId), fixture);
    return this;
  }

  has(connectionId: string, opId: string): boolean {
    return this.fixtures.has(InlineAdapter.key(connectionId, opId));
  }

  async fetch(
    connection: ConnectionSpec,
    op: OpSpec,
    overrides: Readonly<Record<string, string | number | boolean>>,
    ctx: FetchContext,
  ): Promise<FetchResult> {
    const key = InlineAdapter.key(connection.id, op.id);
    if (!this.fixtures.has(key)) {
      throw new AdapterError(`no inline fixture registered for "${key}"`, {
        status: 404,
        userMessage: `This dashboard expects sample data for "${op.title}", but none is loaded.`,
      });
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        ctx.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new AdapterError("request aborted", { status: 499 }));
          },
          { once: true },
        );
      });
    }

    const fixture = this.fixtures.get(key);
    const body = typeof fixture === "function" ? (fixture as InlineResolver)(ctx, overrides) : fixture;

    return {
      body,
      meta: {
        url: `inline:${key}`,
        status: 200,
        fetchedAt: ctx.now,
        durationMs: this.delayMs,
        pages: 1,
        truncated: false,
        warnings: [],
      },
    };
  }
}
