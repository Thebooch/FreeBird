import type { Principal } from "@freebirdai/dash-spec";

/**
 * Who a local instance runs as.
 *
 * Never blank: the chat adapter drops its owner filter for a falsy user id,
 * so an empty identity would make every session readable by every caller the
 * moment this stops being single-user.
 */
export const LOCAL_USER_ID = "local";

/** The one workspace a local instance has. */
export const LOCAL_WORKSPACE_ID = "local";

/**
 * How a request says who sent it.
 *
 * The open-source build answers the same for every request — whoever can
 * reach the server already controls it, since it listens on localhost only —
 * so it needs no sign-in and has nothing to check. A managed build answers
 * from a session: a cookie or a token naming a member of a workspace, or
 * `null` for a request that names nobody, which the server turns into a 401.
 *
 * The request is typed loosely on purpose: this is read by the server's own
 * hook, and a managed resolver needs headers and cookies, nothing framework
 * specific.
 */
export interface IdentityResolver {
  resolve(request: {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly url: string;
  }): Principal | null | Promise<Principal | null>;
}

const LOCAL_OWNER: Principal = Object.freeze({
  userId: LOCAL_USER_ID,
  workspaceId: LOCAL_WORKSPACE_ID,
  role: "owner",
  kind: "local-owner",
});

/** The open-source build's only answer: the person running it owns everything on it. */
export const localOwner = (): IdentityResolver => ({ resolve: () => LOCAL_OWNER });
