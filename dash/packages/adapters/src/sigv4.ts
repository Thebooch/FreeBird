/**
 * AWS Signature Version 4: a built-in, reviewed signer (plan, track B).
 *
 * The plan's rule for signing: a scheme that needs raw secret material is a
 * host-side signer in the repository, never connector code. SigV4 is the one
 * most business APIs behind AWS use — API Gateway with IAM authorisation, and
 * AWS's own services. Written on WebCrypto, since this package also runs in
 * the browser; the secret key only ever reaches `HMAC`.
 */

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (text: string): Promise<string> =>
  hex(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(text)));

const hmac = async (key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> => {
  const imported = await globalThis.crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return globalThis.crypto.subtle.sign("HMAC", imported, encoder.encode(text));
};

/** RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters. */
const encode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** `20150830T123600Z` and `20150830`. */
const stamps = (now: number): { readonly amzDate: string; readonly date: string } => {
  const amzDate = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, date: amzDate.slice(0, 8) };
};

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  readonly region: string;
  readonly service: string;
}

/**
 * The headers that sign one request: `authorization`, `x-amz-date`, and
 * `x-amz-security-token` for temporary credentials (plus
 * `x-amz-content-sha256`, which S3 requires).
 */
export const signSigV4 = async (input: {
  readonly method: string;
  readonly url: string;
  /** Headers the request sends, which are signed too (lowercased names). */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  readonly credentials: SigV4Credentials;
  readonly now: number;
}): Promise<Record<string, string>> => {
  const url = new URL(input.url);
  const { amzDate, date } = stamps(input.now);
  const { credentials } = input;
  const payload = await sha256Hex(input.body ?? "");
  const added: Record<string, string> = {
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
    ...(credentials.service === "s3" ? { "x-amz-content-sha256": payload } : {}),
  };
  /* Signed: host, the date, the token, and what the request already sends that says what it is. */
  const signed: Record<string, string> = { host: url.host, ...added };
  for (const [name, value] of Object.entries(input.headers)) {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower.startsWith("x-amz-")) signed[lower] = value;
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  /* The path as sent, each segment encoded again — except for S3, which signs it once. */
  const path = url.pathname || "/";
  const canonicalUri =
    credentials.service === "s3"
      ? path
      : path
          .split("/")
          .map((segment) => encode(segment))
          .join("/");
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payload,
  ].join("\n");
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, credentials.region);
  const kService = await hmac(kRegion, credentials.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};

/** The region and service an AWS address names: `abc.execute-api.eu-west-1.amazonaws.com`. */
export const awsScopeOf = (address: string): { readonly region: string; readonly service: string } | null => {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  const match = /(?:^|\.)([a-z0-9-]+)\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com(?:\.cn)?$/.exec(host);
  return match ? { service: match[1]!, region: match[2]! } : null;
};
