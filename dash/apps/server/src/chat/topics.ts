import type { AuthContext, ChatMessage, DbAdapter } from "@freebirdai/core";
import type { LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { sql } from "kysely";
import { z } from "zod";
import type { ChatDb } from "./db.js";

/**
 * Topics: one continuous chat, divided by subject rather than by a "new chat"
 * button (plan 3, `plans/features/03-managed-chat-topics-timeline.md`).
 *
 * A topic is a chat session. Its id is the session id and its name is the
 * session's `title`, so every message already carries its topic id
 * (`session_id`) and guide's tables need no change. What changes is how the
 * conversation reads: the browser shows every topic as one stream, day by day,
 * and the model is given the current topic plus the recent ones before it.
 */

export interface TopicSummary {
  readonly id: string;
  readonly name: string;
  /** ISO time of the topic's first message (its creation, when it has none). */
  readonly firstAt: string;
  /** ISO time of its last message (its creation, when it has none). */
  readonly lastAt: string;
  readonly count: number;
}

/** Whose topics: the chat store folds both into every session row. */
export interface TopicOwner {
  readonly userId: string;
  readonly tenantId: string;
}

/** What a topic is called before anything has named it. */
export const UNNAMED_TOPIC = "Earlier chat";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A time zone Postgres and `Intl` both accept, or UTC. */
export const safeTimeZone = (tz: unknown): string => {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

export const isDay = (value: unknown): value is string => typeof value === "string" && DAY.test(value);

/** The calendar day an instant falls on in `tz`, as `YYYY-MM-DD`. */
export const dayOf = (instant: Date | string | number, tz: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

const nameOf = (title: unknown): string =>
  typeof title === "string" && title.trim().length > 0 ? title.trim() : UNNAMED_TOPIC;

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatMessage["role"];
  content: string;
  references_json: unknown;
  tool_name: string | null;
  tool_payload: unknown;
  created_at: Date | string;
}

const toMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  sessionId: row.session_id,
  role: row.role,
  content: row.content,
  references: (row.references_json as ChatMessage["references"]) ?? [],
  ...(row.tool_name ? { toolName: row.tool_name } : {}),
  ...(row.tool_payload !== null && row.tool_payload !== undefined ? { toolPayload: row.tool_payload } : {}),
  createdAt: new Date(row.created_at),
});

/** The roles a person reads. Tool rows are the engine's own bookkeeping. */
const SHOWN = sql`m.role IN ('user', 'assistant')`;

/**
 * One person's topics, read straight from the chat tables.
 *
 * Direct SQL rather than the adapter because the questions are new ones (by
 * day, across sessions), and every query names the owner explicitly: the
 * adapter's own scoping drops a blank identity, and these rows are somebody's
 * conversation.
 */
export class TopicStore {
  constructor(
    private readonly chat: ChatDb,
    private readonly owner: TopicOwner,
  ) {}

  private get db() {
    return this.chat.kysely;
  }

  private get mine() {
    return sql`s.tenant_id = ${this.owner.tenantId} AND s.user_id = ${this.owner.userId}`;
  }

  /** The auth the adapter wants, for the one write that goes through it. */
  get auth(): AuthContext {
    return { userId: this.owner.userId, orgId: this.owner.tenantId };
  }

  /** Most recently active first. */
  async recent(limit = 5): Promise<TopicSummary[]> {
    const { rows } = await sql<{
      id: string;
      title: string | null;
      first_at: Date | string;
      last_at: Date | string;
      count: number;
    }>`
      SELECT s.id, s.title,
        COALESCE(MIN(m.created_at), s.created_at) AS first_at,
        COALESCE(MAX(m.created_at), s.created_at) AS last_at,
        COUNT(m.id)::int AS count
      FROM freebird_chat_session s
      LEFT JOIN freebird_chat_message m ON m.session_id = s.id AND ${SHOWN}
      WHERE ${this.mine}
      GROUP BY s.id, s.title, s.created_at
      ORDER BY last_at DESC, s.id DESC
      LIMIT ${Math.max(1, Math.min(limit, 50))}
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      name: nameOf(row.title),
      firstAt: iso(row.first_at),
      lastAt: iso(row.last_at),
      count: row.count,
    }));
  }

  async get(id: string): Promise<TopicSummary | null> {
    const { rows } = await sql<{
      id: string;
      title: string | null;
      first_at: Date | string;
      last_at: Date | string;
      count: number;
    }>`
      SELECT s.id, s.title,
        COALESCE(MIN(m.created_at), s.created_at) AS first_at,
        COALESCE(MAX(m.created_at), s.created_at) AS last_at,
        COUNT(m.id)::int AS count
      FROM freebird_chat_session s
      LEFT JOIN freebird_chat_message m ON m.session_id = s.id AND ${SHOWN}
      WHERE ${this.mine} AND s.id = ${id}
      GROUP BY s.id, s.title, s.created_at
    `.execute(this.db);
    const row = rows[0];
    return row
      ? { id: row.id, name: nameOf(row.title), firstAt: iso(row.first_at), lastAt: iso(row.last_at), count: row.count }
      : null;
  }

  /** Start a topic. Through the adapter, so the row is exactly what guide writes. */
  async create(name: string): Promise<TopicSummary> {
    const session = await this.chat.adapter.createSession({ title: name.slice(0, 120) }, this.auth);
    const at = iso(session.createdAt ?? new Date());
    return { id: session.id, name: nameOf(session.title), firstAt: at, lastAt: at, count: 0 };
  }

  /** Messages of the given topics at or after `since`, oldest first. */
  async messagesOf(topicIds: readonly string[], since?: Date): Promise<ChatMessage[]> {
    if (topicIds.length === 0) return [];
    const { rows } = await sql<MessageRow>`
      SELECT m.* FROM freebird_chat_message m
      JOIN freebird_chat_session s ON s.id = m.session_id
      WHERE ${this.mine} AND ${SHOWN}
        AND m.session_id IN (${sql.join(topicIds.map((id) => sql`${id}`))})
        ${since ? sql`AND m.created_at >= ${since.toISOString()}` : sql``}
      ORDER BY m.created_at ASC, m.id ASC
    `.execute(this.db);
    return rows.map(toMessage);
  }

  /** Days that have messages, newest first. */
  async days(tz: string, options: { before?: string; limit?: number } = {}): Promise<Array<{ day: string; messages: number; topics: number }>> {
    const local = sql`to_char(m.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
    const { rows } = await sql<{ day: string; messages: number; topics: number }>`
      SELECT ${local} AS day, COUNT(*)::int AS messages, COUNT(DISTINCT m.session_id)::int AS topics
      FROM freebird_chat_message m
      JOIN freebird_chat_session s ON s.id = m.session_id
      WHERE ${this.mine} AND ${SHOWN}
        ${options.before ? sql`AND ${local} < ${options.before}` : sql``}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${Math.max(1, Math.min(options.limit ?? 30, 120))}
    `.execute(this.db);
    return rows;
  }

  /** The topics talked about on one day, in the order they started that day. */
  async topicsOn(tz: string, day: string): Promise<TopicSummary[]> {
    const local = sql`to_char(m.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
    const { rows } = await sql<{
      id: string;
      title: string | null;
      first_at: Date | string;
      last_at: Date | string;
      count: number;
    }>`
      SELECT s.id, s.title, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at, COUNT(*)::int AS count
      FROM freebird_chat_message m
      JOIN freebird_chat_session s ON s.id = m.session_id
      WHERE ${this.mine} AND ${SHOWN} AND ${local} = ${day}
      GROUP BY s.id, s.title
      ORDER BY first_at ASC, s.id ASC
    `.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      name: nameOf(row.title),
      firstAt: iso(row.first_at),
      lastAt: iso(row.last_at),
      count: row.count,
    }));
  }

  /**
   * Every message on one day, across topics, and the nearest days either side
   * that have any — which is what scrolling past the day's border loads next.
   */
  async messagesOn(
    tz: string,
    day: string,
  ): Promise<{ messages: ChatMessage[]; topics: Record<string, string>; prev: string | null; next: string | null }> {
    const local = sql`to_char(m.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
    const { rows } = await sql<MessageRow & { title: string | null }>`
      SELECT m.*, s.title FROM freebird_chat_message m
      JOIN freebird_chat_session s ON s.id = m.session_id
      WHERE ${this.mine} AND ${SHOWN} AND ${local} = ${day}
      ORDER BY m.created_at ASC, m.id ASC
    `.execute(this.db);
    const { rows: around } = await sql<{ prev: string | null; next: string | null }>`
      SELECT
        MAX(CASE WHEN ${local} < ${day} THEN ${local} END) AS prev,
        MIN(CASE WHEN ${local} > ${day} THEN ${local} END) AS next
      FROM freebird_chat_message m
      JOIN freebird_chat_session s ON s.id = m.session_id
      WHERE ${this.mine} AND ${SHOWN}
    `.execute(this.db);
    const topics: Record<string, string> = {};
    for (const row of rows) topics[row.session_id] = nameOf(row.title);
    return {
      messages: rows.map(toMessage),
      topics,
      prev: around[0]?.prev ?? null,
      next: around[0]?.next ?? null,
    };
  }
}

/* ── what the model is given ─────────────────────────────────────────── */

export const CONTEXT_TOPICS = 2;
export const CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The earlier topics a turn may see: the last two before the current one, or
 * the last 24 hours, whichever is smaller (Joseph, 2026-10-07). So a topic
 * counts only when it is one of the two most recently active besides the
 * current one *and* it was active within the window.
 *
 * `recent` must be most recently active first, as `TopicStore.recent` returns.
 */
export const contextTopics = (
  recent: readonly TopicSummary[],
  currentId: string,
  now: number,
  options: { topics?: number; windowMs?: number } = {},
): TopicSummary[] => {
  const windowMs = options.windowMs ?? CONTEXT_WINDOW_MS;
  return recent
    .filter((topic) => topic.id !== currentId && topic.count > 0)
    .slice(0, options.topics ?? CONTEXT_TOPICS)
    .filter((topic) => Date.parse(topic.lastAt) >= now - windowMs);
};

/** Per earlier topic, the most of its transcript that is sent. The tail is kept. */
const TOPIC_CHARS = 6_000;

/**
 * The note the model reads ahead of the current topic. Null when there is
 * nothing earlier inside the window.
 */
export const renderEarlierTopics = (
  topics: readonly TopicSummary[],
  messages: readonly ChatMessage[],
  now: number,
): string | null => {
  const blocks: string[] = [];
  // Oldest first, so the note reads in the order it was said.
  for (const topic of [...topics].reverse()) {
    const lines = messages
      .filter((message) => message.sessionId === topic.id)
      .map((message) => `${message.role === "user" ? "Person" : "Assistant"}: ${message.content.trim()}`);
    if (lines.length === 0) continue;
    let transcript = lines.join("\n");
    if (transcript.length > TOPIC_CHARS) transcript = `…${transcript.slice(-TOPIC_CHARS)}`;
    const hours = Math.max(0, Math.round((now - Date.parse(topic.lastAt)) / 3_600_000));
    const when = hours === 0 ? "within the hour" : `${hours} hour${hours === 1 ? "" : "s"} ago`;
    blocks.push(`Earlier topic "${topic.name}" (last message ${when}):\n${transcript}`);
  }
  if (blocks.length === 0) return null;
  return [
    "This conversation is one continuous chat divided into topics. Before the current topic,",
    "the person talked about the following. Use it when they refer back to it; otherwise",
    "answer about the current topic.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
};

/** Where the engine's `history.slice(-30)` cannot cut the note off. */
const ENGINE_HISTORY = 30;

/**
 * The chat store as the engine sees it: on a chat turn, `listMessages` for the
 * current topic also carries one note holding the earlier topics inside the
 * window. Every other caller (the history route included) sees the store as it is.
 *
 * `isTurn` reads the auth context `getAuthContext` built for the request.
 */
export const withTopicContext = (
  adapter: DbAdapter,
  options: {
    readonly storeFor: (auth: AuthContext) => TopicStore | null;
    readonly isTurn: (auth: AuthContext) => boolean;
    readonly now?: () => number;
  },
): DbAdapter =>
  new Proxy(adapter, {
    get(target, prop) {
      if (prop === "listMessages") {
        return async (sessionId: string, auth: AuthContext): Promise<ChatMessage[]> => {
          const own = await target.listMessages(sessionId, auth);
          if (!options.isTurn(auth)) return own;
          const topics = options.storeFor(auth);
          if (!topics) return own;
          try {
            const now = (options.now ?? Date.now)();
            const earlier = contextTopics(await topics.recent(CONTEXT_TOPICS + 1), sessionId, now);
            if (earlier.length === 0) return own;
            const messages = await topics.messagesOf(
              earlier.map((topic) => topic.id),
              new Date(now - CONTEXT_WINDOW_MS),
            );
            const note = renderEarlierTopics(earlier, messages, now);
            if (!note) return own;
            const noteMessage: ChatMessage = {
              id: `earlier-topics:${sessionId}`,
              sessionId,
              role: "system",
              content: note,
              references: [],
              createdAt: new Date(now),
            };
            // Placed so the engine's history cap keeps it: the earlier topics
            // count as one message, and the current topic keeps the rest.
            const at = Math.max(0, own.length - (ENGINE_HISTORY - 1));
            return [...own.slice(0, at), noteMessage, ...own.slice(at)];
          } catch {
            // Context from earlier topics improves a turn; it must never fail one.
            return own;
          }
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

/* ── deciding the topic ──────────────────────────────────────────────── */

export interface TopicCandidate {
  readonly id: string;
  readonly name: string;
  /** The last few lines said in it. */
  readonly recent: string;
}

export type TopicDecision =
  | { readonly kind: "same"; readonly id: string }
  | { readonly kind: "new"; readonly name: string; readonly why: "explicit" | "first" | "new-day" | "model" };

const EXPLICIT = /^\s*(?:let'?s\s+)?(?:start\s+(?:a\s+)?)?new\s+topic\b[\s:,.\-–—]*(.*)$/is;

/** "new topic", "new topic: rent roll", "start a new topic about leases". */
export const explicitNewTopic = (text: string): { name: string } | null => {
  const match = EXPLICIT.exec(text);
  if (!match) return null;
  const rest = (match[1] ?? "").split("\n")[0]!.replace(/^(?:about|on|for|re)\s+/i, "").trim();
  return { name: rest.length > 0 ? nameFromText(rest) : "" };
};

/** A name from the person's own words, when nothing better is available. */
export const nameFromText = (text: string): string => {
  const words = text
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
  const name = words.length > 48 ? `${words.slice(0, 47)}…` : words;
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : "New topic";
};

export const TOPIC_SYSTEM_PROMPT = [
  "A person is chatting with an assistant about their business dashboard. The chat is one",
  "continuous conversation divided into topics. A new message has arrived. Decide which topic",
  "it belongs to.",
  "",
  "- Topic 0 is the current one. Choose it unless the message is clearly about something else.",
  "  Follow-ups, clarifications, thanks, short replies and questions about the same records",
  "  all stay. A wrong split is worse than a long topic.",
  "- Choose another listed topic only when the message plainly returns to it.",
  "- Choose -1 for a new topic when the subject clearly changes, and give it a short name:",
  "  two to five words, in the person's own vocabulary, no punctuation at the end.",
  "- When no topics are listed, choose -1 and name the topic.",
].join("\n");

const topicSchema = z.object({
  topic: z.number().int().min(-1).describe("The 0-based position of the listed topic, or -1 for a new one."),
  name: z.string().max(80).default("").describe("The new topic's name. Only when topic is -1."),
});

const topicTool: LlmTool = {
  name: "choose_topic",
  description: "Say which topic the new message belongs to.",
  schema: topicSchema,
};

export const buildTopicPrompt = (text: string, candidates: readonly TopicCandidate[]): string =>
  [
    `New message: ${JSON.stringify(text.slice(0, 2_000))}`,
    "",
    candidates.length === 0
      ? "No topics are listed: this message starts the day's first topic."
      : candidates
          .map((candidate, index) => `Topic ${index}: "${candidate.name}"\n${candidate.recent.slice(-1_500)}`)
          .join("\n\n"),
  ].join("\n");

/**
 * Which topic a message belongs to.
 *
 * Rules first, model second: an explicit "new topic" always splits, and a
 * person with no topic today starts one. Otherwise one cheap call chooses
 * among the candidates (the current topic is always the first). Without a
 * model, or when the call fails, the message stays where it is.
 */
export const decideTopic = async (input: {
  readonly text: string;
  /** Current topic first. Empty when there is no current topic today. */
  readonly candidates: readonly TopicCandidate[];
  /** Why there is no current topic, when there is none. */
  readonly fresh?: "first" | "new-day" | undefined;
  readonly llm: LlmAdapter | null;
  readonly signal?: AbortSignal | undefined;
}): Promise<TopicDecision> => {
  const explicit = explicitNewTopic(input.text);
  if (explicit?.name) return { kind: "new", name: explicit.name, why: "explicit" };

  const forced = explicit ? "explicit" : input.candidates.length === 0 ? (input.fresh ?? "first") : null;
  const fallbackName = (): string => nameFromText(explicit ? "New topic" : input.text);
  if (!input.llm) {
    return forced ? { kind: "new", name: fallbackName(), why: forced } : { kind: "same", id: input.candidates[0]!.id };
  }

  const offered = forced ? [] : input.candidates;
  try {
    const result = await input.llm.generate({
      temperature: 0,
      maxOutputTokens: 200,
      ...(input.signal ? { signal: input.signal } : {}),
      messages: [
        { role: "system" as const, content: TOPIC_SYSTEM_PROMPT },
        { role: "user" as const, content: buildTopicPrompt(input.text, offered) },
      ],
      tools: { choose_topic: topicTool },
      toolChoice: { name: "choose_topic" as const },
    });
    const call = result.toolCalls.find((one) => one.name === "choose_topic");
    const parsed = call ? topicSchema.safeParse(call.args) : null;
    if (parsed?.success) {
      const { topic, name } = parsed.data;
      const named = name.trim().replace(/[.!?]+$/, "");
      if (forced) return { kind: "new", name: named || fallbackName(), why: forced };
      if (topic >= 0 && topic < offered.length) return { kind: "same", id: offered[topic]!.id };
      if (topic === -1) return { kind: "new", name: named || fallbackName(), why: "model" };
    }
  } catch {
    // Fall through: staying put is the safe answer.
  }
  return forced ? { kind: "new", name: fallbackName(), why: forced } : { kind: "same", id: input.candidates[0]!.id };
};

/** The last few lines of a topic, for the decision prompt. */
export const recentLines = (messages: readonly ChatMessage[], topicId: string, lines = 6): string =>
  messages
    .filter((message) => message.sessionId === topicId)
    .slice(-lines)
    .map((message) => `${message.role === "user" ? "Person" : "Assistant"}: ${message.content.trim().slice(0, 300)}`)
    .join("\n");
