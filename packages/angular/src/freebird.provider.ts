import type { EnvironmentProviders, Provider } from "@angular/core";
import { makeEnvironmentProviders } from "@angular/core";
import type { ComponentRegistry, LayoutPlan } from "@freebirdai/core";
import {
  FetchTransport,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdTransport,
} from "@freebirdai/core-state";
import { FREEBIRD_REGISTRY, FREEBIRD_STORE } from "./freebird.tokens";

export interface ProvideFreeBirdOptions {
  registry: ComponentRegistry<unknown, unknown>;
  /** Override the default FetchTransport. */
  transport?: FreeBirdTransport;
  /** Options passed to the default FetchTransport when `transport` is omitted. */
  transportOptions?: FetchTransportOptions;
  /**
   * Advanced: pass a pre-built FreeBirdStore. Useful for SSR hydration or
   * when you want to share one store across bootstrap scopes.
   */
  store?: FreeBirdStore;
  /** Initial session id if the host app already created one. */
  initialSessionId?: string;
  /** Initial layout if the host app wants to hydrate one. */
  initialLayout?: LayoutPlan | null;
}

/**
 * Standalone DI helper. Use inside `bootstrapApplication`:
 *
 *   bootstrapApplication(AppComponent, {
 *     providers: [
 *       provideFreeBird({ registry }),
 *     ],
 *   });
 */
export function provideFreeBird(
  options: ProvideFreeBirdOptions,
): EnvironmentProviders {
  if (!options?.registry) {
    throw new Error("provideFreeBird: `registry` option is required.");
  }

  const providers: Provider[] = [
    { provide: FREEBIRD_REGISTRY, useValue: options.registry },
    {
      provide: FREEBIRD_STORE,
      useFactory: (): FreeBirdStore => {
        if (options.store) return options.store;
        const transport =
          options.transport ?? new FetchTransport(options.transportOptions ?? {});
        return new FreeBirdStore(transport, {
          sessionId: options.initialSessionId ?? null,
          layout: options.initialLayout ?? null,
        });
      },
    },
  ];

  return makeEnvironmentProviders(providers);
}
