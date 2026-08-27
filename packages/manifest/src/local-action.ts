import { z } from "zod";
import { localDomDirectiveSchema, type LocalDomDirective } from "./schema.js";

/**
 * The wire contract between a manifest-compiled server registry and the
 * `@freebirdai/embed` runtime.
 *
 * A "local-dom" action executes in the *visitor's browser*, not on the server.
 * The compiled server-side handler doesn't mutate anything — it returns this
 * payload as the action result, the FreeBird server streams it over the
 * existing SSE channel like any other action result, and the embed recognizes
 * the shape (via {@link isLocalActionResult}) and executes the directive
 * against the component's registered DOM region.
 */
export const LOCAL_ACTION_RESULT_KIND = "freebird.local-dom" as const;

export const localActionResultSchema = z.object({
  kind: z.literal(LOCAL_ACTION_RESULT_KIND),
  directive: localDomDirectiveSchema,
  componentId: z.string().min(1),
  /** The component's registered root selector, when known (dom-region). */
  selector: z.string().min(1).optional(),
  /** The component's registered page, when known — see manifestSourceSchema.page. */
  page: z.string().min(1).optional(),
  /** Validated action args (e.g. field values for fill-form). */
  args: z.record(z.unknown()),
});

export type LocalActionResult = z.infer<typeof localActionResultSchema>;

export const isLocalActionResult = (value: unknown): value is LocalActionResult =>
  localActionResultSchema.safeParse(value).success;

export const buildLocalActionResult = (input: {
  directive: LocalDomDirective;
  componentId: string;
  selector?: string;
  page?: string;
  args: Record<string, unknown>;
}): LocalActionResult => ({
  kind: LOCAL_ACTION_RESULT_KIND,
  directive: input.directive,
  componentId: input.componentId,
  ...(input.selector !== undefined ? { selector: input.selector } : {}),
  ...(input.page !== undefined ? { page: input.page } : {}),
  args: input.args,
});
