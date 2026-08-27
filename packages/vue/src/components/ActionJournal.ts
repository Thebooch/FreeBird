import { defineComponent, h, type PropType } from "vue";
import type { ActionRecord, ActionRecordStatus } from "@freebirdai/core";
import { useActionJournal } from "../composables/useActionJournal.js";

const STATUS_LABEL: Record<ActionRecordStatus, string> = {
  in_progress: "In progress",
  paused: "Paused",
  completed: "Completed",
  terminated: "Terminated",
  failed: "Failed",
};

/**
 * Headless action-journal viewer.
 *
 * Default scoped slot receives `{ records, resume, discard }`. Without a
 * slot, renders a minimal `<ul data-freebird-action-journal>` with one
 * `<li>` per record.
 */
export const ActionJournal = defineComponent({
  name: "FreeBirdActionJournal",
  props: {
    status: {
      type: [String, Array] as PropType<
        ActionRecordStatus | ActionRecordStatus[]
      >,
      default: undefined,
    },
    limit: { type: Number, default: undefined },
    hideWhenEmpty: { type: Boolean, default: true },
  },
  setup(props, { slots }) {
    const { records, resume, discard } = useActionJournal({
      status: props.status,
      limit: props.limit,
    });
    return () => {
      const list = records.value;
      if (props.hideWhenEmpty && list.length === 0) return null;
      const rp = { records: list, resume, discard };
      if (slots.default) return slots.default(rp);
      return defaultJournal(rp);
    };
  },
});

const defaultJournal = ({
  records,
  resume,
  discard,
}: {
  records: ActionRecord[];
  resume: (recordId: string) => void;
  discard: (recordId: string) => void;
}) =>
  h(
    "ul",
    { "data-freebird-action-journal": "" },
    records.map((r) =>
      h(
        "li",
        {
          key: r.id,
          "data-freebird-action-journal-item": "",
          "data-status": r.status,
        },
        [
          h(
            "span",
            { "data-freebird-action-journal-label": "" },
            r.label ?? `${r.componentId}:${r.actionId}`,
          ),
          h(
            "span",
            { "data-freebird-action-journal-status": "" },
            STATUS_LABEL[r.status],
          ),
          r.status === "paused"
            ? h("button", { type: "button", onClick: () => resume(r.id) }, "Resume")
            : null,
          h(
            "button",
            {
              type: "button",
              "aria-label": "Remove from journal",
              onClick: () => discard(r.id),
            },
            "×",
          ),
        ],
      ),
    ),
  );
