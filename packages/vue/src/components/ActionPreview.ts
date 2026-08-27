import { defineComponent, h } from "vue";
import { useActionState } from "../composables/useActionState.js";

/**
 * Headless action confirmation preview.
 *
 * Renders nothing when there's no pending action. Otherwise calls the
 * default scoped slot with `{ pending, phase, error, confirm, cancel,
 * pause }` so the host can build a fully custom UI. If no slot is
 * provided, a minimal unstyled fallback is rendered with stable
 * `data-freebird-action-*` hooks.
 *
 * @example
 * <FreeBirdActionPreview v-slot="{ pending, confirm, cancel }">
 *   <Card>
 *     <pre>{{ JSON.stringify(pending.args, null, 2) }}</pre>
 *     <button @click="confirm()">Apply</button>
 *     <button @click="cancel()">Cancel</button>
 *   </Card>
 * </FreeBirdActionPreview>
 */
export const ActionPreview = defineComponent({
  name: "FreeBirdActionPreview",
  props: {
    hideWhileExecuting: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const { phase, pending, lastError, confirm, cancel, pause } =
      useActionState();
    return () => {
      const p = pending.value;
      if (!p || phase.value === "idle") return null;
      if (props.hideWhileExecuting && phase.value === "executing") return null;
      const renderProps = {
        pending: p,
        phase: phase.value,
        error: lastError.value,
        confirm,
        cancel,
        pause,
      };
      if (slots.default) return slots.default(renderProps);
      return defaultPreview(renderProps);
    };
  },
});

const defaultPreview = (p: {
  pending: NonNullable<ReturnType<typeof useActionState>["pending"]["value"]>;
  phase: ReturnType<typeof useActionState>["phase"]["value"];
  error?: string;
  confirm: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  pause: (label?: string) => void;
}) =>
  h(
    "div",
    {
      role: "dialog",
      "aria-label": "Confirm action",
      "data-freebird-action-preview": "",
      "data-phase": p.phase,
    },
    [
      h("div", { "data-freebird-action-preview-header": "" }, [
        h(
          "strong",
          {},
          p.pending.label ?? `${p.pending.componentId}:${p.pending.actionId}`,
        ),
      ]),
      h(
        "pre",
        { "data-freebird-action-preview-body": "" },
        JSON.stringify(p.pending.args, null, 2),
      ),
      p.error
        ? h(
            "div",
            { role: "alert", "data-freebird-action-preview-error": "" },
            p.error,
          )
        : null,
      h("div", { "data-freebird-action-preview-actions": "" }, [
        h(
          "button",
          {
            type: "button",
            disabled: p.phase === "executing" || (p.phase === "collecting" && !p.pending.blockers?.length),
            "data-freebird-action-confirm": "",
            onClick: () => {
              p.confirm();
            },
          },
          "Confirm",
        ),
        h(
          "button",
          {
            type: "button",
            "data-freebird-action-cancel": "",
            onClick: () => {
              p.cancel();
            },
          },
          "Cancel",
        ),
        h(
          "button",
          {
            type: "button",
            "data-freebird-action-pause": "",
            onClick: () => p.pause(),
          },
          "Pause",
        ),
      ]),
    ],
  );
