import { describe, expect, it } from "vitest";
import { consentForm } from "./oauth.js";

/*
 * The benchmark's person, on a provider's consent page: they read it and
 * press Allow. Never a login form — a password is theirs to type.
 */

describe("a provider's consent page", () => {
  const page = "https://login.provider.test/oauth/authorize?client_id=abc";

  it("is the form that allows, with its hidden fields and the Allow button's value", () => {
    const html = `<h1>Pipe wants to read your deals</h1>
      <form method="post" action="/oauth/decide">
        <input type="hidden" name="request_id" value="r-42">
        <input type="hidden" name="state" value="bench">
        <button type="submit" name="decision" value="deny">Deny</button>
        <button type="submit" name="decision" value="allow">Allow access</button>
      </form>`;
    expect(consentForm(html, page)).toEqual({
      action: "https://login.provider.test/oauth/decide",
      fields: { request_id: "r-42", state: "bench", decision: "allow" },
    });
    /* A lone submit input that approves. */
    expect(consentForm(`<form method=post><input type="hidden" name="t" value="1"><input type="submit" value="Approve"></form>`, page)).toEqual({
      action: page,
      fields: { t: "1" },
    });
  });

  it("is nothing on a page that asks for a password, or offers only to deny", () => {
    expect(consentForm(`<form method="post" action="/login"><input name="email"><input type="password" name="pw"><button>Continue</button></form>`, page)).toBeNull();
    expect(consentForm(`<form method="post"><button name="d" value="no">Deny</button></form>`, page)).toBeNull();
  });
});
