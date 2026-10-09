/**
 * Which public page a path is:
 *
 * - `/p/<workspace>/book/<token>`: a person's own booking page;
 * - `/p/<workspace>/t/<slug>`: an appointment type's public link;
 * - `/p/<workspace>/approve/<token>?choice=approve|suggest|deny`: a member's approval page.
 */

export type PublicRoute =
  | { readonly kind: "book"; readonly workspace: string; readonly token: string }
  | { readonly kind: "type"; readonly workspace: string; readonly slug: string }
  | { readonly kind: "approve"; readonly workspace: string; readonly token: string; readonly choice: "approve" | "suggest" | "deny" | null }
  | { readonly kind: "none" };

const WORKSPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const publicRouteOf = (pathname: string, search = ""): PublicRoute => {
  const parts = pathname.split("/").filter(Boolean).map((one) => {
    try {
      return decodeURIComponent(one);
    } catch {
      return "";
    }
  });
  const [p, workspace, kind, key] = parts;
  if (p !== "p" || !workspace || !WORKSPACE.test(workspace) || !key || parts.length !== 4) return { kind: "none" };
  if (kind === "book" && TOKEN.test(key)) return { kind: "book", workspace, token: key };
  if (kind === "t" && SLUG.test(key)) return { kind: "type", workspace, slug: key };
  if (kind === "approve" && TOKEN.test(key)) {
    const choice = new URLSearchParams(search).get("choice");
    return { kind: "approve", workspace, token: key, choice: choice === "approve" || choice === "suggest" || choice === "deny" ? choice : null };
  }
  return { kind: "none" };
};
