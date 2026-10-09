import { describe, expect, it } from "vitest";
import { MESSAGE_TEMPLATES, ownLink, render, TemplateVariableError, variablesOf } from "./index.js";

const sample = (names: readonly string[]): Record<string, string> => Object.fromEntries(names.map((name) => [name, name === "accent" ? "#2f5bea" : name.endsWith("Url") ? `https://dash.example.com/p/acme/${name}` : `<${name}>`]));

describe("message templates", () => {
  it.each(MESSAGE_TEMPLATES.map((one) => [one.name, one] as const))("%s lists exactly the variables it uses", (_name, template) => {
    expect([...template.vars].sort()).toEqual(variablesOf(template).sort());
  });

  it.each(MESSAGE_TEMPLATES.map((one) => [one.name, one] as const))("%s fills every variable, escaped", (_name, template) => {
    const out = render(template, sample(template.vars));
    for (const part of [out.subject, out.html, out.text]) expect(part).not.toMatch(/\{\{/);
    expect(out.html).not.toMatch(/<(?!\/?(?:html|head|meta|style|body|div|table|tr|td|span|h1|p|a|br)\b|!doctype)[a-zA-Z]/);
    expect(out.html).toContain("&lt;brandName&gt;");
    expect(out.html).toContain("max-width:600px");
    expect(out.html).toContain("prefers-color-scheme: dark");
  });

  it("refuses to leave a variable blank", () => {
    const [first] = MESSAGE_TEMPLATES;
    const vars = sample(first.vars);
    delete vars["when"];
    expect(() => render(first, vars)).toThrow(TemplateVariableError);
  });

  it("keeps paragraphs and line breaks, escaped, and one line for the subject", () => {
    const template = { name: "t", vars: ["body", "title"], subject: "{{ title }}", html: "<div>{{ body | paragraphs }}</div>", text: "{{ body }}" };
    const out = render(template, { title: "Two\nlines", body: "Hello <b>there</b>\nSecond line\n\nNext paragraph" });
    expect(out.subject).toBe("Two lines");
    expect(out.html).toBe('<div><p style="margin:0 0 14px 0;">Hello &lt;b&gt;there&lt;/b&gt;<br>Second line</p><p style="margin:0 0 14px 0;">Next paragraph</p></div>');
    expect(out.text).toBe("Hello <b>there</b>\nSecond line\n\nNext paragraph");
  });

  it("links only to our own pages", () => {
    expect(ownLink("https://dash.example.com/p/acme/book/abc", "https://dash.example.com")).toBe("https://dash.example.com/p/acme/book/abc");
    expect(() => ownLink("https://evil.example/p/acme/book/abc", "https://dash.example.com")).toThrow();
    expect(() => ownLink("javascript:alert(1)", "https://dash.example.com")).toThrow();
  });
});
