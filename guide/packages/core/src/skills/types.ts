import type { AuthContext } from "../types.js";

/**
 * A repeatable procedure the assistant should follow.
 *
 * The registry already carries two of the three things an assistant needs:
 * `knowledge` grounds *answers*, `actions` are things to *do*. Missing is the
 * bit in between — "when someone asks for a refund, check the order date
 * first, then …" — which today has nowhere to live but the global
 * `systemPrompt`, one string shared by every tenant, component and turn.
 *
 * Deliberately plain data: a string id and a markdown body, no functions and
 * no host references. A skill has to survive being a database row, an API
 * response, and a file somebody downloaded, without changing shape at any of
 * those boundaries.
 */
export interface Skill {
  readonly id: string;
  readonly title?: string;
  /** One line, so a reader can tell what it is without the whole body. */
  readonly description?: string;
  /**
   * Component ids this applies to. Absent means it always applies.
   *
   * Scoping is what keeps a large skill library from costing anything on the
   * turns it is irrelevant to.
   */
  readonly appliesTo?: readonly string[];
  /** Markdown. The instructions themselves. */
  readonly body: string;
}

/** Input for writing a skill through a store that supports it. */
export interface SkillUpsertInput {
  id: string;
  title?: string;
  description?: string;
  appliesTo?: string[];
  body: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Where skills come from, resolved once per turn.
 *
 * A resolver rather than a registration, and the difference is the whole
 * design. OpenClaw reads `SKILL.md` off the operator's disk because it is a
 * desktop app with one user; FreeBird is browser-first and serves many
 * tenants from one process, so there is no filesystem to read and no single
 * machine whose files would be the right answer.
 *
 * Taking `auth` is what makes it multi-tenant safe by construction: the
 * managed build resolves the tenant's selected skills from its database, an
 * open-source host resolves whatever it likes, and neither can accidentally
 * serve one tenant another's instructions.
 *
 * Mirrors the shape `knowledgeContext.retrieve` already established.
 */
export type SkillProvider = (ctx: {
  auth: AuthContext;
  sessionId: string;
  /** The user's message this turn, for hosts doing relevance retrieval. */
  text: string;
  activeComponentIds: readonly string[];
}) => MaybePromise<readonly Skill[]>;
