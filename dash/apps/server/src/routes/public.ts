import {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUS_WORDS,
  LOCATION_WORDS,
  durationMs,
  resolveSettings,
  type AppointmentType,
  type Booking,
  type Contact,
} from "@freebirdai/dash-spec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { icsCalendar } from "../bookings/ics.js";
import type { BookingLinks } from "../bookings/links.js";
import type { Brand } from "../bookings/notify.js";
import { BookingError, type BookingService } from "../bookings/service.js";
import { ContactError, type ContactService } from "../contacts/service.js";
import type { RateLimiter } from "../public/limits.js";
import { hashToken, tokenProblem, type PublicToken, type PublicTokenStore } from "../public/tokens.js";
import { discover } from "../scheduling/discover.js";
import { SchedulingError, type SchedulingService, type WorkspaceMember } from "../scheduling/service.js";
import type { Slot } from "../scheduling/slots.js";
import type { TaskStore } from "../workflows/store.js";

/**
 * The pages anyone may open, with no sign-in: a contact's booking page, an
 * appointment type's public link, and a member's approval page.
 *
 * What each may do comes from its token, and from nothing else:
 *
 * - **GET never changes anything.** Every action is a POST carrying the token
 *   in its path, so a mail scanner opening a link decides nothing.
 * - **They answer only about their own booking**: open start times, and the
 *   contact's own bookings. Never another booking, a host's other entries,
 *   or why a time was offered.
 * - **The approval page checks again on every answer** that the member is
 *   still in the workspace, that the step still waits on the same try it was
 *   asked on, and that the booking still waits for an answer.
 * - **Rate limits** per address and per token, and the identity hook lets
 *   only routes registered `public: true` through (`identity/public.ts`).
 *   This list pins them, and a test holds the server to it.
 */
export const PUBLIC_ROUTES = [
  "GET /api/public/:workspace/approve/:token",
  "GET /api/public/:workspace/book/:token",
  "GET /api/public/:workspace/book/:token/ics",
  "GET /api/public/:workspace/types/:slug",
  "POST /api/public/:workspace/approve/:token",
  "POST /api/public/:workspace/approve/:token/times",
  "POST /api/public/:workspace/book/:token/accept",
  "POST /api/public/:workspace/book/:token/answers",
  "POST /api/public/:workspace/book/:token/cancel",
  "POST /api/public/:workspace/book/:token/decline",
  "POST /api/public/:workspace/book/:token/request",
  "POST /api/public/:workspace/book/:token/reschedule",
  "POST /api/public/:workspace/book/:token/times",
  "POST /api/public/:workspace/types/:slug/start",
  "POST /api/workflow-hooks/:token",
  "POST /api/workflow-hooks/:workspace/:token",
] as const;

export interface PublicRouteDeps {
  /** The workspace id its paths name. */
  readonly workspace: string;
  readonly bookings: BookingService;
  readonly scheduling: SchedulingService;
  readonly contacts: ContactService;
  readonly tokens: PublicTokenStore;
  readonly links: BookingLinks;
  readonly tasks: TaskStore;
  readonly members: () => Promise<readonly WorkspaceMember[]>;
  readonly brand: () => Promise<Brand>;
  readonly limiter: RateLimiter;
  readonly now: () => number;
  /** How long a request made on the public link holds its time until the person is verified. */
  readonly unverifiedHoldFor?: string;
}

const DAY = 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const COOKIE = "fb_book";
const LIMITS = { read: 120, write: 30, perToken: 20, start: 5 } as const;

const iso = (ms: number): string => new Date(ms).toISOString();
const bodyOf = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === "object" && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {});
const str = (body: Record<string, unknown>, key: string, max = 1000): string => (typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "");
const instantOf = (value: unknown): number | null => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** Times as a person sees them: when, and whether a person must approve it. Never why. */
const publicSlot = (slot: Slot) => ({ start: iso(slot.start), end: iso(slot.end), approval: slot.approval, recommended: slot.consolidated });

const whereWords = (location: Booking["location"] | AppointmentType["location"] | undefined): string =>
  location ? `${LOCATION_WORDS[location.kind]}${location.value && location.kind !== "contact_address" ? `: ${location.value}` : ""}` : "";

const cookieOf = (request: FastifyRequest, name: string): string | null => {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const publicRoutes = (deps: PublicRouteDeps) =>
  async (app: FastifyInstance): Promise<void> => {
    const { bookings, scheduling, contacts, tokens, links, now } = deps;
    const open = { config: { public: true } } as const;

    /* Rate limits: so many a minute from one address, fewer for changes, and so many on one token. */
    app.addHook("onRequest", async (request, reply) => {
      const post = request.method === "POST";
      const limited = (key: string, limit: number, windowMs?: number) => !deps.limiter.take(key, limit, windowMs);
      const token = (request.params as { token?: string } | undefined)?.token;
      if (
        limited(`${post ? "write" : "read"}:${request.ip}`, post ? LIMITS.write : LIMITS.read) ||
        (post && token && limited(`token:${hashToken(token)}`, LIMITS.perToken)) ||
        (post && request.url.endsWith("/start") && limited(`start:${request.ip}`, LIMITS.start, 10 * 60_000))
      ) {
        return reply.status(429).header("Retry-After", "60").send({ error: "Too many requests. Wait a minute, then try again." });
      }
      if ((request.params as { workspace?: string } | undefined)?.workspace !== deps.workspace) return reply.status(404).send({ error: "Not found." });
      return undefined;
    });

    const fail = (reply: FastifyReply, error: unknown) => {
      if (error instanceof PublicError) return reply.status(error.status).send({ error: error.message });
      if (error instanceof BookingError) return reply.status(error.status).send({ error: error.message, ...(error.slots ? { slots: error.slots.map(publicSlot) } : {}) });
      if (error instanceof ContactError || error instanceof SchedulingError) return reply.status(error.status).send({ error: error.message });
      throw error;
    };

    const tokenOf = async (raw: string): Promise<PublicToken | null> => (TOKEN.test(raw) ? tokens.byHash(hashToken(raw)) : null);

    const settingsOf = async (type: AppointmentType) => {
      const { defaults } = await scheduling.overview();
      return resolveSettings([
        { layer: "workspace", settings: defaults },
        { layer: "type", settings: type.settings },
      ]).settings;
    };

    const hostName = async (member: string): Promise<string> => {
      const profile = await scheduling.findProfile(member);
      if (profile?.displayName) return profile.displayName;
      const email = (await deps.members()).find((one) => one.userId === member)?.email ?? "";
      const local = email.split("@")[0] ?? "";
      return local ? local.charAt(0).toUpperCase() + local.slice(1) : "A team member";
    };

    /** A pool whose people the customer picks between: its active members, by name. */
    const pickableHosts = async (type: AppointmentType) => {
      if (!("pool" in type.hosts)) return [];
      const pool = await scheduling.findPool(type.hosts.pool);
      if (!pool || pool.assign !== "customer_picks") return [];
      return Promise.all(pool.members.filter((one) => one.active).map(async (one) => ({ id: one.member, name: await hostName(one.member) })));
    };

    const publicType = async (type: AppointmentType) => {
      const settings = await settingsOf(type);
      return {
        id: type.id,
        slug: type.slug,
        name: type.name,
        description: type.description,
        minutes: Math.round((durationMs(settings.length) ?? 1_800_000) / 60_000),
        location: { kind: type.location.kind, words: whereWords(type.location) },
        approval: settings.approval !== "none",
        showHostName: settings.showHostName,
        hosts: await pickableHosts(type),
      };
    };

    /* ── a contact's booking page ──────────────────────────────────────── */

    /** The bookings this link may show and change: the contact's own, and on a public link only those made through it. */
    const bookingsOf = async (token: PublicToken): Promise<Booking[]> => {
      const all = await bookings.list({ contact: token.contact!, limit: 200 });
      return all.filter((one) => (!token.fromPublic || one.link === token.id) && (!token.type || one.type.id === token.type));
    };

    const isActive = (booking: Booking) => (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(booking.status);

    const publicBooking = async (booking: Booking) => {
      const at = now();
      const start = Date.parse(booking.start);
      const show = booking.settings.showHostName;
      const insideCancel = booking.status === "confirmed" && start - at < (durationMs(booking.settings.cancelCutoff) ?? 0);
      const insideMove = booking.status === "confirmed" && (start - at < (durationMs(booking.settings.rescheduleCutoff) ?? 0) || booking.reschedules >= booking.settings.maxReschedules);
      return {
        id: booking.id,
        status: booking.status,
        statusWords: BOOKING_STATUS_WORDS[booking.status],
        type: booking.type.name,
        start: booking.start,
        end: booking.end,
        timezone: booking.timezone,
        ...(show ? { host: await hostName(booking.host) } : {}),
        where: whereWords(booking.location),
        ...(booking.status === "pending" && booking.holdUntil ? { holdUntil: booking.holdUntil } : {}),
        ...(booking.status === "suggested"
          ? { suggestions: await Promise.all((booking.suggestions ?? []).map(async (one) => ({ id: one.id, start: one.start, end: one.end, holdUntil: one.holdUntil, ...(show ? { host: await hostName(one.host) } : {}) }))) }
          : {}),
        ...(booking.change ? { change: { start: booking.change.start, end: booking.change.end } } : {}),
        /* The team's words for them; never the team's own reason. */
        ...(booking.decision?.message ? { message: booking.decision.message } : {}),
        canCancel: isActive(booking) && !insideCancel,
        canReschedule: (booking.status === "pending" || booking.status === "confirmed") && !insideMove && !booking.change,
        insideCutoff: insideCancel || insideMove,
      };
    };

    const bookableTypes = async (): Promise<AppointmentType[]> => (await scheduling.overview()).types.filter((one) => one.active && (one.publicLink || one.offer === "link"));

    const linkState = async (token: PublicToken, contact: Contact) => {
      const mine = await bookingsOf(token);
      const active = mine.filter(isActive).sort((a, b) => a.start.localeCompare(b.start));
      const shown =
        active[0] ??
        mine.find((one) => one.id === token.booking) ??
        mine.filter((one) => one.link === token.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
        null;
      const typeKey = token.type ?? shown?.type.id;
      const type = typeKey ? await scheduling.findType(typeKey) : null;
      const brand = await deps.brand();
      return {
        workspace: { name: brand.name, accent: brand.accent },
        contact: { name: contact.name, timezone: contact.timezone ?? null },
        type: type ? await publicType(type) : null,
        types: type ? [] : await Promise.all((await bookableTypes()).map(publicType)),
        booking: shown ? await publicBooking(shown) : null,
        canBook: type ? type.active && active.length < type.maxActivePerContact : true,
      };
    };

    /** The token and contact a booking page's request is for, or why it can't go on. */
    const resolveLink = async (raw: string) => {
      const token = await tokenOf(raw);
      const contact = token?.contact ? await contacts.get(token.contact) : null;
      const activeBooking = token && contact ? (await bookingsOf(token)).some(isActive) : false;
      const problem = tokenProblem(token, "booking_link", now(), { activeBooking });
      if (problem || !token || !contact) throw new PublicError(problem ?? "This link isn't valid.", 404);
      return { token, contact };
    };

    /** The type a request is about: the link's own, else one the person picked that may be booked by link. */
    const typeFor = async (token: PublicToken, asked: string): Promise<AppointmentType> => {
      const key = token.type ?? asked;
      const type = key ? await scheduling.findType(key) : null;
      if (!type || !type.active) throw new PublicError("That isn't something you can book here.", 404);
      if (!token.type && !(type.publicLink || type.offer === "link")) throw new PublicError("That isn't something you can book here.", 404);
      return type;
    };

    /** A booking this link may change. */
    const ownBooking = async (token: PublicToken, id: string): Promise<Booking> => {
      const booking = (await bookingsOf(token)).find((one) => one.id === id);
      if (!booking) throw new PublicError("There is no such booking on this link.", 404);
      return booking;
    };

    const requestAnswers = (body: Record<string, unknown>): Record<string, string> => {
      const given = body["request"] && typeof body["request"] === "object" ? (body["request"] as Record<string, unknown>) : {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(given).slice(0, 20)) {
        const name = key.replace(/^request\./, "");
        if (/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(name) && typeof value === "string" && value.trim()) out[name] = value.trim().slice(0, 500);
      }
      return out;
    };

    type Params = { workspace: string; token: string };
    const as = (contact: Contact) => ({ kind: "contact" as const, id: contact.id });

    app.get<{ Params: Params }>("/api/public/:workspace/book/:token", open, async (request, reply) => {
      try {
        const { token, contact } = await resolveLink(request.params.token);
        return await linkState(token, contact);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /* Open times, and the questions whose answers would change them. Reads only. */
    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/times", open, async (request, reply) => {
      try {
        const { token, contact } = await resolveLink(request.params.token);
        const body = bodyOf(request);
        const type = await typeFor(token, str(body, "type", 80));
        const from = Math.max(instantOf(body["from"]) ?? now(), now());
        const to = Math.min(instantOf(body["to"]) ?? from + 14 * DAY, from + 62 * DAY);
        if (to <= from) throw new PublicError("Say a range of days to look in.");
        const host = str(body, "host", 120) || token.host;
        if (host && !(await pickableHosts(type)).some((one) => one.id === host) && host !== token.host) throw new PublicError("That person can't be picked here.");
        const answers = requestAnswers(body);
        const found = await discover({ scheduling, contacts }, { type, contact: contact.id, request: answers, range: { from, to, all: body["all"] === true, limit: 400 }, ...(host ? { hosts: [host] } : {}) });
        const held = await contacts.get(contact.id);
        const intake = type.intake
          .filter((one) => (one.field.startsWith("request.") ? !answers[one.field.slice(8)] : !held?.fields[one.field.split(".")[1] ?? ""]))
          .map((one) => ({ field: one.field, question: one.ask ?? found.needs.find((need) => need.field === one.field)?.question ?? `What is the ${one.field.split(".").pop()}?`, kind: "text", required: one.required }));
        const questions = [...found.needs.map((need) => ({ ...need, required: true })), ...intake.filter((one) => !found.needs.some((need) => need.field === one.field))];
        return { slots: found.result.slots.map(publicSlot), questions, consolidatedOnly: found.result.consolidatedOnly, more: found.result.more };
      } catch (error) {
        return fail(reply, error);
      }
    });

    /*
     * Answers to those questions. Their own details go on the contact, as
     * they said them (rules that want a record's value still won't trust
     * them). On a public link, where anyone could have typed the email, only
     * details nobody has given yet are kept.
     */
    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/answers", open, async (request, reply) => {
      try {
        const { token, contact } = await resolveLink(request.params.token);
        const given = bodyOf(request)["answers"];
        const answers = given && typeof given === "object" ? Object.entries(given as Record<string, unknown>).slice(0, 20) : [];
        const problems: Record<string, string> = {};
        for (const [field, value] of answers) {
          if (!field.startsWith("contact.")) continue;
          const key = field.split(".")[1] ?? "";
          if (token.fromPublic && contact.fields[key]) continue;
          try {
            await contacts.record(contact.id, key, value, "person");
          } catch (error) {
            if (error instanceof ContactError) problems[field] = error.message;
            else throw error;
          }
        }
        return { problems };
      } catch (error) {
        return fail(reply, error);
      }
    });

    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/request", open, async (request, reply) => {
      try {
        const { token, contact } = await resolveLink(request.params.token);
        const body = bodyOf(request);
        const type = await typeFor(token, str(body, "type", 80));
        const start = instantOf(body["start"]);
        if (start === null) throw new PublicError("Pick a time.");
        const host = str(body, "host", 120) || token.host;
        if (host && host !== token.host && !(await pickableHosts(type)).some((one) => one.id === host)) throw new PublicError("That person can't be picked here.");
        const notes = str(body, "notes", 1000);
        const where = str(body, "where", 300);
        const timezone = str(body, "timezone", 64);
        const verified = Boolean(contact.verified.email || contact.verified.phone);
        await bookings.request({
          type: type.id,
          contact: contact.id,
          start,
          ...(host ? { host } : {}),
          answers: { ...requestAnswers(body), ...(notes ? { notes } : {}), ...(where ? { where } : {}) },
          origin: token.fromPublic ? "public_link" : "link",
          by: as(contact),
          link: token.id,
          ...(token.subject ? { subject: token.subject } : {}),
          ...(token.fromPublic && !verified ? { holdFor: deps.unverifiedHoldFor ?? "4h" } : {}),
          ...(timezone && isZone(timezone) ? { timezone } : {}),
        });
        return await linkState(token, contact);
      } catch (error) {
        return fail(reply, error);
      }
    });

    const change =
      (run: (token: PublicToken, contact: Contact, booking: Booking, body: Record<string, unknown>) => Promise<unknown>) =>
      async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
        try {
          const { token, contact } = await resolveLink(request.params.token);
          const body = bodyOf(request);
          const booking = await ownBooking(token, str(body, "booking", 120));
          await run(token, contact, booking, body);
          return await linkState(token, contact);
        } catch (error) {
          return fail(reply, error);
        }
      };

    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/cancel", open, change((_token, contact, booking) => bookings.cancel(booking.id, as(contact))));
    app.post<{ Params: Params }>(
      "/api/public/:workspace/book/:token/reschedule",
      open,
      change(async (_token, contact, booking, body) => {
        const start = instantOf(body["start"]);
        if (start === null) throw new PublicError("Pick a time.");
        const host = str(body, "host", 120);
        return bookings.move(booking.id, as(contact), { start, ...(host ? { host } : {}) });
      }),
    );
    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/accept", open, change((_token, contact, booking, body) => bookings.acceptSuggestion(booking.id, str(body, "suggestion", 40), as(contact))));
    app.post<{ Params: Params }>("/api/public/:workspace/book/:token/decline", open, change((_token, contact, booking) => bookings.declineSuggestions(booking.id, as(contact))));

    /* "Add to calendar": the booking this page shows, while it is held or confirmed. */
    app.get<{ Params: Params }>("/api/public/:workspace/book/:token/ics", open, async (request, reply) => {
      try {
        const { token } = await resolveLink(request.params.token);
        const shown = (await bookingsOf(token)).filter((one) => one.status === "confirmed" || one.status === "pending").sort((a, b) => a.start.localeCompare(b.start))[0];
        if (!shown) throw new PublicError("There is nothing booked to add.", 404);
        const brand = await deps.brand();
        const host = shown.settings.showHostName ? await hostName(shown.host) : "";
        const body = icsCalendar(
          [
            {
              uid: `${shown.id}@freebird.dash`,
              start: shown.start,
              end: shown.end,
              summary: `${shown.type.name}${host ? ` with ${host}` : ""}`,
              description: `${brand.name}. ${BOOKING_STATUS_WORDS[shown.status]}.`,
              ...(shown.location?.value && shown.location.kind !== "contact_address" ? { location: shown.location.value } : {}),
              status: shown.status === "pending" ? "TENTATIVE" : "CONFIRMED",
              sequence: shown.revision,
              updatedAt: shown.updatedAt,
            },
          ],
          { now: now(), name: brand.name },
        );
        return reply.header("Content-Type", "text/calendar; charset=utf-8").header("Content-Disposition", 'attachment; filename="booking.ics"').send(body);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /* ── an appointment type's public link ─────────────────────────────── */

    type TypeParams = { workspace: string; slug: string };
    const publicLinkType = async (slug: string): Promise<AppointmentType> => {
      const type = /^[a-z0-9-]{1,60}$/.test(slug) ? await scheduling.findType(slug) : null;
      if (!type || !type.active || !type.publicLink || type.slug !== slug) throw new PublicError("There is no booking page here.", 404);
      return type;
    };
    const cookiePath = (slug: string) => `/api/public/${encodeURIComponent(deps.workspace)}/types/${slug}`;

    /* The type, and — when this browser already started — the personal page to go to instead. */
    app.get<{ Params: TypeParams }>("/api/public/:workspace/types/:slug", open, async (request, reply) => {
      try {
        const type = await publicLinkType(request.params.slug);
        const brand = await deps.brand();
        const held = cookieOf(request, COOKIE);
        let personal: string | undefined;
        if (held) {
          const token = await tokenOf(held);
          if (token && token.type === type.id && !tokenProblem(token, "booking_link", now(), { activeBooking: true })) personal = `/p/${encodeURIComponent(deps.workspace)}/book/${held}`;
        }
        return {
          workspace: { name: brand.name, accent: brand.accent },
          type: await publicType(type),
          /* Until Comms can check an email, a type that needs a checked contact can't open publicly. */
          open: !type.requireVerifiedContact,
          ...(personal ? { personal } : {}),
        };
      } catch (error) {
        return fail(reply, error);
      }
    });

    /* Who they are, in; their own page, out. The page then lives at the personal link. */
    app.post<{ Params: TypeParams }>("/api/public/:workspace/types/:slug/start", open, async (request, reply) => {
      try {
        const type = await publicLinkType(request.params.slug);
        if (type.requireVerifiedContact) throw new PublicError("This booking page isn't open yet.", 409);
        const body = bodyOf(request);
        /* The field people never see: anything in it was filled by a script. */
        if (str(body, "website")) throw new PublicError("That couldn't be sent. Reload the page and try again.");
        const name = str(body, "name", 120);
        const email = str(body, "email", 200);
        const phone = str(body, "phone", 40);
        if (!name) throw new PublicError("Say your name.");
        if (!email) throw new PublicError("Say your email address.");
        const contact = await contacts.findOrCreate({ name, email, ...(phone ? { phone } : {}), origin: "public_link", unverified: true });
        const minted = await links.contactLink(contact.id, { type: type.id, fromPublic: true });
        const secure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
        reply.header(
          "Set-Cookie",
          `${COOKIE}=${encodeURIComponent(minted.raw)}; Path=${cookiePath(type.slug)}; Max-Age=${30 * 86_400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
        );
        return { page: minted.path };
      } catch (error) {
        return fail(reply, error);
      }
    });

    /* ── a member's approval page ──────────────────────────────────────── */

    const resolveApproval = async (raw: string, answering: boolean) => {
      const token = await tokenOf(raw);
      const problem = tokenProblem(token, "approval", now(), { answering });
      if (!token || problem === "This link isn't valid." || !token.booking || !token.member || !token.task) throw new PublicError("This link isn't valid.", 404);
      if (problem) throw new PublicError(problem, 409);
      const booking = await bookings.get(token.booking).catch(() => null);
      if (!booking) throw new PublicError("This booking no longer exists.", 404);
      return { token, booking };
    };

    /** Why this member can't answer now, or null when they can. */
    const answerProblem = async (token: PublicToken, booking: Booking): Promise<string | null> => {
      if (!(await deps.members()).some((one) => one.userId === token.member)) return "You are no longer on this team.";
      const task = await deps.tasks.get(token.task!);
      if (!task || task.status !== "waiting" || task.body.kind !== "booking" || task.body.booking !== booking.id) return "This request has already been answered.";
      if (token.attempt && task.attempt && task.attempt !== token.attempt) return "This request was asked again; use the newer link.";
      if (!(booking.status === "pending" || (booking.status === "confirmed" && booking.change))) return "This request has already been answered.";
      return null;
    };

    const approvalState = async (token: PublicToken, booking: Booking, answered: string | null = null) => {
      const brand = await deps.brand();
      const member = await links.memberOf(token.member!, booking.timezone);
      const zone = member?.timezone ?? booking.timezone;
      const contact = await contacts.get(booking.contact);
      const task = await deps.tasks.get(token.task!);
      const body = task?.body.kind === "booking" ? task.body : null;
      const problem = answered ?? tokenProblem(token, "approval", now(), { answering: true }) ?? (await answerProblem(token, booking));
      const decidedBy = booking.decision?.by;
      const type = await scheduling.findType(booking.type.id);
      return {
        workspace: { name: brand.name, accent: brand.accent },
        member: { name: member?.name ?? "A team member", email: member?.email ?? "", timezone: zone },
        booking: {
          id: booking.id,
          type: booking.type.name,
          description: type?.description ?? "",
          start: booking.start,
          end: booking.end,
          status: booking.status,
          statusWords: BOOKING_STATUS_WORDS[booking.status],
          where: whereWords(booking.location),
          ...(booking.holdUntil ? { holdUntil: booking.holdUntil } : {}),
          ...(booking.change ? { change: { start: booking.change.start, end: booking.change.end } } : {}),
          contact: { name: contact?.name || contact?.emails[0] || "Someone", email: contact?.emails[0] ?? "", phone: contact?.phones[0] ?? "" },
          notes: Object.entries(booking.answers)
            .filter(([, value]) => typeof value === "string" && value.trim())
            .map(([key, value]) => ({ label: key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (one) => one.toUpperCase()), value: String(value) })),
          facts: await links.factLines(booking),
          ...(booking.status === "suggested" ? { suggestions: (booking.suggestions ?? []).map((one) => ({ start: one.start, end: one.end })) } : {}),
        },
        ask: body ? { question: body.question, allowSuggest: body.allowSuggest, allowDeny: body.allowDeny, maxSuggestions: body.maxSuggestions } : null,
        open: problem === null,
        ...(problem ? { closed: problem } : {}),
        ...(booking.decision
          ? {
              decided: {
                outcome: booking.decision.outcome,
                by: decidedBy ? (decidedBy === token.member ? "You" : await hostName(decidedBy)) : "Someone",
                at: booking.decision.at,
                ...(booking.decision.message ? { message: booking.decision.message } : {}),
              },
            }
          : {}),
        day: member ? await links.dayAround(member.id, zone, booking) : [],
      };
    };

    type ApproveParams = { workspace: string; token: string };

    /* Opening it never acts: it shows the request, and who is answering. */
    app.get<{ Params: ApproveParams }>("/api/public/:workspace/approve/:token", open, async (request, reply) => {
      try {
        const { token, booking } = await resolveApproval(request.params.token, false);
        return await approvalState(token, booking);
      } catch (error) {
        return fail(reply, error);
      }
    });

    /** The host a member's suggestions are for: themselves when they host this type, else the booking's host. */
    const suggestHost = async (member: string, booking: Booking): Promise<string> => {
      const type = await scheduling.findType(booking.type.id);
      if (!type) return booking.host;
      if ("members" in type.hosts) return type.hosts.members.includes(member) ? member : booking.host;
      const pool = await scheduling.findPool(type.hosts.pool);
      return pool?.members.some((one) => one.member === member && one.active) ? member : booking.host;
    };

    /* Their own open times for this type, to offer instead. Reads only. */
    app.post<{ Params: ApproveParams }>("/api/public/:workspace/approve/:token/times", open, async (request, reply) => {
      try {
        const { token, booking } = await resolveApproval(request.params.token, true);
        const problem = await answerProblem(token, booking);
        if (problem) throw new PublicError(problem, 409);
        const body = bodyOf(request);
        const from = Math.max(instantOf(body["from"]) ?? now(), now());
        const to = Math.min(instantOf(body["to"]) ?? from + 14 * DAY, from + 62 * DAY);
        const host = await suggestHost(token.member!, booking);
        const type = await scheduling.findType(booking.type.id);
        if (!type) throw new PublicError("This appointment type no longer exists.", 404);
        const facts = await bookings.factsFor(booking.contact, type, booking.answers);
        const found = await scheduling.slots(type, facts, { from, to, all: true, limit: 400 }, { hosts: [host] });
        return { host: { name: await hostName(host), self: host === token.member }, slots: found.slots.map(publicSlot) };
      } catch (error) {
        return fail(reply, error);
      }
    });

    /* The answer: checked again, applied to the booking, and the link spent. */
    app.post<{ Params: ApproveParams }>("/api/public/:workspace/approve/:token", open, async (request, reply) => {
      try {
        const { token, booking } = await resolveApproval(request.params.token, true);
        const problem = await answerProblem(token, booking);
        if (problem) throw new PublicError(problem, 409);
        const task = (await deps.tasks.get(token.task!))!;
        const ask = task.body.kind === "booking" ? task.body : null;
        const body = bodyOf(request);
        const answer = str(body, "answer", 20);
        const message = str(body, "message", 1000);
        const reason = str(body, "reason", 1000);
        const by = { kind: "member" as const, id: token.member! };
        /*
         * Each answer acts only on a booking still waiting for one, inside the
         * booking's own lock: of two answers at once, the second is refused.
         */
        if (answer === "approve") await bookings.confirm(booking.id, by, message ? { message } : {});
        else if (answer === "deny") {
          if (ask && !ask.allowDeny) throw new PublicError("This request can't be denied here.");
          await bookings.deny(booking.id, by, { ...(reason ? { reason } : {}), ...(message ? { message } : {}) });
        } else if (answer === "suggest") {
          if (ask && !ask.allowSuggest) throw new PublicError("Other times can't be offered here.");
          const given = Array.isArray(body["times"]) ? (body["times"] as unknown[]) : [];
          const times = given.map((one) => instantOf(one && typeof one === "object" ? (one as Record<string, unknown>)["start"] : one)).filter((one): one is number => one !== null);
          if (times.length === 0) throw new PublicError("Pick at least one time to offer.");
          if (times.length > (ask?.maxSuggestions ?? 3)) throw new PublicError(`Offer at most ${ask?.maxSuggestions ?? 3} times.`);
          const host = await suggestHost(token.member!, booking);
          await bookings.suggest(
            booking.id,
            by,
            times.map((start) => ({ start, host })),
            { ...(message ? { message } : {}), ...(reason ? { reason } : {}), allowOutside: body["allowOutside"] === true, onlyFrom: ["pending"] },
          );
        } else throw new PublicError("Choose approve, suggest or deny.");
        /* Spent, with what the page could tell about who used it. */
        const spent: PublicToken = {
          ...token,
          usedAt: iso(now()),
          usedBy: { ...(request.ip ? { ip: request.ip } : {}), ...(request.headers["user-agent"] ? { userAgent: String(request.headers["user-agent"]).slice(0, 300) } : {}) },
        };
        await tokens.put(spent);
        return await approvalState(spent, await bookings.get(booking.id), "You answered this request.");
      } catch (error) {
        return fail(reply, error);
      }
    });
  };

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
