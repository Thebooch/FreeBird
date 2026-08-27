import { InjectionToken } from "@angular/core";
import type { ComponentRegistry } from "@freebirdai/core";
import type { FreeBirdStore } from "@freebirdai/core-state";

/** The live FreeBird state store. Provided by `provideFreeBird()`. */
export const FREEBIRD_STORE = new InjectionToken<FreeBirdStore>("FREEBIRD_STORE");

/** The component registry — typed against Angular's render output (void here). */
export const FREEBIRD_REGISTRY = new InjectionToken<ComponentRegistry<unknown, unknown>>(
  "FREEBIRD_REGISTRY",
);
