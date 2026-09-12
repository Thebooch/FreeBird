import { authKeyRefs, type AuthSpec } from "@freebirdai/dash-spec";
import { AdapterError, type FetchContext } from "./types.js";

/** Shared by REST and GraphQL; secrets are resolved only when a request is ready. */
export const applyRequestAuth = async (
  auth: AuthSpec, title: string, ctx: FetchContext,
  headers: Record<string, string>, query: URLSearchParams,
): Promise<string | null> => {
  const secrets = new Map<string, string>();
  for (const ref of authKeyRefs(auth)) {
    const secret = await ctx.resolveSecret?.(ref);
    if (!secret) throw new AdapterError(`no key stored for "${ref}"`, { status: 401, userMessage: `${title} needs an API key before it can load anything.` });
    secrets.set(ref, secret);
  }
  const secret = (ref: string) => secrets.get(ref)!;
  switch (auth.type) {
    case "none": return null;
    case "bearer": headers.authorization = `Bearer ${secret(auth.keyRef)}`; break;
    case "header": headers[auth.header.toLowerCase()] = auth.template ? auth.template.replace("{{key}}", secret(auth.keyRef)) : secret(auth.keyRef); break;
    case "headers":
      for (const part of auth.parts) headers[part.header.toLowerCase()] = part.template ? part.template.replace("{{key}}", secret(part.keyRef)) : secret(part.keyRef);
      break;
    case "query": query.set(auth.param, secret(auth.keyRef)); return auth.param;
    case "basic": {
      const value = `${auth.username}:${secret(auth.keyRef)}`;
      if (typeof btoa !== "function") throw new AdapterError("no base64 implementation available");
      headers.authorization = `Basic ${btoa(value)}`;
      break;
    }
  }
  return null;
};
