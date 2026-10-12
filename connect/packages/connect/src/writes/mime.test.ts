import { describe, expect, it } from "vitest";
import { composeMessage, encodeMimeBody } from "./mime.js";

const decode = (text: string, encoding: "base64url" | "base64" = "base64url"): string => Buffer.from(text, encoding).toString("utf8");

const bodyOf = (message: string): string => {
  const [, body = ""] = message.split("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
};

describe("composeMessage", () => {
  it("writes the reviewed fields as headers and the text as a base64 body", () => {
    const message = composeMessage({ to: "pat@example.com", cc: "sam@example.com", subject: "Re: Leak", text: "On it.\nTomorrow at 9.", inReplyTo: "<a@mail>", references: "<a@mail>" });
    expect(message).toContain("To: pat@example.com\r\n");
    expect(message).toContain("Cc: sam@example.com\r\n");
    expect(message).toContain("Subject: Re: Leak\r\n");
    expect(message).toContain("In-Reply-To: <a@mail>\r\n");
    expect(message).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(bodyOf(message)).toBe("On it.\r\nTomorrow at 9.");
  });

  it("never lets a field add a header of its own", () => {
    const message = composeMessage({ to: "pat@example.com\r\nBcc: evil@example.com", subject: "Hi\nX-Injected: yes", text: "" });
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).not.toMatch(/^X-Injected:/m);
  });

  it("encodes a subject that is not plain ASCII", () => {
    const message = composeMessage({ to: "a@b.c", subject: "Café ☕", text: "" });
    const subject = /^Subject: (.*)$/m.exec(message)?.[1] ?? "";
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(subject.slice(10, -2), "base64").toString("utf8")).toBe("Café ☕");
  });
});

describe("encodeMimeBody", () => {
  it("puts the message at `into` and keeps the other fields beside it", () => {
    const body = encodeMimeBody({ to: "pat@example.com", subject: "Hello", text: "Hi", threadId: "t1" }, { into: "raw", encoding: "base64url" }) as Record<string, unknown>;
    expect(body["threadId"]).toBe("t1");
    expect(body["to"]).toBeUndefined();
    expect(decode(String(body["raw"]))).toContain("To: pat@example.com");
  });

  it("nests it for a draft", () => {
    const body = encodeMimeBody({ to: "pat@example.com", "message.threadId": "t1" } as Record<string, unknown>, { into: "message.raw", encoding: "base64url" }) as { message: { raw: string } };
    expect(decode(body.message.raw)).toContain("To: pat@example.com");
  });

  it("is the whole body without `into`, as Graph takes it", () => {
    const body = encodeMimeBody({ to: "pat@example.com", text: "Hi" }, { encoding: "base64" });
    expect(typeof body).toBe("string");
    expect(decode(body as string, "base64")).toContain("To: pat@example.com");
  });
});
