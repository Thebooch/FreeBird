import type {
  AuthContext,
  ChatMessage,
  ChatSession,
  CustomTab,
  DigestConfig,
  LayoutPlan,
} from "../types.js";
import type { Skill, SkillUpsertInput } from "../skills/types.js";

/**
 * Range for date-filtered queries. Both endpoints are inclusive. UTC.
 */
export interface DateRange {
  from: Date;
  to: Date;
}

export interface ChatSessionCreateInput {
  id?: string;
  title?: string;
  topic?: string;
  tags?: string[];
}

export interface ChatSessionUpdateInput {
  title?: string;
  topic?: string;
  tags?: string[];
  activeLayoutId?: string;
}

export interface ChatMessageCreateInput {
  id?: string;
  sessionId: string;
  role: ChatMessage["role"];
  content: string;
  references?: ChatMessage["references"];
  toolName?: string;
  toolPayload?: unknown;
}

export interface CustomTabCreateInput {
  id?: string;
  title: string;
  slug?: string;
  layout: LayoutPlan;
  digest?: DigestConfig;
}

export interface CustomTabUpdateInput {
  title?: string;
  slug?: string;
  layout?: LayoutPlan;
  digest?: DigestConfig | null;
}

/**
 * A blob a host app parked between requests.
 *
 * Scratch is the thing v1 deliberately did not have. The action journal's own
 * docstring says it is never persisted, so any multi-turn flow a host builds —
 * a setup wizard, a half-finished form, a workflow waiting on a prerequisite —
 * lives in the browser and dies with the tab. This is the general primitive
 * for that, and it is deliberately *not* a table per feature: FreeBird has no
 * business knowing what a host is halfway through doing.
 */
export interface ScratchRecord<T = unknown> {
  /**
   * What the blob belongs to, chosen by the host.
   *
   * Usually a chat session id, but deliberately opaque and **not** a foreign
   * key. A host may keep scratch against a document, a board or a workspace,
   * and scratch that outlives the session that created it is a legitimate
   * thing to want — a wizard interrupted by a reload is the ordinary case.
   */
  scope: string;
  /** Which feature's blob, so two features under one scope cannot collide. */
  namespace: string;
  data: T;
  /** Absolute expiry. Null means it lives until deleted. */
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface ScratchPutInput {
  scope: string;
  namespace: string;
  data: unknown;
  /** Absolute expiry. Omit or null to keep it until it is deleted. */
  expiresAt?: Date | null;
}

/**
 * Distributed lock contract used by the digest scheduler when running in
 * `schedulerMode: "inProcess"` on a multi-replica deployment, or by the
 * `@freebirdai/digest-worker`. If you only ever run a single process, you can
 * return a permanent "acquired" token.
 */
export interface LockHandle {
  release: () => Promise<void>;
}

export interface LockAdapter {
  /** Acquire a named lock with a lease (ms). Returns null if already held. */
  acquire: (key: string, leaseMs: number) => Promise<LockHandle | null>;
}

/**
 * The full DB adapter contract every storage backend must satisfy.
 *
 * Note: every method takes an `AuthContext`. Adapters are responsible for
 * scoping reads and writes by `userId` / `orgId` where appropriate.
 */
export interface DbAdapter {
  // chat sessions
  createSession: (input: ChatSessionCreateInput, auth: AuthContext) => Promise<ChatSession>;
  updateSession: (
    id: string,
    input: ChatSessionUpdateInput,
    auth: AuthContext,
  ) => Promise<ChatSession>;
  getSession: (id: string, auth: AuthContext) => Promise<ChatSession | null>;
  listSessionsByDate: (range: DateRange, auth: AuthContext) => Promise<ChatSession[]>;
  listSessionsByTopic: (topic: string, auth: AuthContext) => Promise<ChatSession[]>;
  listSessionsByTag: (tag: string, auth: AuthContext) => Promise<ChatSession[]>;
  deleteSession: (id: string, auth: AuthContext) => Promise<void>;

  // chat messages
  appendMessage: (input: ChatMessageCreateInput, auth: AuthContext) => Promise<ChatMessage>;
  listMessages: (sessionId: string, auth: AuthContext) => Promise<ChatMessage[]>;
  /** Used by references.ts for tag-based retrieval. */
  listMessagesByTag: (
    tag: string,
    opts: { limit: number; excludeSessionId?: string },
    auth: AuthContext,
  ) => Promise<ChatMessage[]>;

  // custom tabs
  createTab: (input: CustomTabCreateInput, auth: AuthContext) => Promise<CustomTab>;
  updateTab: (id: string, input: CustomTabUpdateInput, auth: AuthContext) => Promise<CustomTab>;
  getTab: (id: string, auth: AuthContext) => Promise<CustomTab | null>;
  listTabs: (auth: AuthContext) => Promise<CustomTab[]>;
  deleteTab: (id: string, auth: AuthContext) => Promise<void>;

  /**
   * Return all tabs whose digest.nextRunAt <= now (across all users).
   * Used by the digest scheduler. Implementations MAY ignore AuthContext
   * since the scheduler runs as the system.
   */
  listDueDigests: (now: Date) => Promise<CustomTab[]>;

  // scratch
  /**
   * Read a host app's parked blob, or null when there is none or it expired.
   *
   * Optional, like `locks`: an adapter written before this existed is still a
   * valid `DbAdapter`, and a host that needs scratch should say so through
   * `requireScratch` rather than crash on an undefined method.
   */
  getScratch?: <T = unknown>(
    scope: string,
    namespace: string,
    auth: AuthContext,
  ) => Promise<ScratchRecord<T> | null>;
  /** Write it, replacing whatever was there for the same scope + namespace. */
  putScratch?: (input: ScratchPutInput, auth: AuthContext) => Promise<ScratchRecord>;
  deleteScratch?: (scope: string, namespace: string, auth: AuthContext) => Promise<void>;
  /**
   * Drop everything already past its expiry. Returns how many rows went.
   *
   * Runs as the system across every tenant, like `listDueDigests` — expiry is
   * housekeeping, not a read of anybody's data.
   */
  purgeExpiredScratch?: (now: Date) => Promise<number>;

  // skills
  /**
   * Instruction packs available to this caller.
   *
   * Optional for the same reason scratch is: an adapter written before skills
   * existed is still a valid `DbAdapter`, and a host that wants DB-backed
   * skills should say so through `requireSkills` rather than crash on an
   * undefined method. A host with no skill storage at all simply supplies no
   * provider — that is a supported steady state, not a misconfiguration.
   */
  listSkills?: (auth: AuthContext) => Promise<Skill[]>;
  putSkill?: (input: SkillUpsertInput, auth: AuthContext) => Promise<Skill>;
  deleteSkill?: (id: string, auth: AuthContext) => Promise<void>;

  /** Optional distributed lock for digest scheduling. */
  locks?: LockAdapter;
}

/** The skills half of an adapter, or a clear error naming what is missing. */
export interface SkillStore {
  list: (auth: AuthContext) => Promise<Skill[]>;
  put: (input: SkillUpsertInput, auth: AuthContext) => Promise<Skill>;
  delete: (id: string, auth: AuthContext) => Promise<void>;
}

/** Helper to assert the DB adapter can store instruction packs. */
export const requireSkills = (db: DbAdapter): SkillStore => {
  if (!db.listSkills || !db.putSkill || !db.deleteSkill) {
    throw new Error(
      "FreeBird: this DB adapter does not support skills. " +
        "Implement listSkills/putSkill/deleteSkill, or supply your own SkillProvider.",
    );
  }
  return {
    list: db.listSkills.bind(db),
    put: db.putSkill.bind(db),
    delete: db.deleteSkill.bind(db),
  };
};

/** The scratch half of an adapter, or a clear error naming what is missing. */
export interface ScratchStore {
  get: <T = unknown>(
    scope: string,
    namespace: string,
    auth: AuthContext,
  ) => Promise<ScratchRecord<T> | null>;
  put: (input: ScratchPutInput, auth: AuthContext) => Promise<ScratchRecord>;
  delete: (scope: string, namespace: string, auth: AuthContext) => Promise<void>;
}

/** Helper to assert the DB adapter can park a blob between requests. */
export const requireScratch = (db: DbAdapter): ScratchStore => {
  if (!db.getScratch || !db.putScratch || !db.deleteScratch) {
    throw new Error(
      "FreeBird: this DB adapter does not support scratch storage. " +
        "Implement getScratch/putScratch/deleteScratch, or keep the state in the client.",
    );
  }
  return {
    get: db.getScratch.bind(db),
    put: db.putScratch.bind(db),
    delete: db.deleteScratch.bind(db),
  };
};

/** Helper to assert the DB adapter has a lock implementation. */
export const requireLocks = (db: DbAdapter): LockAdapter => {
  if (!db.locks) {
    throw new Error(
      "FreeBird: this DB adapter does not support distributed locks. " +
        "Provide one via the `locks` property or run a single-replica deployment.",
    );
  }
  return db.locks;
};
