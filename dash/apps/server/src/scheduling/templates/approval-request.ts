import { button, buttons, details, frame, heading, lead, section, small } from "./frame.js";
import type { MessageTemplate } from "./render.js";

/**
 * To a member who may approve a booking: the request, what matched, their day
 * around it, and three buttons. Each button opens the approval page with that
 * choice picked; nothing is decided until they press a button on the page,
 * since mail scanners open links.
 *
 * Variables: brandName, accent, memberName, contactName, contactDetails,
 * typeName, when, whereText, notes, facts, day, holdText, approveUrl,
 * suggestUrl, denyUrl.
 */
export const APPROVAL_REQUEST: MessageTemplate = {
  name: "approval-request",
  vars: ["brandName", "accent", "memberName", "contactName", "contactDetails", "typeName", "when", "whereText", "notes", "facts", "day", "holdText", "approveUrl", "suggestUrl", "denyUrl"],
  subject: "Approve {{ contactName }}: {{ typeName }}, {{ when }}",
  html: frame({
    preheader: "{{ contactName }} asked for {{ typeName }}, {{ when }}. {{ holdText }}",
    body: [
      heading("A booking is waiting for you"),
      lead("Hi {{ memberName }}, {{ contactName }} asked for {{ typeName }}. Approve it, offer other times, or deny it."),
      details([
        ["What", "{{ typeName }}"],
        ["When", "{{ when }}"],
        ["Where", "{{ whereText }}"],
        ["Who", "{{ contactName }}<br><span class=\"fb-soft\" style=\"color:#4b5563;font-size:14px;\">{{ contactDetails }}</span>"],
        ["Notes", "{{ notes }}"],
      ]),
      section("What matched", "{{ facts | paragraphs }}"),
      section("Your day", "{{ day | paragraphs }}"),
      buttons(button("{{ approveUrl }}", "Approve"), button("{{ suggestUrl }}", "Suggest another time", "quiet"), button("{{ denyUrl }}", "Deny", "quiet")),
      small("{{ holdText }} A button opens the request first: nothing is decided until you choose on that page."),
    ].join("\n"),
    footer: "You get this because you approve bookings for {{ brandName }}. Anyone holding this email can answer as you until it is used, so please don't forward it.",
  }),
  text: `Hi {{ memberName }},

{{ contactName }} asked for {{ typeName }}. Approve it, offer other times, or deny it.

What:  {{ typeName }}
When:  {{ when }}
Where: {{ whereText }}
Who:   {{ contactName }} ({{ contactDetails }})
Notes: {{ notes }}

What matched:
{{ facts }}

Your day:
{{ day }}

Approve: {{ approveUrl }}
Suggest another time: {{ suggestUrl }}
Deny: {{ denyUrl }}

{{ holdText }} A link opens the request first: nothing is decided until you choose on that page.

You get this because you approve bookings for {{ brandName }}. Anyone holding this email can answer as you until it is used, so please don't forward it.
`,
};
