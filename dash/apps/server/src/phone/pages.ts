/**
 * The three pages text registration asks for, written with the wording
 * carriers look for (Dash Phone, Phase 2): an opt-in form whose consent box
 * is unticked and apart from any terms, a privacy section saying mobile
 * numbers are not shared or sold, and messaging terms (what, how often,
 * STOP, HELP, rates). Dash hosts them at the workspace's public address
 * (`/p/<workspace>/texts`, `/privacy`, `/terms`), and the same form can sit
 * on the business's own site through the embed script or the WordPress
 * plugin. The wording is a starting point, not legal advice: a business with
 * counsel should have it read.
 */

export interface TextPages {
  readonly business: string;
  /** Beside the consent box, word for word: what is kept as consent. */
  readonly wording: string;
  readonly privacy: readonly { readonly heading: string; readonly text: string }[];
  readonly terms: readonly { readonly heading: string; readonly text: string }[];
}

export const optInWording = (business: string): string =>
  `Yes, text me updates from ${business} about my appointments and requests. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;

/** The clause reviewers look for, as it appears in the privacy section. */
export const NO_SHARING_CLAUSE = "Mobile numbers and text messaging consent will not be shared with or sold to third parties or affiliates for marketing or promotional purposes.";

export const textPages = (business: string): TextPages => ({
  business,
  wording: optInWording(business),
  privacy: [
    { heading: "Text messages", text: `When you agree to texts from ${business}, we keep your mobile number and the date and wording of your agreement, so we can text you about your appointments and requests.` },
    { heading: "Sharing", text: `${NO_SHARING_CLAUSE} Your number is shared only with the phone companies and service providers that carry our texts, and only to send them.` },
    { heading: "Stopping", text: "Reply STOP to any text to stop them. We record that you asked and send no more, except one message saying so." },
  ],
  terms: [
    { heading: "What you get", text: `${business} texts you about appointments and requests you made with us: confirmations, reminders and answers to your messages.` },
    { heading: "How often", text: "Message frequency varies with your appointments and conversations." },
    { heading: "Cost", text: "Msg & data rates may apply. Your mobile carrier's plan decides what you pay." },
    { heading: "Stop and help", text: "Reply STOP to stop texts at any time; we confirm once and send no more. Reply HELP for help, or answer any text with your question and a person will get back to you." },
    { heading: "Carriers", text: "Carriers are not liable for delayed or undelivered messages." },
    { heading: "Privacy", text: NO_SHARING_CLAUSE },
  ],
});

/**
 * The embed script: drops the opt-in form into every `[data-dash-texts]`
 * element on the business's own page and posts it to Dash. No framework, no
 * cookies; the consent box starts unticked and is the only box.
 */
export const optInScript = (endpoint: string, pages: TextPages, links: { readonly privacy: string; readonly terms: string }): string => `(function () {
  var endpoint = ${JSON.stringify(endpoint)};
  var wording = ${JSON.stringify(pages.wording)};
  var privacy = ${JSON.stringify(links.privacy)};
  var terms = ${JSON.stringify(links.terms)};
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text) node.textContent = text;
    return node;
  }
  function mount(root) {
    if (root.getAttribute("data-dash-mounted")) return;
    root.setAttribute("data-dash-mounted", "1");
    var form = el("form", { "class": "dash-texts-form" });
    var name = el("input", { type: "text", name: "name", autocomplete: "name", placeholder: "Your name" });
    var phone = el("input", { type: "tel", name: "phone", autocomplete: "tel", placeholder: "Mobile number", required: "required" });
    var box = el("input", { type: "checkbox", name: "consent" });
    var label = el("label", {});
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + wording));
    var small = el("p", {});
    small.appendChild(el("a", { href: privacy, target: "_blank", rel: "noopener" }, "Privacy"));
    small.appendChild(document.createTextNode(" · "));
    small.appendChild(el("a", { href: terms, target: "_blank", rel: "noopener" }, "Messaging terms"));
    var button = el("button", { type: "submit" }, "Sign up for texts");
    var note = el("p", { role: "status" });
    [name, phone, label, button, small, note].forEach(function (part) { form.appendChild(part); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!box.checked) { note.textContent = "Tick the box to agree to texts."; return; }
      button.disabled = true;
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.value, phone: phone.value, consent: true, from: "embed" }) })
        .then(function (answer) { return answer.json().then(function (body) { return { ok: answer.ok, body: body }; }); })
        .then(function (result) { note.textContent = result.ok ? "You're signed up. Reply STOP to any text to stop." : (result.body && result.body.error) || "That didn't go through. Try again."; button.disabled = result.ok; })
        .catch(function () { note.textContent = "That didn't go through. Try again."; button.disabled = false; });
    });
    root.appendChild(form);
  }
  function all() { Array.prototype.forEach.call(document.querySelectorAll("[data-dash-texts]"), mount); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", all); else all();
})();
`;
