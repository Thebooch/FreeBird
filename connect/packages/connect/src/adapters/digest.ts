/**
 * HTTP Digest (RFC 7616): the answer to a server's challenge.
 *
 * The server refuses the first request with `WWW-Authenticate: Digest …`,
 * naming a realm and a nonce; the request is sent again with a response that
 * proves the password without sending it. Written without Node's crypto, since
 * this package also runs in the browser: MD5 by hand, SHA-256 by WebCrypto.
 */

export interface DigestChallenge {
  readonly realm: string;
  readonly nonce: string;
  readonly qop?: string;
  readonly algorithm: string;
  readonly opaque?: string;
}

/** The Digest challenge in a `WWW-Authenticate` header, or null when there is none. */
export const parseDigestChallenge = (header: string | null | undefined): DigestChallenge | null => {
  if (!header) return null;
  const at = header.search(/digest\s/i);
  if (at === -1) return null;
  const fields: Record<string, string> = {};
  for (const match of header.slice(at + 7).matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi)) {
    fields[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  }
  if (fields.realm === undefined || !fields.nonce) return null;
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    ...(fields.qop ? { qop: fields.qop } : {}),
    algorithm: fields.algorithm ?? "MD5",
    ...(fields.opaque ? { opaque: fields.opaque } : {}),
  };
};

/* ── MD5 (RFC 1321), on UTF-8 ─────────────────────────────────────────── */

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

export const md5 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  const length = ((bytes.length + 8) >>> 6) + 1;
  const words = new Uint32Array(length * 16);
  for (let index = 0; index < bytes.length; index++) words[index >> 2]! |= bytes[index]! << ((index % 4) * 8);
  words[bytes.length >> 2]! |= 0x80 << ((bytes.length % 4) * 8);
  const bits = bytes.length * 8;
  words[length * 16 - 2] = bits >>> 0;
  words[length * 16 - 1] = Math.floor(bits / 2 ** 32) >>> 0;
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let block = 0; block < length; block++) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index++) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const sum = (a + f + K[index]! + words[block * 16 + g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[index]!) | (sum >>> (32 - S[index]!)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0]
    .map((word) => Array.from({ length: 4 }, (_, index) => ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, "0")).join(""))
    .join("");
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomHex = (bytes: number): string =>
  [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The `Authorization` header answering a challenge, for one request. Null for an algorithm it does not know. */
export const digestAuthorization = async (input: {
  readonly challenge: DigestChallenge;
  readonly username: string;
  readonly password: string;
  readonly method: string;
  /** The request's path and query, as sent. */
  readonly uri: string;
  /** How many requests this nonce has answered, this one included. */
  readonly count: number;
  /** Fixed in tests; random otherwise. */
  readonly cnonce?: string;
}): Promise<string | null> => {
  const { challenge } = input;
  const algorithm = challenge.algorithm.toUpperCase();
  const hash =
    algorithm === "MD5" || algorithm === "MD5-SESS"
      ? async (text: string) => md5(text)
      : algorithm === "SHA-256" || algorithm === "SHA-256-SESS"
        ? sha256
        : null;
  if (!hash) return null;
  const cnonce = input.cnonce ?? randomHex(8);
  const nc = input.count.toString(16).padStart(8, "0");
  const qop = challenge.qop
    ?.split(",")
    .map((one) => one.trim())
    .find((one) => one === "auth");
  let ha1 = await hash(`${input.username}:${challenge.realm}:${input.password}`);
  if (algorithm.endsWith("-SESS")) ha1 = await hash(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = await hash(`${input.method.toUpperCase()}:${input.uri}`);
  const response = qop
    ? await hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : await hash(`${ha1}:${challenge.nonce}:${ha2}`);
  const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
  return [
    `Digest username=${quote(input.username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(input.uri)}`,
    `algorithm=${challenge.algorithm}`,
    `response=${quote(response)}`,
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`] : []),
    ...(challenge.opaque !== undefined ? [`opaque=${quote(challenge.opaque)}`] : []),
  ].join(", ");
};
