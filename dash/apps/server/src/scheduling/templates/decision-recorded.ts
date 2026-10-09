import { button, buttons, details, frame, heading, lead } from "./frame.js";
import type { MessageTemplate } from "./render.js";

/**
 * To the member who answered, and to the rest of those asked: "You approved
 * …", "Sam suggested other times …", so nobody answers twice.
 *
 * Variables: brandName, accent, memberName, headline, detail, contactName,
 * typeName, when, viewUrl.
 */
export const DECISION_RECORDED: MessageTemplate = {
  name: "decision-recorded",
  vars: ["brandName", "accent", "memberName", "headline", "detail", "contactName", "typeName", "when", "viewUrl"],
  subject: "{{ headline }}",
  html: frame({
    preheader: "{{ detail }}",
    body: [
      heading("{{ headline }}"),
      lead("Hi {{ memberName }}, {{ detail }}"),
      details([
        ["What", "{{ typeName }}"],
        ["When", "{{ when }}"],
        ["Who", "{{ contactName }}"],
      ]),
      buttons(button("{{ viewUrl }}", "See what was decided", "quiet")),
    ].join("\n"),
    footer: "You get this because you were asked to approve this booking for {{ brandName }}.",
  }),
  text: `Hi {{ memberName }},

{{ headline }}
{{ detail }}

What: {{ typeName }}
When: {{ when }}
Who:  {{ contactName }}

See what was decided: {{ viewUrl }}

You get this because you were asked to approve this booking for {{ brandName }}.
`,
};
