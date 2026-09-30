/*
 * The connector's environment, evaluated inside the sandbox before its code.
 *
 * Everything here is convenience, not control. The code can replace any of it;
 * it would only be replacing its own helpers. What is allowed is decided on the
 * main thread, for every request, whatever this file says — see `host.ts`.
 *
 * Available from outside: `__host(name, json)` (a promise of JSON text),
 * `__log(line)`, `__now()` and `__seed`. Nothing else.
 */
"use strict";

(function () {
  const call = (name, args) =>
    __host(name, JSON.stringify(args === undefined ? null : args)).then((text) => JSON.parse(text));

  /* ── time and chance: the server's, never the machine's ────────────── */

  const RealDate = Date;
  function SandboxDate(...args) {
    if (!new.target) return new RealDate(__now()).toString();
    return args.length === 0 ? new RealDate(__now()) : new RealDate(...args);
  }
  SandboxDate.prototype = RealDate.prototype;
  SandboxDate.now = () => __now();
  SandboxDate.parse = RealDate.parse;
  SandboxDate.UTC = RealDate.UTC;
  globalThis.Date = SandboxDate;

  let state = (__seed >>> 0) || 0x9e3779b9;
  Math.random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };

  globalThis.clock = Object.freeze({ now: () => __now() });
  globalThis.sleep = (ms) => call("sleep", Number(ms) || 0);
  globalThis.log = (...parts) =>
    __log(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));

  /* ── text ───────────────────────────────────────────────────────────── */

  const utf8 = (text) => {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next < 0xe000) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63),
        );
    }
    return bytes;
  };
  const fromUtf8 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i++];
      let code;
      if (b < 0x80) code = b;
      else if (b < 0xe0) code = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) code = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      else
        code =
          ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      out += String.fromCodePoint(code);
    }
    return out;
  };
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  globalThis.base64 = Object.freeze({
    encode(text) {
      const bytes = utf8(String(text));
      let out = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
        out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
        out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
      }
      return out;
    },
    decode(text) {
      const clean = String(text).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
      const bytes = [];
      for (let i = 0; i < clean.length; i += 4) {
        const n =
          (ALPHABET.indexOf(clean[i]) << 18) |
          (ALPHABET.indexOf(clean[i + 1]) << 12) |
          ((ALPHABET.indexOf(clean[i + 2] ?? "A") & 63) << 6) |
          (ALPHABET.indexOf(clean[i + 3] ?? "A") & 63);
        bytes.push((n >> 16) & 255);
        if (i + 2 < clean.length) bytes.push((n >> 8) & 255);
        if (i + 3 < clean.length) bytes.push(n & 255);
      }
      return fromUtf8(bytes);
    },
  });

  const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  const cell = (text) => (text === "" ? null : NUMBER.test(text) ? Number(text) : text);

  /** RFC 4180: quoted fields, doubled quotes, CRLF or LF, a header row by default. */
  globalThis.CSV = Object.freeze({
    parse(text, options) {
      const delimiter = (options && options.delimiter) || ",";
      const header = !options || options.header !== false;
      const source = String(text).replace(/^﻿/, "");
      const rows = [];
      let row = [];
      let field = "";
      let quoted = false;
      let i = 0;
      while (i < source.length) {
        const char = source[i];
        if (quoted) {
          if (char === '"') {
            if (source[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            quoted = false;
            i++;
            continue;
          }
          field += char;
          i++;
          continue;
        }
        if (char === '"' && field === "") {
          quoted = true;
          i++;
          continue;
        }
        if (char === delimiter) {
          row.push(field);
          field = "";
          i++;
          continue;
        }
        if (char === "\r" || char === "\n") {
          row.push(field);
          field = "";
          rows.push(row);
          row = [];
          i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
          continue;
        }
        field += char;
        i++;
      }
      if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      const filled = rows.filter((one) => !(one.length === 1 && one[0] === ""));
      if (!header) return filled.map((one) => one.map(cell));
      const names = (filled[0] || []).map((name) => name.trim());
      return filled.slice(1).map((one) => {
        const record = {};
        names.forEach((name, index) => {
          record[name] = cell(one[index] === undefined ? "" : one[index]);
        });
        return record;
      });
    },
  });

  /* Read by the server (`xml.parse`): elements become fields, repeats a list, a SOAP envelope is opened. */
  globalThis.XML = Object.freeze({
    parse: (text) => call("xml.parse", String(text)),
  });

  globalThis.NDJSON = Object.freeze({
    parse(text) {
      return String(text)
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    },
  });

  /* ── addresses ──────────────────────────────────────────────────────── */

  /*
   * QuickJS has no URL, and code written for the web reaches for one first:
   * `new URL(...)` failed a connector before it sent anything (measurement 1).
   * Enough of it for building and reading addresses; nothing it does reaches
   * the network.
   */
  class SandboxSearchParams {
    constructor(query) {
      this.pairs = [];
      const text = String(query || "").replace(/^\?/, "");
      if (text !== "")
        for (const part of text.split("&")) {
          const at = part.indexOf("=");
          const name = at < 0 ? part : part.slice(0, at);
          const value = at < 0 ? "" : part.slice(at + 1);
          this.pairs.push([decodeURIComponent(name.replace(/\+/g, " ")), decodeURIComponent(value.replace(/\+/g, " "))]);
        }
    }
    get(name) {
      const found = this.pairs.find((pair) => pair[0] === name);
      return found ? found[1] : null;
    }
    getAll(name) {
      return this.pairs.filter((pair) => pair[0] === name).map((pair) => pair[1]);
    }
    has(name) {
      return this.pairs.some((pair) => pair[0] === name);
    }
    set(name, value) {
      this.delete(name);
      this.pairs.push([String(name), String(value)]);
    }
    append(name, value) {
      this.pairs.push([String(name), String(value)]);
    }
    delete(name) {
      this.pairs = this.pairs.filter((pair) => pair[0] !== name);
    }
    forEach(callback) {
      for (const [name, value] of this.pairs) callback(value, name, this);
    }
    toString() {
      return this.pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    }
  }

  class SandboxURL {
    constructor(input, base) {
      let text = String(input);
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        if (base === undefined) throw new TypeError(`Invalid URL: ${text}`);
        const root = new SandboxURL(base);
        text = text.startsWith("/") ? `${root.origin}${text}` : `${root.origin}${root.pathname.replace(/[^/]*$/, "")}${text}`;
      }
      const match = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);
      if (!match) throw new TypeError(`Invalid URL: ${text}`);
      this.protocol = match[1].toLowerCase();
      this.host = match[2].toLowerCase();
      this.hostname = this.host.replace(/:\d+$/, "");
      this.port = (/:(\d+)$/.exec(this.host) || [])[1] || "";
      this.pathname = match[3] || "/";
      this.searchParams = new SandboxSearchParams(match[4] || "");
      this.hash = match[5] || "";
    }
    get origin() {
      return `${this.protocol}//${this.host}`;
    }
    get search() {
      const query = this.searchParams.toString();
      return query === "" ? "" : `?${query}`;
    }
    get href() {
      return `${this.origin}${this.pathname}${this.search}${this.hash}`;
    }
    toString() {
      return this.href;
    }
  }
  globalThis.URL = SandboxURL;
  globalThis.URLSearchParams = SandboxSearchParams;

  /* ── requests ───────────────────────────────────────────────────────── */

  let env = { baseUrl: "", apiHosts: [] };
  let current = null;

  const hostOf = (url) => {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
    return match ? match[1].toLowerCase() : "";
  };

  const appendQuery = (url, query) => {
    if (!query || typeof query !== "object") return url;
    const parts = [];
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      for (const one of Array.isArray(value) ? value : [value])
        parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(one))}`);
    }
    if (parts.length === 0) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
  };

  /** A request as the server and `signRequest` see it: method, absolute url, lower-case headers, text body. */
  const normalize = (request) => {
    if (!request || typeof request !== "object") throw new TypeError("a request is an object: { method, url }");
    if (typeof request.url !== "string" || request.url === "") throw new TypeError("a request needs a url");
    const method = String(request.method || "GET").toUpperCase();
    let url = request.url;
    if (url.startsWith("/")) url = env.baseUrl.replace(/\/+$/, "") + url;
    url = appendQuery(url, request.query);
    const headers = {};
    for (const [name, value] of Object.entries(request.headers || {}))
      if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
    let body = request.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      body = JSON.stringify(body);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
    return body === undefined || body === null ? { method, url, headers } : { method, url, headers, body };
  };

  const decode = (answer, as) => {
    const type = (answer.headers["content-type"] || "").toLowerCase();
    const text = answer.text;
    const json = () => {
      if (text.trim() === "") return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(`the answer from ${answer.url} was not JSON: ${text.slice(0, 120)}`);
      }
    };
    switch (as) {
      case "json":
        return json();
      case "text":
        return text;
      case "csv":
        return CSV.parse(text);
      case "ndjson":
        return NDJSON.parse(text);
      case "xml":
        return answer.xml;
      default:
        if (answer.xml !== undefined) return answer.xml;
        if (/json/.test(type) && !/ndjson|x-jsonlines/.test(type)) return json();
        if (/csv|comma-separated/.test(type)) return CSV.parse(text);
        if (/tab-separated/.test(type)) return CSV.parse(text, { delimiter: "\t" });
        if (/ndjson|jsonlines/.test(type)) return NDJSON.parse(text);
        try {
          return text.trim() === "" ? null : JSON.parse(text);
        } catch (error) {
          return text;
        }
    }
  };

  const signed = async (request, sign) => {
    const hooks = globalThis.__hooks || {};
    const own = env.apiHosts.includes(hostOf(request.url));
    if (!hooks.signRequest || sign === false || (sign !== true && !own)) return request;
    const result = await hooks.signRequest(request, current);
    return normalize(result || request);
  };

  globalThis.http = Object.freeze({
    async request(request) {
      const as = request && request.as;
      const ready = await signed(normalize(request), request && request.sign);
      const answer = await call("http.request", ready);
      /* XML is read by the server, with the same reader a plain endpoint's answer gets. */
      const type = (answer.headers["content-type"] || "").toLowerCase();
      if (as === "xml" || ((as === undefined || as === "auto") && /xml/.test(type) && !/xhtml/.test(type)))
        answer.xml = await call("xml.parse", answer.text);
      const response = { status: answer.status, headers: answer.headers, url: answer.url };
      response.body = answer.status === 204 || ready.method === "HEAD" ? null : decode(answer, as);
      return response;
    },
  });

  globalThis.crypto = Object.freeze({
    hmac: (options) => call("crypto.hmac", options),
    derive: (options) => call("crypto.derive", options),
    hash: (options) => call("crypto.hash", options),
  });

  globalThis.credentials = Object.freeze({
    identifier: (name) => call("credentials.identifier", String(name)),
  });

  globalThis.auth = Object.freeze({
    /*
     * A login is not passed through signRequest unless the code asks: a
     * signRequest that adds the session would otherwise ask for one on the
     * very request that creates it.
     */
    exchange: async (options) => {
      const request = normalize(options.request);
      return call("auth.exchange", { ...options, request: options.sign === true ? await signed(request, true) : request });
    },
    forget: (name) => call("auth.forget", String(name)),
  });

  /* ── reading ────────────────────────────────────────────────────────── */

  /** `$.a.b[0]`, enough to find records in an answer. */
  const at = (value, path) => {
    if (!path || path === "$") return value;
    const steps = String(path)
      .replace(/^\$\.?/, "")
      .split(/\.|\[(\d+)\]/)
      .filter((step) => step !== undefined && step !== "");
    let here = value;
    for (const step of steps) {
      if (here === null || typeof here !== "object") return undefined;
      here = here[step];
    }
    return here;
  };

  const asResult = (value) => {
    if (Array.isArray(value)) return { rows: value };
    if (value && typeof value === "object" && Array.isArray(value.rows)) return value;
    throw new TypeError("a read answers { rows: [...] } or an array of records");
  };

  /** Without a read(): the endpoint's own request, then parse() and paginate() over each page. */
  const defaultRead = async (ctx) => {
    const hooks = globalThis.__hooks || {};
    let request = ctx.request;
    const rows = [];
    let total;
    let index = 0;
    while (request && index < ctx.maxPages) {
      const response = await http.request({ ...request, as: hooks.parse ? "text" : "auto" });
      if (response.status >= 400) throw new Error(`the API answered ${response.status}`);
      let page;
      if (hooks.parse) page = asResult(await hooks.parse({ ...response, text: response.body }, ctx));
      else {
        const found = at(response.body, ctx.op.rowsPath);
        page = { rows: Array.isArray(found) ? found : found === undefined || found === null ? [] : [found] };
      }
      if (index === 0 && typeof page.total === "number") total = page.total;
      rows.push(...page.rows);
      index++;
      request = hooks.paginate ? await hooks.paginate({ request, response, rows: page.rows, index }, ctx) : null;
    }
    return { rows, total, complete: !request, pages: index };
  };

  globalThis.__invoke = async (hook, argsJson) => {
    const args = JSON.parse(argsJson);
    const hooks = globalThis.__hooks || {};
    current = args.ctx;
    env = { baseUrl: args.ctx.baseUrl || "", apiHosts: args.ctx.apiHosts || [] };
    let result = null;
    if (hook === "authenticate") {
      if (hooks.authenticate) await hooks.authenticate(args.ctx);
    } else if (hook === "signRequest") {
      result = await signed(normalize(args.request), true);
    } else if (hook === "read") {
      result = hooks.read ? asResult(await hooks.read(args.ctx)) : await defaultRead(args.ctx);
    } else throw new Error(`no hook "${hook}"`);
    return JSON.stringify(result === undefined ? null : result);
  };
})();
