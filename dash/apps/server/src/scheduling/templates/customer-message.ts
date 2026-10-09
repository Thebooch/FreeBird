import { button, buttons, details, frame } from "./frame.js";
import type { MessageTemplate } from "./render.js";

/**
 * The frame for email to the person who booked, which Tell them what was
 * decided and the reminders use once Comms sends email: the agent writes the
 * words (`body`), and the template only frames them with a booking card and
 * the button to their own page.
 *
 * Variables: brandName, accent, subject, body, typeName, when, whereText,
 * statusText, linkUrl, linkLabel.
 */
export const CUSTOMER_MESSAGE: MessageTemplate = {
  name: "customer-message",
  vars: ["brandName", "accent", "subject", "body", "typeName", "when", "whereText", "statusText", "linkUrl", "linkLabel"],
  subject: "{{ subject }}",
  html: frame({
    preheader: "{{ typeName }}, {{ when }}: {{ statusText }}",
    body: [
      `<div class="fb-ink" style="margin:0 0 20px 0;font:15px/23px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">{{ body | paragraphs }}</div>`,
      details([
        ["What", "{{ typeName }}"],
        ["When", "{{ when }}"],
        ["Where", "{{ whereText }}"],
        ["Status", "{{ statusText }}"],
      ]),
      buttons(button("{{ linkUrl }}", "{{ linkLabel }}")),
    ].join("\n"),
    footer: "Sent by {{ brandName }}. The button opens a page that is just for you: it shows your booking and lets you change it.",
  }),
  text: `{{ body }}

What:   {{ typeName }}
When:   {{ when }}
Where:  {{ whereText }}
Status: {{ statusText }}

{{ linkLabel }}: {{ linkUrl }}

Sent by {{ brandName }}. The link opens a page that is just for you: it shows your booking and lets you change it.
`,
};
