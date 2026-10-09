import { button, buttons, details, frame, heading, lead, small } from "./frame.js";
import type { MessageTemplate } from "./render.js";

/**
 * To the same member, once, when a request is still unanswered: the same
 * buttons, and how long until the hold runs out.
 *
 * Variables: brandName, accent, memberName, contactName, typeName, when,
 * whereText, remaining, approveUrl, suggestUrl, denyUrl.
 */
export const APPROVAL_REMINDER: MessageTemplate = {
  name: "approval-reminder",
  vars: ["brandName", "accent", "memberName", "contactName", "typeName", "when", "whereText", "remaining", "approveUrl", "suggestUrl", "denyUrl"],
  subject: "Still waiting: {{ contactName }}, {{ typeName }}, {{ when }}",
  html: frame({
    preheader: "{{ contactName }}'s request is still waiting. {{ remaining }}",
    body: [
      heading("Still waiting for an answer"),
      lead("Hi {{ memberName }}, {{ contactName }}'s request for {{ typeName }} hasn't been answered yet. {{ remaining }}"),
      details([
        ["What", "{{ typeName }}"],
        ["When", "{{ when }}"],
        ["Where", "{{ whereText }}"],
        ["Who", "{{ contactName }}"],
      ]),
      buttons(button("{{ approveUrl }}", "Approve"), button("{{ suggestUrl }}", "Suggest another time", "quiet"), button("{{ denyUrl }}", "Deny", "quiet")),
      small("A button opens the request first: nothing is decided until you choose on that page."),
    ].join("\n"),
    footer: "You get this because you approve bookings for {{ brandName }}. Please don't forward it.",
  }),
  text: `Hi {{ memberName }},

{{ contactName }}'s request for {{ typeName }} hasn't been answered yet. {{ remaining }}

What:  {{ typeName }}
When:  {{ when }}
Where: {{ whereText }}
Who:   {{ contactName }}

Approve: {{ approveUrl }}
Suggest another time: {{ suggestUrl }}
Deny: {{ denyUrl }}

You get this because you approve bookings for {{ brandName }}. Please don't forward it.
`,
};
