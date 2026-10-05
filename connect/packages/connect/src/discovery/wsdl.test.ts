import { RestAdapter, type HttpFetch } from "../adapters/index.js";
import { getOp, resolveRange } from "@freebirdai/connect-spec";
import { describe, expect, it } from "vitest";
import { connectionFromCatalog } from "../catalog.js";
import { discover } from "./index.js";
import { looksLikeWsdl, parseWsdl, readsByName } from "./wsdl.js";

/* A SOAP service, set up from its WSDL and read without code. */

const URL_ = "https://soap.orders.test/OrderService.asmx?wsdl";
const NS = "http://orders.test/api";

const WSDL = `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:s="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" targetNamespace="${NS}" name="OrderService">
  <wsdl:types>
    <s:schema elementFormDefault="qualified" targetNamespace="${NS}">
      <s:element name="GetOrders">
        <s:complexType><s:sequence>
          <s:element minOccurs="0" maxOccurs="1" name="status" type="s:string"/>
          <s:element minOccurs="0" maxOccurs="1" name="pageSize" type="s:int"/>
        </s:sequence></s:complexType>
      </s:element>
      <s:element name="GetOrdersResponse">
        <s:complexType><s:sequence>
          <s:element minOccurs="0" maxOccurs="1" name="GetOrdersResult" type="tns:ArrayOfOrder"/>
        </s:sequence></s:complexType>
      </s:element>
      <s:complexType name="ArrayOfOrder"><s:sequence>
        <s:element minOccurs="0" maxOccurs="unbounded" name="Order" type="tns:Order"/>
      </s:sequence></s:complexType>
      <s:complexType name="Order"><s:sequence>
        <s:element name="Id" type="s:string"/><s:element name="Status" type="s:string"/><s:element name="Total" type="s:decimal"/>
      </s:sequence></s:complexType>
      <s:element name="GetOrder"><s:complexType><s:sequence><s:element name="id" type="s:string"/></s:sequence></s:complexType></s:element>
      <s:element name="GetOrderResponse"><s:complexType><s:sequence><s:element name="GetOrderResult" type="tns:Order"/></s:sequence></s:complexType></s:element>
      <s:element name="DeleteOrder"><s:complexType><s:sequence><s:element name="id" type="s:string"/></s:sequence></s:complexType></s:element>
      <s:element name="DeleteOrderResponse"><s:complexType/></s:element>
    </s:schema>
  </wsdl:types>
  <wsdl:message name="GetOrdersSoapIn"><wsdl:part name="parameters" element="tns:GetOrders"/></wsdl:message>
  <wsdl:message name="GetOrdersSoapOut"><wsdl:part name="parameters" element="tns:GetOrdersResponse"/></wsdl:message>
  <wsdl:message name="GetOrderSoapIn"><wsdl:part name="parameters" element="tns:GetOrder"/></wsdl:message>
  <wsdl:message name="GetOrderSoapOut"><wsdl:part name="parameters" element="tns:GetOrderResponse"/></wsdl:message>
  <wsdl:message name="DeleteOrderSoapIn"><wsdl:part name="parameters" element="tns:DeleteOrder"/></wsdl:message>
  <wsdl:message name="DeleteOrderSoapOut"><wsdl:part name="parameters" element="tns:DeleteOrderResponse"/></wsdl:message>
  <wsdl:portType name="OrderServiceSoap">
    <wsdl:operation name="GetOrders"><wsdl:input message="tns:GetOrdersSoapIn"/><wsdl:output message="tns:GetOrdersSoapOut"/></wsdl:operation>
    <wsdl:operation name="GetOrder"><wsdl:input message="tns:GetOrderSoapIn"/><wsdl:output message="tns:GetOrderSoapOut"/></wsdl:operation>
    <wsdl:operation name="DeleteOrder"><wsdl:input message="tns:DeleteOrderSoapIn"/><wsdl:output message="tns:DeleteOrderSoapOut"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="OrderServiceSoap" type="tns:OrderServiceSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetOrders"><soap:operation soapAction="${NS}/GetOrders" style="document"/></wsdl:operation>
    <wsdl:operation name="GetOrder"><soap:operation soapAction="${NS}/GetOrder" style="document"/></wsdl:operation>
    <wsdl:operation name="DeleteOrder"><soap:operation soapAction="${NS}/DeleteOrder" style="document"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="OrderService">
    <wsdl:port name="OrderServiceSoap" binding="tns:OrderServiceSoap"><soap:address location="https://soap.orders.test/OrderService.asmx"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

const orders = [
  { Id: "O-1", Status: "open", Total: "12.50" },
  { Id: "O-2", Status: "shipped", Total: "7" },
  { Id: "O-3", Status: "open", Total: "3.25" },
];

const soap = () => {
  const sent: Array<{ action: string | undefined; body: string }> = [];
  const http: HttpFetch = async (url, init) => {
    sent.push({ action: init.headers.soapaction, body: init.body ?? "" });
    const status = /<status>([^<]*)<\/status>/.exec(init.body ?? "")?.[1];
    const rows = orders.filter((one) => !status || one.Status === status);
    const text = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetOrdersResponse xmlns="${NS}"><GetOrdersResult>${rows
      .map((one) => `<Order><Id>${one.Id}</Id><Status>${one.Status}</Status><Total>${one.Total}</Total></Order>`)
      .join("")}</GetOrdersResult></GetOrdersResponse></soap:Body></soap:Envelope>`;
    return { status: 200, text, url, header: (name) => (name === "content-type" ? "text/xml; charset=utf-8" : null) };
  };
  return { http, sent };
};

describe("a SOAP service's WSDL", () => {
  it("becomes an endpoint for each operation named for reading, and leaves the rest out", () => {
    expect(looksLikeWsdl(WSDL)).toBe(true);
    expect(looksLikeWsdl('{"openapi":"3.0.0"}')).toBe(false);
    const { entry, warnings } = parseWsdl(WSDL, URL_)!;
    expect(entry).toMatchObject({ title: "OrderService", baseUrl: "https://soap.orders.test" });
    expect(entry.ops.map((op) => [op.id, op.method, op.path, op.readSafety?.basis])).toEqual([
      ["get_orders", "POST", "/OrderService.asmx", "docs-inferred"],
      ["get_order", "POST", "/OrderService.asmx", "docs-inferred"],
    ]);
    const list = entry.ops[0]!;
    expect(list.headers).toEqual({ soapaction: `"${NS}/GetOrders"` });
    expect(list.rowsPath).toBe("$.GetOrdersResponse.GetOrdersResult.Order");
    expect(list.params).toEqual([
      expect.objectContaining({ name: "status", in: "body", type: "string", required: false }),
      expect.objectContaining({ name: "pageSize", in: "body", type: "number", required: false }),
    ]);
    expect(entry.ops[1]!.params).toEqual([expect.objectContaining({ name: "id", required: true })]);
    expect(warnings.join(" ")).toMatch(/1 operation is not named for reading, and was left out: DeleteOrder/);
    expect(readsByName("GetOrdersAndDelete")).toBe(false);
  });

  it("is read by posting its envelope: an input nobody gave is left out, one given is escaped", async () => {
    const { entry } = parseWsdl(WSDL, URL_)!;
    const connection = connectionFromCatalog(entry, { id: "orders" });
    const op = getOp(connection, "get_orders")!;
    const { http, sent } = soap();
    const ctx = (filters: Record<string, string>) => ({ now: 0, params: { range: resolveRange({ preset: "30d", now: 0 }), filters } });
    const all = await new RestAdapter(http).fetch(connection, op, {}, ctx({}));
    expect((all.body as { GetOrdersResponse: { GetOrdersResult: { Order: unknown[] } } }).GetOrdersResponse.GetOrdersResult.Order).toHaveLength(3);
    expect(sent[0]!.action).toBe(`"${NS}/GetOrders"`);
    expect(sent[0]!.body).toContain(`<GetOrders xmlns="${NS}"></GetOrders>`);
    const open = await new RestAdapter(http).fetch(connection, op, {}, ctx({ status: "open" }));
    expect((open.body as { GetOrdersResponse: { GetOrdersResult: { Order: unknown[] } } }).GetOrdersResponse.GetOrdersResult.Order).toHaveLength(2);
    await new RestAdapter(http).fetch(connection, op, {}, ctx({ status: "a<b&c" }));
    expect(sent[2]!.body).toContain("<status>a&lt;b&amp;c</status>");
  });

  it("is found from its address like any other description", async () => {
    const found = await discover(URL_, { fetchDocument: async (url) => ({ status: 200, text: WSDL, url }) });
    expect(found).toMatchObject({ source: "wsdl", entry: { title: "OrderService" } });
  });
});
