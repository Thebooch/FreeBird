import { button, buttons, details, frame, heading, lead } from "./frame.js";
import type { MessageTemplate } from "./render.js";

/**
 * To the host, for their information: a booking of theirs was confirmed,
 * cancelled, moved, or a suggested time was taken.
 *
 * Variables: brandName, accent, hostName, headline, detail, contactName,
 * typeName, when, whereText, statusText, viewUrl.
 */
export const BOOKING_CHANGED: MessageTemplate = {
  name: "booking-changed",
  vars: ["brandName", "accent", "hostName", "headline", "detail", "contactName", "typeName", "when", "whereText", "statusText", "viewUrl"],
  subject: "{{ headline }}",
  html: frame({
    preheader: "{{ detail }}",
    body: [
      heading("{{ headline }}"),
      lead("Hi {{ hostName }}, {{ detail }}"),
      details([
        ["What", "{{ typeName }}"],
        ["When", "{{ when }}"],
        ["Where", "{{ whereText }}"],
        ["Who", "{{ contactName }}"],
        ["Status", "{{ statusText }}"],
      ]),
      buttons(button("{{ viewUrl }}", "Open the calendar", "quiet")),
    ].join("\n"),
    footer: "You get this because you are the host of this booking at {{ brandName }}.",
  }),
  text: `Hi {{ hostName }},

{{ headline }}
{{ detail }}

What:   {{ typeName }}
When:   {{ when }}
Where:  {{ whereText }}
Who:    {{ contactName }}
Status: {{ statusText }}

Open the calendar: {{ viewUrl }}

You get this because you are the host of this booking at {{ brandName }}.
`,
};
