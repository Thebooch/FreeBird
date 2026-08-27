import { defineComponent, h } from "vue";
import { useFreeBird } from "../composables/useFreeBird.js";

/**
 * "Info" button bound to a component id. On click, broadcasts an explain
 * event. Any mounted `useChat` picks it up and streams an explanation
 * based on the component's knowledge items.
 */
export const InfoTrigger = defineComponent({
  name: "FreeBirdInfoTrigger",
  props: {
    componentId: { type: String, required: true },
    ariaLabel: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    const fb = useFreeBird();
    return () =>
      h(
        "button",
        {
          type: "button",
          "aria-label": props.ariaLabel ?? `Explain ${props.componentId}`,
          "data-freebird-info-trigger": "",
          "data-component": props.componentId,
          onClick: (e: MouseEvent) => {
            if (!e.defaultPrevented) fb.broadcastExplain(props.componentId);
          },
        },
        slots.default
          ? slots.default()
          : h(
              "span",
              {
                "aria-hidden": "true",
                style: { fontStyle: "italic", fontWeight: 700 },
              },
              "i",
            ),
      );
  },
});
