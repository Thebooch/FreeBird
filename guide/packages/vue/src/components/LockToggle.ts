import { defineComponent, computed, h } from "vue";
import { useFreeBird } from "../composables/useFreeBird.js";

/**
 * Per-cell lock toggle. Renders a button whose `aria-pressed` reflects
 * the lock state. Fully unstyled. Optional scoped slot exposes `{ locked,
 * toggle }` if you want to supply your own icon / markup.
 */
export const LockToggle = defineComponent({
  name: "FreeBirdLockToggle",
  props: {
    instanceId: { type: String, required: true },
  },
  setup(props, { slots }) {
    const fb = useFreeBird();
    const locked = computed<boolean>(
      () =>
        !!fb.layout.value?.cells.find((c) => c.instanceId === props.instanceId)
          ?.locked,
    );
    const toggle = () => fb.toggleLock(props.instanceId);
    return () =>
      h(
        "button",
        {
          type: "button",
          "data-freebird-lock-toggle": "",
          "data-locked": locked.value ? "" : undefined,
          "aria-pressed": locked.value,
          onClick: (e: MouseEvent) => {
            if (!e.defaultPrevented) toggle();
          },
        },
        slots.default
          ? slots.default({ locked: locked.value, toggle })
          : locked.value
            ? "Locked"
            : "Unlocked",
      );
  },
});
