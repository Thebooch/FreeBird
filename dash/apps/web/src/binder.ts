/**
 * The deterministic binder, re-exported.
 *
 * It moved into `@freebirdai/dash-agent` when the concierge needed the same rules on the
 * server: which fields may fill which role is a decision that must have one
 * implementation, or the widget palette and the guided setup would offer
 * different answers for the same endpoint.
 *
 * This file stays as the web app's import surface so nothing here had to
 * change, and because `SampleField` from the API client satisfies
 * `BindableField` structurally without a conversion.
 */
export {
  buildWidget,
  coercionsFor,
  componentFits,
  fieldsForRole,
  missingRoles,
  unfillableRoles,
  valueTypesOf,
  widgetId,
} from "@freebirdai/dash-agent";
export type { BindableField, BuildInput, RoleBinding } from "@freebirdai/dash-agent";
