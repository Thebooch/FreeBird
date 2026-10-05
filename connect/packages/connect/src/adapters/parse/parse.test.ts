import { describe, expect, it } from "vitest";
import { AdapterError } from "../types.js";
import { formatOf, parseBody, parseDelimited, parseNdjson, parseXml, XmlError } from "./index.js";

/* Answers that are not JSON, read into the same plain values. */

describe("XML", () => {
  it("reads elements as records, repeats as lists, and plain numbers as numbers", () => {
    const parsed = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- a list -->
      <orders total="2">
        <order id="A-1"><amount>12.50</amount><paid>true</paid><note/></order>
        <order id="A-2"><amount>7</amount><paid>false</paid><note>late &amp; short</note></order>
      </orders>`);
    expect(parsed).toEqual({
      orders: {
        total: 2,
        order: [
          { id: "A-1", amount: 12.5, paid: true, note: null },
          { id: "A-2", amount: 7, paid: false, note: "late & short" },
        ],
      },
    });
  });

  it("keeps what a number would lose: long ids, leading zeros, text beside attributes", () => {
    expect(parseXml(`<r><zip>02134</zip><card>4111111111111111234</card><price currency="EUR">9.99</price><raw><![CDATA[<b>5 < 6</b>]]></raw></r>`)).toEqual({
      r: { zip: "02134", card: "4111111111111111234", price: { currency: "EUR", value: 9.99 }, raw: "<b>5 < 6</b>" },
    });
    /* An attribute never overwrites an element of the same name, nor text a field called value. */
    expect(parseXml(`<item id="7" value="x"><id>inner</id>words</item>`)).toEqual({
      item: { id: "inner", "@id": 7, value: "x", "#text": "words" },
    });
  });

  it("drops namespaces and schema hints, and reads nil as nothing", () => {
    expect(
      parseXml(`<ns2:list xmlns:ns2="urn:x" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><ns2:item xsi:type="ns2:Thing"><ns2:name>a</ns2:name><ns2:end xsi:nil="true"/></ns2:item></ns2:list>`),
    ).toEqual({ list: { item: { name: "a", end: null } } });
  });

  it("opens a SOAP envelope, and says a fault in the service's own words", () => {
    const envelope = (body: string) =>
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header/><soap:Body>${body}</soap:Body></soap:Envelope>`;
    expect(parseXml(envelope(`<GetItemsResponse><Item><Id>1</Id></Item><Item><Id>2</Id></Item></GetItemsResponse>`))).toEqual({
      GetItemsResponse: { Item: [{ Id: 1 }, { Id: 2 }] },
    });
    expect(() => parseXml(envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Account is locked</faultstring></soap:Fault>`))).toThrow(
      /Account is locked/,
    );
  });

  it("never reads a DOCTYPE: an entity it declares stays as written, and nothing is fetched", () => {
    const bomb = `<?xml version="1.0"?>
      <!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
      ]>
      <r><a>&lol2;</a><b>&xxe;</b><c>&#65;&#x42;&lt;</c></r>`;
    expect(parseXml(bomb)).toEqual({ r: { a: "&lol2;", b: "&xxe;", c: "AB<" } });
  });

  it("refuses a document that is not well formed, and says where", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
    expect(() => parseXml("<a>")).toThrow(/never closed/);
    expect(() => parseXml("<a></a><b></b>")).toThrow(/more than one top element/);
    expect(() => parseXml("   ")).toThrow(/no element/);
    expect(() => parseXml(`${"<a>".repeat(300)}${"</a>".repeat(300)}`)).toThrow(/nested too deeply/);
  });
});

describe("rows and lines", () => {
  it("reads a table of rows: quoted cells, doubled quotes, tabs, a byte-order mark", () => {
    expect(parseDelimited('﻿id,name,amount\r\n1,"Smith, Jo",12.5\r\n2,"say ""hi""",\r\n')).toEqual([
      { id: 1, name: "Smith, Jo", amount: 12.5 },
      { id: 2, name: 'say "hi"', amount: null },
    ]);
    expect(parseDelimited("id\tzip\n7\t02134\n", "\t")).toEqual([{ id: 7, zip: "02134" }]);
  });

  it("reads one record a line", () => {
    expect(parseNdjson('{"id":1}\n\n{"id":2}\r\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("an answer's body, by what it says it is", () => {
  it("names the format from the content type, never from a guess", () => {
    expect(formatOf("application/json; charset=utf-8")).toBe("json");
    expect(formatOf("application/hal+json")).toBe("json");
    expect(formatOf("application/x-ndjson")).toBe("ndjson");
    expect(formatOf("text/csv")).toBe("csv");
    expect(formatOf("text/tab-separated-values")).toBe("tsv");
    expect(formatOf("application/atom+xml")).toBe("xml");
    expect(formatOf("text/html")).toBeNull();
    expect(formatOf("application/xhtml+xml")).toBeNull();
    expect(formatOf(null)).toBeNull();
  });

  it("reads each in its own way, and JSON as before", () => {
    const url = "https://api.example.com/things";
    expect(parseBody('{"a":1}', "application/json", url)).toEqual({ a: 1 });
    expect(parseBody("", "application/json", url)).toBeNull();
    expect(parseBody("id,n\n1,2\n", "text/csv", url)).toEqual([{ id: 1, n: 2 }]);
    expect(parseBody('{"id":1}\n{"id":2}\n', "application/x-ndjson", url)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseBody("<things><thing><id>1</id></thing></things>", "application/xml", url)).toEqual({ things: { thing: { id: 1 } } });
    /* JSON under a wrong label is still JSON; an XML document under one is read as XML. */
    expect(parseBody('{"a":1}', "text/plain", url)).toEqual({ a: 1 });
    expect(parseBody('<?xml version="1.0"?><a><b>1</b></a>', "text/plain", url)).toEqual({ a: { b: 1 } });
  });

  it("still refuses a web page, and says a fault as the service's refusal", () => {
    const url = "https://api.example.com/things";
    expect(() => parseBody("<!doctype html><html><body>Not found</body></html>", "text/html", url)).toThrow(AdapterError);
    expect(() => parseBody("<html><body>Sign in</body></html>", null, url)).toThrow(/not JSON/);
    expect(() => parseBody("plain words", "text/plain", url)).toThrow(/not JSON/);
    const fault = `<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultstring>Bad key</faultstring></s:Fault></s:Body></s:Envelope>`;
    try {
      parseBody(fault, "text/xml", url);
      throw new Error("not refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).userMessage).toBe("The service refused the request: Bad key");
    }
  });
});

describe("server-sent events", () => {
  it("are one record each: JSON data's fields, with the event's name and id beside them", () => {
    const text = ': a comment\n\nevent: order\nid: 7\ndata: {"total": 12.5, "status": "paid"}\n\ndata: plain words\ndata: on two lines\r\n\r\nevent: ping\n\n';
    expect(parseBody(text, "text/event-stream", "https://api.example.com/stream")).toEqual([
      { event: "order", id: "7", total: 12.5, status: "paid" },
      { data: "plain words\non two lines" },
    ]);
  });
});
