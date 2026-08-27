import { shallowRef, type App, type InjectionKey, type Ref } from "vue";
import type { ComponentRegistry, LayoutPlan } from "@freebirdai/core";
import {
  FetchTransport,
  FreeBirdStore,
  type FetchTransportOptions,
  type FreeBirdState,
  type FreeBirdTransport,
} from "@freebirdai/core-state";

export interface FreeBirdPluginOptions {
  registry: ComponentRegistry<unknown, unknown>;
  /** Override the default FetchTransport. */
  transport?: FreeBirdTransport;
  /** Options passed to the default FetchTransport when `transport` is omitted. */
  transportOptions?: FetchTransportOptions;
  /**
   * Advanced: pass a pre-built FreeBirdStore. Useful for SSR hydration or
   * when sharing one store across multiple Vue apps in the same page.
   */
  store?: FreeBirdStore;
  /** Initial session id if the host app already created one (e.g. during SSR). */
  initialSessionId?: string;
  /** Initial layout if the host app wants to hydrate one. */
  initialLayout?: LayoutPlan | null;
}

/**
 * Context injected under {@link FREEBIRD_KEY}. `state` is a Vue `shallowRef`
 * that mirrors `FreeBirdStore.getState()` — updating whenever the store
 * notifies subscribers. All composables read from this single ref so every
 * consumer re-renders in lock-step.
 */
export interface FreeBirdContext {
  store: FreeBirdStore;
  registry: ComponentRegistry<unknown, unknown>;
  state: Ref<FreeBirdState>;
}

export const FREEBIRD_KEY: InjectionKey<FreeBirdContext> = Symbol("freebird");

/**
 * Vue 3 plugin. Usage:
 *
 *   import { createApp } from "vue";
 *   import { FreeBirdPlugin } from "@freebirdai/vue";
 *   import { registry } from "./freebird-registry";
 *
 *   createApp(App).use(FreeBirdPlugin, { registry }).mount("#app");
 */
export const FreeBirdPlugin = {
  install(app: App, options: FreeBirdPluginOptions): void {
    if (!options?.registry) {
      throw new Error("FreeBirdPlugin: `registry` option is required.");
    }
    const transportOpts = { ...(options.transportOptions ?? {}) };
    const userOnAuthChange = transportOpts.onAuthTokenChange;
    let store: FreeBirdStore;
    const transport =
      options.transport ??
      new FetchTransport({
        ...transportOpts,
        onAuthTokenChange: (token, previous) => {
          if (!token || (previous && previous !== token)) {
            store.invalidateAuth({ clearJournal: !token });
          }
          userOnAuthChange?.(token, previous);
        },
      });
    store =
      options.store ??
      new FreeBirdStore(transport, {
        sessionId: options.initialSessionId ?? null,
        layout: options.initialLayout ?? null,
      });

    const state = shallowRef<FreeBirdState>(store.getState());
    // One subscription per app.use() — cleaned up implicitly when the app
    // unmounts. This matches the React provider's useSyncExternalStore.
    store.subscribe((s) => {
      state.value = s;
    });

    app.provide(FREEBIRD_KEY, { store, registry: options.registry, state });
  },
};
