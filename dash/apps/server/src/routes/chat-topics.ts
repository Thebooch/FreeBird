import type { FastifyInstance, FastifyRequest } from "fastify";
import type { LlmAdapter } from "@freebirdai/dash-agent";
import type { Principal } from "@freebirdai/dash-spec";
import { z } from "zod";
import {
  contextTopics,
  dayOf,
  decideTopic,
  isDay,
  recentLines,
  safeTimeZone,
  type TopicCandidate,
  type TopicStore,
} from "../chat/topics.js";

/**
 * Work that finished, as the timeline lists it beside the topics: a workflow
 * run that ended, or a workflow task that was done.
 */
export interface TimelineTask {
  readonly id: string;
  readonly kind: "run" | "task";
  /** ISO time it finished. */
  readonly at: string;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly status: string;
  readonly agent?: string | undefined;
  readonly workflow?: string | undefined;
  /** Where it opens, as an app route (`#/agent/...`). */
  readonly link?: string | undefined;
}

const routeBody = z.object({
  text: z.string().min(1).max(20_000),
  /** The topic the browser is in, when it has one. */
  topicId: z.string().max(200).optional(),
  /** A topic the person jumped to from the timeline, which they may be returning to. */
  viewing: z.string().max(200).optional(),
  tz: z.string().max(64).optional(),
});

/**
 * Topics and the timeline (plan 3).
 *
 * - `POST /api/chat/route`: which topic the next message goes in, before it is sent.
 * - `GET /api/chat/days`: days with messages or finished work, newest first.
 * - `GET /api/chat/day/:date`: that day's topics and finished work.
 * - `GET /api/chat/messages?day=`: every message that day, for the chat's one stream.
 *
 * Every read is the asking person's own: topics are per person, as chat
 * sessions always were.
 */
export const chatTopicRoutes = (deps: {
  readonly storeFor: (principal: Principal) => TopicStore;
  /** The cheap model topic decisions run on; null when no AI key is set. */
  readonly llm: () => LlmAdapter | null;
  /** Finished work, newest first. Absent: the timeline shows topics only. */
  readonly work?: (() => Promise<readonly TimelineTask[]>) | undefined;
  readonly now?: () => number;
}) =>
  async (app: FastifyInstance): Promise<void> => {
    const now = deps.now ?? Date.now;
    const who = (request: FastifyRequest): Principal | null => request.principal ?? null;
    const work = async (): Promise<readonly TimelineTask[]> => {
      try {
        return deps.work ? await deps.work() : [];
      } catch {
        // Finished work is an addition to the timeline; topics still show without it.
        return [];
      }
    };

    app.post<{ Body: unknown }>("/api/chat/route", async (request, reply) => {
      const principal = who(request);
      if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
      const parsed = routeBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.map((one) => one.message).join("; ") });
      const { text, topicId, viewing } = parsed.data;
      const tz = safeTimeZone(parsed.data.tz);
      const store = deps.storeFor(principal);
      const at = now();

      const recent = await store.recent(4);
      const current = (topicId ? await store.get(topicId) : null) ?? recent[0] ?? null;
      // Each day starts its own topic, so the timeline reads day by day.
      const stale = current !== null && dayOf(current.lastAt, tz) !== dayOf(at, tz);
      let fresh = current === null ? ("first" as const) : stale ? ("new-day" as const) : undefined;

      const chosen = [] as Array<{ id: string; name: string }>;
      if (current && !stale) {
        chosen.push(current, ...contextTopics(recent, current.id, at));
        if (viewing && !chosen.some((one) => one.id === viewing)) {
          const jumped = await store.get(viewing);
          if (jumped) chosen.push(jumped);
        }
      } else if (viewing) {
        // Jumped back to an older topic and spoke: it may be what they continue.
        const jumped = await store.get(viewing);
        if (jumped) {
          chosen.push(jumped);
          fresh = undefined;
        }
      }
      const lines = await store.messagesOf(chosen.map((one) => one.id));
      const candidates: TopicCandidate[] = chosen.map((one) => ({
        id: one.id,
        name: one.name,
        recent: recentLines(lines, one.id),
      }));

      const decision = await decideTopic({ text, candidates, fresh, llm: deps.llm() });
      if (decision.kind === "same") {
        const name = chosen.find((one) => one.id === decision.id)?.name ?? "";
        return { topicId: decision.id, name, isNew: false };
      }
      const created = await store.create(decision.name);
      return { topicId: created.id, name: created.name, isNew: true };
    });

    app.get<{ Querystring: { tz?: string; before?: string; limit?: string } }>("/api/chat/days", async (request, reply) => {
      const principal = who(request);
      if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
      const tz = safeTimeZone(request.query.tz);
      const before = isDay(request.query.before) ? request.query.before : undefined;
      const limit = Math.max(1, Math.min(Number(request.query.limit) || 30, 120));

      const talked = await deps.storeFor(principal).days(tz, { ...(before ? { before } : {}), limit });
      const oldestTalked = talked.length === limit ? talked[talked.length - 1]!.day : null;
      const tasksByDay = new Map<string, number>();
      for (const task of await work()) {
        const day = dayOf(task.at, tz);
        if (before && day >= before) continue;
        // Past the last day of talk returned, another page will bring it.
        if (oldestTalked && day < oldestTalked) continue;
        tasksByDay.set(day, (tasksByDay.get(day) ?? 0) + 1);
      }
      const days = new Map<string, { day: string; messages: number; topics: number; tasks: number }>();
      for (const one of talked) days.set(one.day, { ...one, tasks: 0 });
      for (const [day, tasks] of tasksByDay) {
        const known = days.get(day);
        days.set(day, known ? { ...known, tasks } : { day, messages: 0, topics: 0, tasks });
      }
      const sorted = [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
      return {
        today: dayOf(now(), tz),
        days: sorted.slice(0, limit),
        more: talked.length === limit || sorted.length > limit,
      };
    });

    app.get<{ Params: { date: string }; Querystring: { tz?: string } }>("/api/chat/day/:date", async (request, reply) => {
      const principal = who(request);
      if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
      if (!isDay(request.params.date)) return reply.status(400).send({ error: "A day is written YYYY-MM-DD." });
      const tz = safeTimeZone(request.query.tz);
      const day = request.params.date;
      const topics = await deps.storeFor(principal).topicsOn(tz, day);
      const tasks = (await work())
        .filter((task) => dayOf(task.at, tz) === day)
        .sort((a, b) => a.at.localeCompare(b.at));
      return { day, topics, tasks };
    });

    app.get<{ Querystring: { tz?: string; day?: string } }>("/api/chat/messages", async (request, reply) => {
      const principal = who(request);
      if (!principal) return reply.status(401).send({ error: "Sign in to continue." });
      const tz = safeTimeZone(request.query.tz);
      if (request.query.day !== undefined && !isDay(request.query.day)) {
        return reply.status(400).send({ error: "A day is written YYYY-MM-DD." });
      }
      const today = dayOf(now(), tz);
      const day = request.query.day ?? today;
      const found = await deps.storeFor(principal).messagesOn(tz, day);
      return { day, today, ...found };
    });
  };
