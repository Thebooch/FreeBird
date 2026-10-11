import { LAYER_KEYS, LOCATION_KINDS, LOCATION_WORDS, resolveSettings, type AgentSpec, type AppointmentType, type Contact, type WeeklyHours, type WorkflowSpec } from "@freebirdai/dash-spec";
import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { useEffect, useMemo, useState } from "react";
import { api, type SchedulingOverview, type SlotPreview } from "../../../api.js";
import { navigate } from "../../../route.js";
import { Segmented, Switch } from "../controls.jsx";
import { colorVar } from "../model.js";
import { HoursEditor, SettingsEditor } from "./editors.jsx";
import { RuleBuilder } from "./RuleBuilder.jsx";
import { ColorPicker, FormRow, NumberInput, SheetSection, TextInput } from "./inputs.jsx";
import { durationWords, factLabel, newId, slugOf, typeHostsWords } from "./model.js";
import { SetupSheet } from "./SetupSheet.jsx";
import { useContactFields } from "./useContactFields.js";
import { useSetup } from "./useSetup.js";
import { itemAttrs, screenAttrs, useChatFocus } from "../../chatScreen.js";

/**
 * Appointment types: what can be booked.
 *
 * Each says how long it takes and who hosts it (people, or a pool), whether a
 * team member approves it first, how an agent offers it (a link, or a time
 * proposed in conversation), and what is asked when booking. A saved type can
 * be tried out: type in what is known about a person and see exactly the
 * times they would be offered.
 */

const WEEK_OF_NOTHING: WeeklyHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

export const TypesTab = (): JSX.Element => {
  const { setup, error, canManage, reload } = useSetup();
  const [editing, setEditing] = useState<{ readonly id: string; readonly isNew: boolean } | null>(null);
  const editingType = editing && !editing.isNew ? setup?.types.find((one) => one.id === editing.id) : undefined;
  useChatFocus("types", editingType ? { id: editingType.id, label: editingType.name } : null);

  if (error && !setup) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!setup) return <p className="dash-hint">Loading…</p>;

  return (
    <div className="dash-sched-tab" data-testid="scheduling-types" {...screenAttrs("types")}>
      <header className="dash-sched-tab__head">
        <p className="dash-sched-panel__lede">What can be booked, by whom, and on what terms.</p>
        {canManage && (
          <Button tone="primary" onClick={() => setEditing({ id: newId("type"), isNew: true })} testId="types-add">
            New appointment type
          </Button>
        )}
      </header>
      {setup.types.length === 0 ? (
        <EmptyState
          glyph="◷"
          title="No appointment types yet"
          body={setup.profiles.length === 0 ? "Set up the people who take bookings first, under People and pools." : "An appointment type says how long something takes and who hosts it."}
        />
      ) : (
        <div className="dash-sched-cards">
          {setup.types.map((type) => {
            const settings = resolveSettings([
              { layer: "workspace", settings: setup.defaults },
              { layer: "type", settings: type.settings },
            ]).settings;
            return (
              <button key={type.id} type="button" className="dash-sched-card" style={{ ["--cal-color" as string]: colorVar(type.color) }} onClick={() => setEditing({ id: type.id, isNew: false })} data-testid="types-card" {...itemAttrs(type.id)}>
                <span className="dash-sched-card__title">
                  {type.name}
                  {!type.active && <Badge>Off</Badge>}
                </span>
                <span className="dash-sched-card__meta">
                  {durationWords(settings.length)} · {typeHostsWords(type, setup.profiles, setup.pools)}
                </span>
                <span className="dash-sched-card__badges">
                  {settings.approval === "always" ? <Badge tone="warn">Needs approval</Badge> : settings.approval === "rules" ? <Badge tone="warn">Approval by rules</Badge> : <Badge tone="accent">Books straight away</Badge>}
                  <Badge>{type.offer === "link" ? "Offered as a link" : "Offered in conversation"}</Badge>
                  {type.publicLink && <Badge>Public link</Badge>}
                  {settings.consolidate && <Badge>{settings.consolidate.mode === "stack" ? "Stacks" : "Back to back"}</Badge>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {editing && (
        <TypeSheet
          setup={setup}
          id={editing.id}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={async (stay) => {
            await reload();
            if (stay) setEditing({ id: editing.id, isNew: false });
            else setEditing(null);
          }}
        />
      )}
    </div>
  );
};

/* ── one type ──────────────────────────────────────────────────────────── */

type Draft = Omit<AppointmentType, "version" | "createdAt" | "updatedAt">;

const TypeSheet = ({
  setup,
  id,
  isNew,
  onClose,
  onSaved,
}: {
  readonly setup: SchedulingOverview;
  readonly id: string;
  readonly isNew: boolean;
  readonly onClose: () => void;
  readonly onSaved: (stay: boolean) => Promise<void>;
}): JSX.Element => {
  const held = setup.types.find((one) => one.id === id);
  const fields = useContactFields();
  const [draft, setDraft] = useState<Draft>(
    held ?? {
      id,
      name: "",
      slug: "",
      description: "",
      color: 2,
      active: true,
      hosts: { members: setup.profiles.slice(0, 1).map((one) => one.member) },
      settings: { length: "60m" },
      offer: "conversation",
      linkOnRequest: true,
      publicLink: false,
      intake: [],
      eligibility: { rules: { all: [], any: [] }, whenUnknown: "exclude", message: "" },
      location: { kind: "ask" },
      maxActivePerContact: 1,
      requireVerifiedContact: false,
    },
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(held));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const inherited = resolveSettings([{ layer: "workspace", settings: setup.defaults }]);
  const byPool = "pool" in draft.hosts;

  return (
    <SetupSheet
      trail="Calendar / Appointment types"
      title={isNew ? "New appointment type" : draft.name || "Appointment type"}
      onClose={onClose}
      onSave={async () => {
        if (!draft.name.trim()) throw new Error("Give the type a name.");
        await api.putType(id, { ...draft, slug: draft.slug || slugOf(draft.name) });
        await onSaved(isNew);
      }}
      saveLabel={isNew ? "Create" : "Save"}
      {...(!isNew ? { onRemove: async () => (await api.removeType(id), await onSaved(false)) } : {})}
      wide
      testId="type-sheet"
    >
      <SheetSection title="Basics">
        <FormRow label="Name">
          {(field) => (
            <TextInput
              id={field}
              value={draft.name}
              maxLength={80}
              placeholder="Home inspection"
              onChange={(name) => setDraft((prev) => ({ ...prev, name, ...(slugTouched ? {} : { slug: slugOf(name) }) }))}
              testId="type-name"
            />
          )}
        </FormRow>
        <FormRow label="Booking page address" hint="The end of the public link's address.">
          {(field) => (
            <TextInput
              id={field}
              value={draft.slug}
              maxLength={60}
              placeholder="home-inspection"
              onChange={(slug) => {
                setSlugTouched(true);
                set("slug", slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
              }}
            />
          )}
        </FormRow>
        <FormRow label="Description" hint="Shown to the person booking.">
          {(field) => <textarea id={field} className="dash-sched-input dash-sched-textarea" value={draft.description} maxLength={2000} onChange={(event) => set("description", event.target.value)} />}
        </FormRow>
        <FormRow label="Colour">{() => <ColorPicker label="Colour" value={draft.color} onChange={(color) => set("color", color)} />}</FormRow>
        <FormRow label="Taking bookings">{() => <Switch checked={draft.active} onChange={(active) => set("active", active)} label={draft.active ? "On" : "Off"} />}</FormRow>
      </SheetSection>

      <SheetSection title="Hosted by" description="The people whose time it books, or a pool that gives it to whoever is free by its rule.">
        <FormRow label="Hosts">
          {() => (
            <Segmented
              label="Hosts"
              value={byPool ? "pool" : "members"}
              options={[
                { value: "members", label: "People" },
                { value: "pool", label: "A pool" },
              ]}
              onChange={(how) => set("hosts", how === "pool" ? { pool: setup.pools[0]?.id ?? "" } : { members: setup.profiles.slice(0, 1).map((one) => one.member) })}
            />
          )}
        </FormRow>
        {byPool ? (
          <FormRow label="Pool">
            {(field) =>
              setup.pools.length === 0 ? (
                <span className="dash-hint">No pools yet: make one under People and pools.</span>
              ) : (
                <select id={field} className="dash-sched-input" value={(draft.hosts as { pool: string }).pool} onChange={(event) => set("hosts", { pool: event.target.value })}>
                  {setup.pools.map((pool) => (
                    <option key={pool.id} value={pool.id}>
                      {pool.name}
                    </option>
                  ))}
                </select>
              )
            }
          </FormRow>
        ) : (
          <FormRow label="People">
            {() => (
              <div className="dash-sched-checks">
                {setup.profiles.map((profile) => {
                  const members = (draft.hosts as { members: string[] }).members;
                  const on = members.includes(profile.member);
                  return (
                    <Switch
                      key={profile.member}
                      checked={on}
                      onChange={(next) => set("hosts", { members: next ? [...members, profile.member] : members.filter((one) => one !== profile.member) })}
                      label={profile.displayName}
                      {...(profile.bookable ? {} : { hint: "Not taking bookings" })}
                    />
                  );
                })}
              </div>
            )}
          </FormRow>
        )}
      </SheetSection>

      <SheetSection title="Booking terms" description="Anything left as it is follows the workspace settings. A block can change some of these within its own hours.">
        <SettingsEditor
          keys={LAYER_KEYS.type.filter((key) => !["holdFor", "suggestionHoldFor", "cancelCutoff", "rescheduleCutoff", "maxReschedules", "showHostName"].includes(key))}
          value={draft.settings}
          inherited={inherited}
          fields={fields}
          onChange={(settings) => set("settings", settings)}
        />
        <FormRow label="Only at certain times" hint="Narrows the hosts' hours for this type: consultations only in the morning." wide={Boolean(draft.hours)}>
          {() => (
            <div className="dash-sched-stack">
              <Switch
                checked={Boolean(draft.hours)}
                onChange={(on) =>
                  setDraft((prev) => {
                    const { hours: _hours, ...rest } = prev;
                    return on ? { ...rest, hours: WEEK_OF_NOTHING } : rest;
                  })
                }
                label={draft.hours ? "On" : "Off"}
              />
              {draft.hours && <HoursEditor value={draft.hours} onChange={(hours) => set("hours", hours)} />}
            </div>
          )}
        </FormRow>
      </SheetSection>

      <SheetSection title="Holds and changes" description="How long a request waits for approval, and how late the person booking can still change it.">
        <SettingsEditor keys={["holdFor", "suggestionHoldFor", "cancelCutoff", "rescheduleCutoff", "maxReschedules"]} value={draft.settings} inherited={inherited} onChange={(settings) => set("settings", settings)} />
      </SheetSection>

      <SheetSection title="How it is offered">
        <FormRow label="Agents offer it" hint="In conversation, an agent proposes the next open time and works from there. As a link, it sends the booking page.">
          {() => (
            <Segmented
              label="How agents offer it"
              value={draft.offer}
              options={[
                { value: "conversation", label: "In conversation" },
                { value: "link", label: "As a link" },
              ]}
              onChange={(offer) => set("offer", offer)}
            />
          )}
        </FormRow>
        {draft.offer === "conversation" && (
          <FormRow label="Send a link when asked">{() => <Switch checked={draft.linkOnRequest} onChange={(value) => set("linkOnRequest", value)} label={draft.linkOnRequest ? "Yes" : "No"} />}</FormRow>
        )}
        <FormRow label="Public booking page" hint="A link anyone can book from, without being sent one.">
          {() => <Switch checked={draft.publicLink} onChange={(value) => set("publicLink", value)} label={draft.publicLink ? "On" : "Off"} testId="type-public" />}
        </FormRow>
        <SettingsEditor keys={["showHostName"]} value={draft.settings} inherited={inherited} onChange={(settings) => set("settings", settings)} />
        <FormRow label="Where">
          {(field) => (
            <div className="dash-sched-inline">
              <select id={field} className="dash-sched-input" value={draft.location.kind} onChange={(event) => set("location", { kind: event.target.value as Draft["location"]["kind"] })}>
                {LOCATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {LOCATION_WORDS[kind]}
                  </option>
                ))}
              </select>
              {(draft.location.kind === "fixed" || draft.location.kind === "video") && (
                <TextInput value={draft.location.value ?? ""} placeholder={draft.location.kind === "video" ? "Meeting link" : "Address"} onChange={(value) => set("location", { ...draft.location, value })} />
              )}
            </div>
          )}
        </FormRow>
        <FormRow label="Active bookings per person" hint="A person who already has this many sees their booking's status instead of new times.">
          {(field) => <NumberInput id={field} value={draft.maxActivePerContact} min={1} max={20} onChange={(value) => set("maxActivePerContact", value ?? 1)} />}
        </FormRow>
      </SheetSection>

      <SheetSection
        title="Questions when booking"
        description="Asked on the booking page and by agents, besides anything a block needs to decide who may book."
        actions={
          <Button size="sm" tone="ghost" onClick={() => set("intake", [...draft.intake, { field: "request.notes", required: false, ask: "" }])}>
            + Question
          </Button>
        }
      >
        {draft.intake.length === 0 ? (
          <p className="dash-sched-empty">No questions of its own.</p>
        ) : (
          draft.intake.map((question, index) => (
            <div key={index} className="dash-sched-question">
              <TextInput value={question.ask ?? ""} placeholder="What should we know before the visit?" onChange={(ask) => set("intake", draft.intake.map((one, at) => (at === index ? { ...one, ask } : one)))} />
              <TextInput value={question.field} placeholder="request.notes" onChange={(field) => set("intake", draft.intake.map((one, at) => (at === index ? { ...one, field: field.trim() } : one)))} />
              <Switch checked={question.required} onChange={(required) => set("intake", draft.intake.map((one, at) => (at === index ? { ...one, required } : one)))} label="Required" />
              <button type="button" className="dash-sched-rule__remove" aria-label="Remove this question" onClick={() => set("intake", draft.intake.filter((_, at) => at !== index))}>
                ✕
              </button>
            </div>
          ))
        )}
      </SheetSection>

      <SheetSection
        title="Who can book"
        description="Leave empty and anyone can. Rules read the person's contact fields and the answers to this type's questions, like party size is at most 8. The team's bookings follow it too: for cases a person should decide, use approval rules under Booking terms instead."
        testId="type-eligibility"
      >
        <RuleBuilder
          value={draft.eligibility.rules}
          fields={[
            ...draft.intake
              .filter((question) => question.field.startsWith("request.") && question.field.length > 8)
              .map((question) => ({ path: question.field, label: question.ask?.trim() || factLabel(question.field) })),
            ...fields,
          ]}
          onChange={(rules) => set("eligibility", { ...draft.eligibility, rules })}
          testId="type-rules"
        />
        <FormRow label="When an answer is not known" hint="Before they have said, or a record has been matched.">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.eligibility.whenUnknown} onChange={(event) => set("eligibility", { ...draft.eligibility, whenUnknown: event.target.value as Draft["eligibility"]["whenUnknown"] })}>
              <option value="exclude">Ask first, and offer nothing until then</option>
              <option value="include">Let them book</option>
              <option value="approval">Let them book, pending approval</option>
            </select>
          )}
        </FormRow>
        <FormRow label="What to tell people it doesn't take" hint="Shown on the booking page and said by agents. Leave empty for a plain “contact us”." wide>
          {() => (
            <TextInput
              value={draft.eligibility.message}
              placeholder="For parties of 9 or more, please call us and we'll arrange it."
              onChange={(message) => set("eligibility", { ...draft.eligibility, message })}
              testId="type-eligibility-message"
            />
          )}
        </FormRow>
        {!isNew && held ? <TurnedAwayFollowUp type={held} /> : null}
      </SheetSection>

      {!isNew && held && <TypePreview setup={setup} type={held} />}
    </SetupSheet>
  );
};

/* ── after someone is turned away ──────────────────────────────────────── */

const FOLLOW_UP_TEMPLATE = "recipe-turned-away";

/**
 * What happens besides the message: the workflows a turn-away starts, or one
 * made here from the "Follow up with people turned away" template, scoped to
 * this type and saved off until someone reviews it and turns it on.
 */
const TurnedAwayFollowUp = ({ type }: { readonly type: AppointmentType }): JSX.Element => {
  const [flows, setFlows] = useState<WorkflowSpec[] | null>(null);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [making, setMaking] = useState(false);
  const [agent, setAgent] = useState("");
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = async () => {
    const all = await api.workflows();
    setFlows(all.filter((one) => one.trigger.kind === "booking" && one.trigger.events.includes("turned_away") && (one.trigger.types.length === 0 || one.trigger.types.includes(type.id))));
  };
  useEffect(() => {
    void load().catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : String(cause)));
    void api.agents().then(
      (list) => {
        setAgents(list);
        setAgent((held) => held || list[0]?.id || "");
      },
      () => undefined,
    );
  }, [type.id]);

  const make = async () => {
    if (!agent) {
      setFailed("Pick the agent who tells them. Make one under Agents first.");
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const made = await api.workflowFromTemplate(FOLLOW_UP_TEMPLATE, { agent, ...(say.trim() ? { say: say.trim() } : {}) }, `Follow up: turned away from ${type.name}`, [type.id]);
      await load();
      setMaking(false);
      setNote(`Made “${made.name}”, switched off. Review it and turn it on under Workflows.`);
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormRow label="When someone is turned away" hint="Besides the message: a workflow can text them what to do instead, tell the team, or do anything else a workflow does." wide>
      {() => (
        <div className="dash-followups" data-testid="type-followups">
          {flows === null ? <span className="dash-hint">Loading…</span> : null}
          {flows && flows.length > 0 ? (
            <ul className="dash-followups__list">
              {flows.map((one) => (
                <li key={one.id} className="dash-followups__item">
                  <span className="dash-followups__name">{one.name}</span>
                  <Badge tone={one.enabled ? "accent" : "neutral"}>{one.enabled ? "On" : "Off"}</Badge>
                  <Button size="sm" tone="ghost" onClick={() => navigate({ kind: "agent", section: "workflows", id: one.id })}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {flows && flows.length === 0 && !making ? <span className="dash-hint">Nothing else happens yet: they only see the message.</span> : null}
          {making ? (
            <div className="dash-followups__form">
              <label className="dash-followups__field">
                <span>The agent who tells them</span>
                <select className="dash-sched-input" value={agent} onChange={(event) => setAgent(event.target.value)}>
                  {agents.length === 0 ? <option value="">No agents yet</option> : null}
                  {agents.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dash-followups__field">
                <span>What to tell them</span>
                <textarea
                  className="dash-sched-input"
                  rows={3}
                  value={say}
                  placeholder="Tell them we can't book this online, and to call us at (555) 123-4567 to arrange it."
                  onChange={(event) => setSay(event.target.value)}
                />
              </label>
              <span className="dash-hint">It texts them (or emails them, with no phone) in the agent's voice, then tells the team. Once a day per person, however often they try.</span>
              <div className="dash-sched-inline">
                <Button size="sm" tone="primary" busy={busy} onClick={() => void make()} testId="type-followup-make">
                  Make the workflow
                </Button>
                <Button size="sm" tone="ghost" onClick={() => setMaking(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" onClick={() => (setMaking(true), setNote(null))} testId="type-followup-start">
                {flows && flows.length > 0 ? "Add another follow-up" : "Set up a follow-up"}
              </Button>
            </div>
          )}
          {note ? <span className="dash-hint" role="status">{note}</span> : null}
          {failed ? (
            <span className="dash-cal-form__error" role="alert">
              {failed}
            </span>
          ) : null}
        </div>
      )}
    </FormRow>
  );
};

/* ── trying a type out ─────────────────────────────────────────────────── */

const TypePreview = ({ setup, type }: { readonly setup: SchedulingOverview; readonly type: AppointmentType }): JSX.Element => {
  const [facts, setFacts] = useState<Array<{ path: string; value: string }>>([{ path: "contact.address.postalCode", value: "" }]);
  const [mode, setMode] = useState<"facts" | "contact">("facts");
  const [contactId, setContactId] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Contact[]>([]);
  const fields = useContactFields();
  const [all, setAll] = useState(false);

  /* Contacts to try it as, searched as the name is typed. */
  useEffect(() => {
    if (mode !== "contact") return;
    const timer = setTimeout(() => void api.contacts({ ...(query.trim() ? { search: query.trim() } : {}), limit: 20 }).then((page) => setPeople(page.contacts), () => undefined), 200);
    return () => clearTimeout(timer);
  }, [mode, query]);
  const [result, setResult] = useState<SlotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const scope = useMemo(() => {
    const contact: Record<string, unknown> = {};
    const request: Record<string, unknown> = {};
    for (const { path, value } of facts) {
      if (!value.trim()) continue;
      const [root, ...rest] = path.split(".");
      if (rest.length === 0) continue;
      let at = root === "request" ? request : root === "contact" ? contact : null;
      if (!at) continue;
      for (const key of rest.slice(0, -1)) at = ((at[key] as Record<string, unknown> | undefined) ??= {}) as Record<string, unknown>;
      at[rest.at(-1)!] = value.trim();
    }
    return { contact, request };
  }, [facts]);

  useEffect(() => {
    let cancelled = false;
    if (mode === "contact" && !contactId) {
      setResult(null);
      return undefined;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .previewType(type.id, mode === "contact" ? { contactId, all } : { ...scope, all })
        .then((next) => !cancelled && (setResult(next), setError(null)))
        .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type.id, scope, all, mode, contactId]);

  const days = useMemo(() => {
    const out = new Map<string, NonNullable<typeof result>["slots"][number][]>();
    for (const slot of result?.slots ?? []) {
      const key = new Date(slot.start).toDateString();
      out.set(key, [...(out.get(key) ?? []), slot]);
    }
    return [...out.entries()].slice(0, 7);
  }, [result]);
  const name = (member: string) => setup.profiles.find((one) => one.member === member)?.displayName ?? member;

  return (
    <SheetSection title="Try it out" description="Type what is known about a person, or pick a contact, and see the next two weeks as they would. Saved changes only." testId="type-preview">
      <Segmented
        label="Try it as"
        value={mode}
        options={[
          { value: "facts", label: "Facts I type" },
          { value: "contact", label: "A contact" },
        ]}
        onChange={setMode}
      />
      {mode === "contact" ? (
        <div className="dash-sched-facts">
          <div className="dash-sched-facts__row">
            <TextInput value={query} placeholder="Find a contact by name, email or phone" onChange={setQuery} testId="preview-contact-search" />
            <select className="dash-sched-input" aria-label="Contact" value={contactId} onChange={(event) => setContactId(event.target.value)} data-testid="preview-contact">
              <option value="">{people.length === 0 ? "No contacts found" : "Pick a contact…"}</option>
              {people.map((one) => (
                <option key={one.id} value={one.id}>
                  {[one.name, one.emails[0] ?? one.phones[0]].filter(Boolean).join(" · ")}
                </option>
              ))}
            </select>
          </div>
          <div className="dash-sched-inline">
            <Switch checked={all} onChange={setAll} label="See all times" hint="Ignore 'only grouped times'" />
            {loading && <span className="dash-cal__sync" role="status" aria-label="Loading" />}
          </div>
        </div>
      ) : (
        <div className="dash-sched-facts">
          {facts.map((fact, index) => (
            <div key={index} className="dash-sched-facts__row">
              <TextInput value={fact.path} placeholder="contact.category" onChange={(path) => setFacts(facts.map((one, at) => (at === index ? { ...one, path: path.trim() } : one)))} />
              <TextInput value={fact.value} placeholder="Value" onChange={(value) => setFacts(facts.map((one, at) => (at === index ? { ...one, value } : one)))} testId="preview-value" />
              <button type="button" className="dash-sched-rule__remove" aria-label="Remove" onClick={() => setFacts(facts.filter((_, at) => at !== index))}>
                ✕
              </button>
            </div>
          ))}
          <div className="dash-sched-inline">
            <Button size="sm" tone="ghost" onClick={() => setFacts([...facts, { path: "contact.category", value: "" }])}>
              + Fact
            </Button>
            <Switch checked={all} onChange={setAll} label="See all times" hint="Ignore 'only grouped times'" />
            {loading && <span className="dash-cal__sync" role="status" aria-label="Loading" />}
          </div>
        </div>
      )}
      {error && <p className="dash-cal-form__error">{error}</p>}
      {result && (
        <div className="dash-sched-preview">
          {result.needs.length > 0 && (
            <p className="dash-cal-sheet__callout">
              {mode === "contact" ? "Not known about them yet, so these times may change" : "It would ask for"}: {result.needs.map((path) => factLabel(path, fields)).join(", ")}.
            </p>
          )}
          {result.consolidatedOnly && <p className="dash-hint">Showing only grouped times{result.more ? "; others are behind “See all times”." : "."}</p>}
          {result.notEligible ? (
            <p className="dash-cal-sheet__callout">
              Who can book doesn't take {mode === "contact" ? "this contact" : "these facts"}, so nothing is offered{type.eligibility.message ? `. They're told: “${type.eligibility.message}”` : "."}
            </p>
          ) : days.length === 0 ? (
            <p className="dash-sched-empty">No open times in the next two weeks for these facts.</p>
          ) : (
            days.map(([day, slots]) => (
              <div key={day} className="dash-sched-preview__day">
                <span className="dash-sched-preview__date">{new Date(slots[0]!.start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
                <span className="dash-sched-preview__slots">
                  {slots.slice(0, 16).map((slot) => (
                    <span
                      key={slot.start}
                      className="dash-sched-slot"
                      data-approval={slot.approval ? "true" : undefined}
                      data-consolidated={slot.consolidated ? "true" : undefined}
                      title={`${slot.options.map((one) => name(one.host) + (one.block ? ` (${setup.blocks.find((b) => b.id === one.block)?.name ?? one.block})` : "")).join(", ")}${slot.approval ? " · needs approval" : ""}${slot.consolidated ? " · grouped" : ""}`}
                    >
                      {new Date(slot.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </span>
                  ))}
                  {slots.length > 16 && <span className="dash-hint">+{slots.length - 16}</span>}
                </span>
              </div>
            ))
          )}
          <p className="dash-sched-legend">
            <span className="dash-sched-slot" data-consolidated="true">
              9:00
            </span>{" "}
            grouped with a matching appointment ·{" "}
            <span className="dash-sched-slot" data-approval="true">
              9:00
            </span>{" "}
            needs approval
          </p>
        </div>
      )}
    </SheetSection>
  );
};

