import { BLOCK_KIND_WORDS, LAYER_KEYS, resolveSettings, type Block, type Placement, type Recurrence } from "@freebirdai/dash-spec";
import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { useState } from "react";
import { api, type SchedulingOverview } from "../../../api.js";
import { Segmented, Switch } from "../controls.jsx";
import { colorVar } from "../model.js";
import { SettingsEditor } from "./editors.jsx";
import { ColorPicker, FormRow, NumberInput, SheetSection, TextInput, TimeZoneSelect } from "./inputs.jsx";
import { blockSummary, browserZone, newId, placementWords, todayIn } from "./model.js";
import { RuleBuilder } from "./RuleBuilder.jsx";
import { SetupSheet } from "./SetupSheet.jsx";
import { useContactFields } from "./useContactFields.js";
import { useSetup } from "./useSetup.js";

/**
 * Blocks: named sets of rules and settings, placed on calendars.
 *
 * A **set** block takes only people its rules match ("ZIP codes starting 787",
 * "existing customers"). A **blank** block takes its rules from its first
 * booking: it becomes, for that occurrence, the set block the booking belongs
 * to. A **closed** block is busy time. Each is placed on a person's or a
 * pool's calendar for a time range, once or repeating.
 */

export const BlocksTab = (): JSX.Element => {
  const { setup, error, canManage, reload } = useSetup();
  const [editing, setEditing] = useState<{ readonly id: string; readonly isNew: boolean } | null>(null);
  const [placing, setPlacing] = useState<{ readonly id: string; readonly block: string; readonly isNew: boolean } | null>(null);

  if (error && !setup) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!setup) return <p className="dash-hint">Loading…</p>;

  const targetName = (placement: Placement) =>
    placement.target.kind === "pool"
      ? `Pool: ${setup.pools.find((one) => one.id === placement.target.id)?.name ?? placement.target.id}`
      : (setup.profiles.find((one) => one.member === placement.target.id)?.displayName ?? placement.target.id);

  return (
    <div className="dash-sched-tab" data-testid="scheduling-blocks">
      <header className="dash-sched-tab__head">
        <p className="dash-sched-panel__lede">Rules for who can book, placed on calendars once or repeating. Blocks are never a preference: people they do not match cannot book in them.</p>
        {canManage && (
          <Button tone="primary" onClick={() => setEditing({ id: newId("block"), isNew: true })} testId="blocks-add">
            New block
          </Button>
        )}
      </header>
      {setup.blocks.length === 0 ? (
        <EmptyState glyph="▤" title="No blocks yet" body="A block says who may book in it: addresses, contact categories, any field. Place it on a calendar to apply it." />
      ) : (
        <div className="dash-sched-blocks">
          {setup.blocks.map((block) => {
            const placements = setup.placements.filter((one) => one.block === block.id);
            return (
              <article key={block.id} className="dash-sched-block" data-kind={block.kind} style={{ ["--cal-color" as string]: colorVar(block.color) }} data-testid="blocks-card">
                <button type="button" className="dash-sched-block__head" onClick={() => setEditing({ id: block.id, isNew: false })}>
                  <span className="dash-sched-block__name">{block.name}</span>
                  <Badge tone={block.kind === "closed" ? "neutral" : block.kind === "blank" ? "warn" : "accent"}>{BLOCK_KIND_WORDS[block.kind].label}</Badge>
                  <span className="dash-sched-block__summary">{blockSummary(block, setup.blocks)}</span>
                </button>
                <ul className="dash-sched-block__placements">
                  {placements.length === 0 && <li className="dash-hint">Not placed on any calendar.</li>}
                  {placements.map((placement) => (
                    <li key={placement.id}>
                      <button type="button" className="dash-sched-placement" onClick={() => setPlacing({ id: placement.id, block: block.id, isNew: false })} data-testid="placement-row">
                        <span className="dash-sched-placement__who">{targetName(placement)}</span>
                        <span className="dash-sched-placement__when">{placementWords(placement)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {canManage && (
                  <div className="dash-sched-block__foot">
                    <Button size="sm" onClick={() => setPlacing({ id: newId("place"), block: block.id, isNew: true })} testId="blocks-place">
                      Place on a calendar
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {editing && (
        <BlockSheet
          setup={setup}
          id={editing.id}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reload();
            setEditing(null);
          }}
        />
      )}
      {placing && (
        <PlacementSheet
          setup={setup}
          id={placing.id}
          block={placing.block}
          isNew={placing.isNew}
          onClose={() => setPlacing(null)}
          onSaved={async () => {
            await reload();
            setPlacing(null);
          }}
        />
      )}
    </div>
  );
};

/* ── a block ───────────────────────────────────────────────────────────── */

type BlockDraft = Omit<Block, "version" | "createdAt" | "updatedAt">;

const BlockSheet = ({
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
  readonly onSaved: () => Promise<void>;
}): JSX.Element => {
  const held = setup.blocks.find((one) => one.id === id);
  const fields = useContactFields();
  const [draft, setDraft] = useState<BlockDraft>(held ?? { id, name: "", color: 3, description: "", kind: "set", rules: { all: [], any: [] }, becomes: [], whenUnknown: "exclude", settings: {} });
  const set = <K extends keyof BlockDraft>(key: K, value: BlockDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setBlocks = setup.blocks.filter((one) => one.kind === "set" && one.id !== id);
  const inherited = resolveSettings([{ layer: "workspace", settings: setup.defaults }]);

  return (
    <SetupSheet
      trail="Calendar / Blocks"
      title={isNew ? "New block" : draft.name || "Block"}
      onClose={onClose}
      onSave={async () => {
        if (!draft.name.trim()) throw new Error("Give the block a name.");
        await api.putBlock(id, draft);
        await onSaved();
      }}
      {...(!isNew ? { onRemove: async () => (await api.removeBlock(id), await onSaved()) } : {})}
      wide
      testId="block-sheet"
    >
      <SheetSection title="Block">
        <FormRow label="Name">{(field) => <TextInput id={field} value={draft.name} maxLength={80} placeholder="North side visits" onChange={(name) => set("name", name)} testId="block-name" />}</FormRow>
        <FormRow label="Colour" hint="Its band on the week view.">
          {() => <ColorPicker label="Colour" value={draft.color} onChange={(color) => set("color", color)} />}
        </FormRow>
        <FormRow label="Kind" hint={BLOCK_KIND_WORDS[draft.kind].does}>
          {() => (
            <Segmented
              label="Kind"
              value={draft.kind}
              options={[
                { value: "set", label: "Set" },
                { value: "blank", label: "Blank", hint: setBlocks.length === 0 ? "Make a set block first" : BLOCK_KIND_WORDS.blank.does },
                { value: "closed", label: "Closed" },
              ]}
              onChange={(kind) => set("kind", kind)}
              testId="block-kind"
            />
          )}
        </FormRow>
        <FormRow label="Notes">{(field) => <TextInput id={field} value={draft.description} maxLength={1000} placeholder="What this block is for" onChange={(value) => set("description", value)} />}</FormRow>
      </SheetSection>

      {draft.kind === "set" && (
        <SheetSection title="Who may book here" description="Leave empty and anyone may. Fields come from the person's contact record, filled in from a matched record in your connections, from what they told us, or by a team member.">
          <RuleBuilder value={draft.rules} fields={fields} onChange={(rules) => set("rules", rules)} testId="block-rules" />
          <FormRow label="When a field is not known" hint="Before the person has said, or a record has been matched.">
            {(field) => (
              <select id={field} className="dash-sched-input" value={draft.whenUnknown} onChange={(event) => set("whenUnknown", event.target.value as BlockDraft["whenUnknown"])}>
                <option value="exclude">Leave them out (ask first)</option>
                <option value="include">Let them book</option>
                <option value="approval">Let them book, pending approval</option>
              </select>
            )}
          </FormRow>
        </SheetSection>
      )}

      {draft.kind === "blank" && (
        <SheetSection title="What it can become" description="Each time it comes round, its first booking turns it into the first of these that booking matches. Then only people that block takes can book the rest of it. It goes back to blank if that booking is cancelled.">
          {setBlocks.length === 0 ? (
            <p className="dash-sched-empty">Make a set block first: a blank block becomes one.</p>
          ) : (
            <ol className="dash-sched-order">
              {draft.becomes.map((into, index) => (
                <li key={into} className="dash-sched-order__row">
                  <span className="dash-sched-order__n">{index + 1}</span>
                  <span className="dash-sched-swatch" style={{ ["--cal-color" as string]: colorVar(setBlocks.find((one) => one.id === into)?.color ?? 1) }} aria-hidden="true" />
                  <span className="dash-sched-order__name">{setBlocks.find((one) => one.id === into)?.name ?? into}</span>
                  <button type="button" className="dash-sched-link" disabled={index === 0} onClick={() => set("becomes", draft.becomes.map((one, at) => (at === index - 1 ? into : at === index ? draft.becomes[index - 1]! : one)))}>
                    Up
                  </button>
                  <button type="button" className="dash-sched-rule__remove" aria-label="Remove" onClick={() => set("becomes", draft.becomes.filter((one) => one !== into))}>
                    ✕
                  </button>
                </li>
              ))}
              <li className="dash-sched-order__add">
                <select className="dash-sched-input" value="" onChange={(event) => event.target.value && set("becomes", [...draft.becomes, event.target.value])} data-testid="block-becomes">
                  <option value="">Add a block it can become…</option>
                  {setBlocks
                    .filter((one) => !draft.becomes.includes(one.id))
                    .map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.name}
                      </option>
                    ))}
                </select>
              </li>
            </ol>
          )}
        </SheetSection>
      )}

      {draft.kind !== "closed" && (
        <SheetSection title="Inside this block" description="Where it differs from the rest of the calendar. For a blank block, the block it becomes decides these.">
          <FormRow label="Appointment types" hint="Which types can be booked here.">
            {() => (
              <div className="dash-sched-checks">
                <Switch
                  checked={!draft.types}
                  onChange={(every) =>
                    setDraft((prev) => {
                      const { types: _types, ...rest } = prev;
                      return every ? rest : { ...rest, types: setup.types.map((one) => one.id) };
                    })
                  }
                  label="Every type"
                />
                {draft.types &&
                  setup.types.map((type) => (
                    <Switch
                      key={type.id}
                      checked={draft.types!.includes(type.id)}
                      onChange={(on) => set("types", on ? [...draft.types!, type.id] : draft.types!.filter((one) => one !== type.id))}
                      label={type.name}
                    />
                  ))}
              </div>
            )}
          </FormRow>
          {draft.kind === "set" && (
            <>
              <SettingsEditor keys={LAYER_KEYS.block} value={draft.settings} inherited={inherited} fields={fields} onChange={(settings) => set("settings", settings)} />
              <FormRow label="Most bookings each time" hint="Per occurrence: at most four installs in each Tuesday block.">
                {(field) => (
                  <NumberInput
                    id={field}
                    value={draft.maxBookings}
                    min={1}
                    max={500}
                    placeholder="No limit"
                    onChange={(value) =>
                      setDraft((prev) => {
                        const { maxBookings: _max, ...rest } = prev;
                        return value === undefined ? rest : { ...rest, maxBookings: value };
                      })
                    }
                  />
                )}
              </FormRow>
            </>
          )}
        </SheetSection>
      )}
    </SetupSheet>
  );
};

/* ── a placement ───────────────────────────────────────────────────────── */

type PlacementDraft = Omit<Placement, "createdAt" | "updatedAt" | "createdBy">;
const WEEKDAY_CHIPS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

const PlacementSheet = ({
  setup,
  id,
  block,
  isNew,
  onClose,
  onSaved,
}: {
  readonly setup: SchedulingOverview;
  readonly id: string;
  readonly block: string;
  readonly isNew: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): JSX.Element => {
  const held = setup.placements.find((one) => one.id === id);
  const first = setup.profiles[0];
  const zone = first?.timezone ?? browserZone();
  const today = todayIn(zone);
  const [draft, setDraft] = useState<PlacementDraft>(
    held ?? { id, block, target: { kind: "member", id: first?.member ?? "" }, timezone: zone, start: `${today}T08:00`, end: `${today}T12:00`, repeat: { every: "week", interval: 1 }, except: [] },
  );
  const [scope, setScope] = useState<"all" | "later">("all");
  const [splitFrom, setSplitFrom] = useState(today);
  const set = <K extends keyof PlacementDraft>(key: K, value: PlacementDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const date = draft.start.slice(0, 10);
  const setTimes = (next: { date?: string; from?: string; to?: string }) => {
    const day = next.date ?? date;
    const from = next.from ?? draft.start.slice(11);
    const to = next.to ?? draft.end.slice(11);
    setDraft((prev) => ({ ...prev, start: `${day}T${from}`, end: `${day}T${to}` }));
  };
  const repeat = draft.repeat;
  const setRepeat = (next: Recurrence | undefined) =>
    setDraft((prev) => {
      const { repeat: _repeat, ...rest } = prev;
      return next ? { ...rest, repeat: next } : rest;
    });
  const ends = repeat?.until ? "until" : repeat?.count ? "count" : "never";
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const thisBlock = setup.blocks.find((one) => one.id === draft.block);

  return (
    <SetupSheet
      trail={`Calendar / Blocks / ${thisBlock?.name ?? ""}`}
      title={isNew ? "Place on a calendar" : "Placement"}
      onClose={onClose}
      onSave={async () => {
        if (draft.end.slice(11) <= draft.start.slice(11)) throw new Error("It must end after it starts.");
        if (!isNew && held?.repeat && scope === "later" && splitFrom > held.start.slice(0, 10)) {
          /* This and later: the old series stops the day before, and this is the new one from that date. */
          const { after } = await api.splitPlacement(id, splitFrom, newId("place"));
          await api.putPlacement(after.id, { ...draft, id: after.id, start: `${splitFrom}T${draft.start.slice(11)}`, end: `${splitFrom}T${draft.end.slice(11)}` });
        } else {
          await api.putPlacement(id, draft);
        }
        await onSaved();
      }}
      {...(!isNew ? { onRemove: async () => (await api.removePlacement(id), await onSaved()), removeLabel: "Remove all" } : {})}
      testId="placement-sheet"
    >
      <SheetSection title="Where">
        <FormRow label="Block">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.block} onChange={(event) => set("block", event.target.value)}>
              {setup.blocks.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label="On the calendar of" hint="A pool's placement applies to each of its people.">
          {(field) => (
            <select
              id={field}
              className="dash-sched-input"
              value={`${draft.target.kind}:${draft.target.id}`}
              onChange={(event) => {
                const [kind, ...rest] = event.target.value.split(":");
                const target = { kind: kind as "member" | "pool", id: rest.join(":") };
                const owner = target.kind === "member" ? setup.profiles.find((one) => one.member === target.id)?.timezone : setup.pools.find((one) => one.id === target.id)?.timezone;
                setDraft((prev) => ({ ...prev, target, ...(owner ? { timezone: owner } : {}) }));
              }}
              data-testid="placement-target"
            >
              {setup.profiles.map((profile) => (
                <option key={profile.member} value={`member:${profile.member}`}>
                  {profile.displayName}
                </option>
              ))}
              {setup.pools.map((pool) => (
                <option key={pool.id} value={`pool:${pool.id}`}>
                  Pool: {pool.name}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        <FormRow label="Time zone" hint="The times below are read in it.">
          {(field) => <TimeZoneSelect id={field} value={draft.timezone} onChange={(value) => set("timezone", value)} />}
        </FormRow>
      </SheetSection>

      <SheetSection title="When">
        <FormRow label={repeat ? "Starting" : "Date"}>{(field) => <TextInput id={field} type="date" value={date} onChange={(value) => value && setTimes({ date: value })} testId="placement-date" />}</FormRow>
        <FormRow label="Hours">
          {(field) => (
            <div className="dash-sched-inline">
              <TextInput id={field} type="time" value={draft.start.slice(11)} onChange={(value) => value && setTimes({ from: value })} />
              <span className="dash-hint">to</span>
              <TextInput type="time" value={draft.end.slice(11)} onChange={(value) => value && setTimes({ to: value })} />
            </div>
          )}
        </FormRow>
        <FormRow label="Repeats">
          {() => (
            <Segmented
              label="Repeats"
              value={repeat ? repeat.every : "none"}
              options={[
                { value: "none", label: "Once" },
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
                { value: "month", label: "Monthly" },
              ]}
              onChange={(every) => setRepeat(every === "none" ? undefined : { every, interval: 1, ...(every === "week" ? { weekdays: [weekday] } : {}), ...(every === "month" ? { monthly: { by: "date" } } : {}) })}
              testId="placement-repeat"
            />
          )}
        </FormRow>
        {repeat && (
          <>
            <FormRow label="Every">
              {(field) => (
                <div className="dash-sched-inline">
                  <NumberInput id={field} value={repeat.interval} min={1} max={52} onChange={(interval) => setRepeat({ ...repeat, interval: interval ?? 1 })} />
                  <span className="dash-hint">{repeat.every === "day" ? "days" : repeat.every === "week" ? "weeks" : "months"}</span>
                </div>
              )}
            </FormRow>
            {repeat.every === "week" && (
              <FormRow label="On">
                {() => (
                  <div className="dash-sched-daychips" role="group" aria-label="Weekdays">
                    {WEEKDAY_CHIPS.map(({ day, label }) => {
                      const days = repeat.weekdays ?? [weekday];
                      const on = days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          className="dash-sched-daychip"
                          aria-pressed={on}
                          onClick={() => {
                            const next = on ? days.filter((one) => one !== day) : [...days, day];
                            if (next.length > 0) setRepeat({ ...repeat, weekdays: next });
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </FormRow>
            )}
            {repeat.every === "month" && (
              <FormRow label="On" hint="A month without the date (the 31st) is skipped.">
                {(field) => (
                  <select
                    id={field}
                    className="dash-sched-input"
                    value={repeat.monthly?.by === "weekday" ? String(repeat.monthly.nth) : "date"}
                    onChange={(event) => setRepeat({ ...repeat, monthly: event.target.value === "date" ? { by: "date" } : { by: "weekday", nth: Number(event.target.value) as 1 | 2 | 3 | 4 | -1 } })}
                  >
                    <option value="date">Day {Number(date.slice(8))} of each month</option>
                    {[1, 2, 3, 4, -1].map((nth) => (
                      <option key={nth} value={nth}>
                        The {nth === -1 ? "last" : ["", "1st", "2nd", "3rd", "4th"][nth]} {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday]}
                      </option>
                    ))}
                  </select>
                )}
              </FormRow>
            )}
            <FormRow label="Ends">
              {() => (
                <div className="dash-sched-inline">
                  <Segmented
                    label="Ends"
                    value={ends}
                    options={[
                      { value: "never", label: "Never" },
                      { value: "until", label: "On a date" },
                      { value: "count", label: "After" },
                    ]}
                    onChange={(how) => {
                      const { until: _until, count: _count, ...rest } = repeat;
                      setRepeat(how === "until" ? { ...rest, until: date } : how === "count" ? { ...rest, count: 10 } : rest);
                    }}
                  />
                  {ends === "until" && <TextInput type="date" value={repeat.until ?? date} onChange={(until) => until && setRepeat({ ...repeat, until })} />}
                  {ends === "count" && (
                    <>
                      <NumberInput value={repeat.count} min={1} max={1000} onChange={(count) => setRepeat({ ...repeat, count: count ?? 1 })} />
                      <span className="dash-hint">times</span>
                    </>
                  )}
                </div>
              )}
            </FormRow>
          </>
        )}
      </SheetSection>

      {!isNew && held?.repeat && (
        <SheetSection title="Changing a repeating placement" description="Change every occurrence, or only from a date on: the earlier ones stay as they were.">
          <FormRow label="Apply to">
            {() => (
              <div className="dash-sched-inline">
                <Segmented
                  label="Apply to"
                  value={scope}
                  options={[
                    { value: "all", label: "All of them" },
                    { value: "later", label: "This and later" },
                  ]}
                  onChange={setScope}
                />
                {scope === "later" && <TextInput type="date" value={splitFrom} onChange={(value) => value && setSplitFrom(value)} />}
              </div>
            )}
          </FormRow>
          <FormRow label="Skipped dates" hint="One occurrence taken out, the rest unchanged.">
            {() => (
              <SkipList
                except={draft.except}
                onChange={(except) => set("except", except)}
                {...(held ? { onSkip: async (day: string) => set("except", (await api.skipOccurrence(id, day)).except) } : {})}
              />
            )}
          </FormRow>
        </SheetSection>
      )}
    </SetupSheet>
  );
};

const SkipList = ({ except, onChange, onSkip }: { readonly except: readonly string[]; readonly onChange: (except: string[]) => void; readonly onSkip?: (date: string) => Promise<void> }): JSX.Element => {
  const [date, setDate] = useState("");
  return (
    <div className="dash-sched-stack">
      <div className="dash-sched-chips">
        {except.length === 0 && <span className="dash-hint">None.</span>}
        {except.map((day) => (
          <span key={day} className="dash-sched-chip">
            {day}
            <button type="button" className="dash-sched-chip__remove" aria-label={`Put ${day} back`} onClick={() => onChange(except.filter((one) => one !== day))}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="dash-sched-inline">
        <TextInput type="date" value={date} onChange={setDate} />
        <Button size="sm" disabled={!date} onClick={() => (onSkip ? void onSkip(date) : onChange([...new Set([...except, date])].sort()))}>
          Skip this date
        </Button>
      </div>
    </div>
  );
};
