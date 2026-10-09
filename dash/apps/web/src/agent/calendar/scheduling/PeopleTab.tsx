import { DEFAULT_HOURS, LAYER_KEYS, POOL_ASSIGN, POOL_ASSIGN_WORDS, resolveSettings, type Pool, type SchedulingProfile } from "@freebirdai/dash-spec";
import { Badge, Button, EmptyState, ErrorState } from "@freebirdai/dash-components";
import { useState } from "react";
import { api, type SchedulingOverview } from "../../../api.js";
import { Segmented, Switch } from "../controls.jsx";
import { colorVar, memberColor } from "../model.js";
import { HoursEditor, SettingsEditor } from "./editors.jsx";
import { ColorPicker, FormRow, NumberInput, SheetSection, TextInput, TimeZoneSelect } from "./inputs.jsx";
import { browserZone, hoursSummary, newId } from "./model.js";
import { SetupSheet } from "./SetupSheet.jsx";
import { useSetup } from "./useSetup.js";

/**
 * People and pools: whose time can be booked.
 *
 * A person is a workspace member, or a team member added here with a name
 * and an email: they answer approval requests through a page of their own,
 * without signing in. Each has hours, a time zone and their own defaults. A
 * pool groups people under one rule for who takes the next booking.
 */

type Editing = { readonly kind: "person"; readonly member: string; readonly isNew: boolean; readonly team: boolean } | { readonly kind: "pool"; readonly id: string; readonly isNew: boolean };

export const PeopleTab = (): JSX.Element => {
  const { setup, error, canManage, reload } = useSetup();
  const [editing, setEditing] = useState<Editing | null>(null);

  if (error && !setup) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (!setup) return <p className="dash-hint">Loading…</p>;

  const notSetUp = setup.members.filter((member) => !setup.profiles.some((one) => one.member === member.userId));
  const name = (member: string) => setup.profiles.find((one) => one.member === member)?.displayName ?? member;

  return (
    <div className="dash-sched-tab" data-testid="scheduling-people">
      <div className="dash-sched-columns">
        <section className="dash-sched-panel" aria-labelledby="sched-people">
          <header className="dash-sched-panel__head">
            <div>
              <h2 id="sched-people" className="dash-sched-panel__title">
                People
              </h2>
              <p className="dash-sched-panel__lede">Whose time can be booked: their hours, time zone and defaults.</p>
            </div>
            {canManage && (
              <Button onClick={() => setEditing({ kind: "person", member: newId("team", "team-").replace(/^team-team-/, "team-"), isNew: true, team: true })} testId="people-add-team">
                Add a team member
              </Button>
            )}
          </header>
          {setup.profiles.length === 0 && notSetUp.length === 0 ? (
            <EmptyState glyph="◎" title="Nobody yet" body="Add a team member, or set up a workspace member, to start taking bookings." />
          ) : (
            <ul className="dash-sched-list">
              {setup.profiles.map((profile) => (
                <li key={profile.member}>
                  <button type="button" className="dash-sched-item" onClick={() => setEditing({ kind: "person", member: profile.member, isNew: false, team: profile.member.startsWith("team-") })} data-testid="people-row">
                    <span className="dash-sched-avatar" style={{ ["--cal-color" as string]: colorVar(profile.color ?? memberColor(profile.member)) }} aria-hidden="true">
                      {profile.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="dash-sched-item__main">
                      <span className="dash-sched-item__title">
                        {profile.displayName}
                        {profile.bookable ? <Badge tone="accent">Bookable</Badge> : <Badge>Not bookable</Badge>}
                        {profile.member.startsWith("team-") && <Badge>Team member</Badge>}
                      </span>
                      <span className="dash-sched-item__meta">
                        {hoursSummary(profile.hours)} · {profile.timezone.replace(/_/g, " ")}
                        {profile.outsideBlocks === "closed" ? " · only through blocks" : ""}
                      </span>
                    </span>
                    <span className="dash-sched-item__aside">{profile.email ?? ""}</span>
                  </button>
                </li>
              ))}
              {notSetUp.map((member) => (
                <li key={member.userId}>
                  <div className="dash-sched-item" data-muted="true">
                    <span className="dash-sched-avatar" aria-hidden="true">
                      {(member.email || member.userId).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="dash-sched-item__main">
                      <span className="dash-sched-item__title">{member.email || (member.userId === "local" ? "You" : member.userId)}</span>
                      <span className="dash-sched-item__meta">Workspace member · not set up for bookings</span>
                    </span>
                    {canManage && (
                      <Button size="sm" onClick={() => setEditing({ kind: "person", member: member.userId, isNew: true, team: false })}>
                        Set up
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dash-sched-panel" aria-labelledby="sched-pools">
          <header className="dash-sched-panel__head">
            <div>
              <h2 id="sched-pools" className="dash-sched-panel__title">
                Pools
              </h2>
              <p className="dash-sched-panel__lede">People who share the work, and how the next booking is given out.</p>
            </div>
            {canManage && setup.profiles.length > 0 && (
              <Button onClick={() => setEditing({ kind: "pool", id: newId("pool"), isNew: true })} testId="pools-add">
                New pool
              </Button>
            )}
          </header>
          {setup.pools.length === 0 ? (
            <p className="dash-sched-empty">No pools. A pool lets an appointment type go to whichever of several people is free.</p>
          ) : (
            <ul className="dash-sched-list">
              {setup.pools.map((pool) => (
                <li key={pool.id}>
                  <button type="button" className="dash-sched-item" onClick={() => setEditing({ kind: "pool", id: pool.id, isNew: false })} data-testid="pools-row">
                    <span className="dash-sched-swatch" style={{ ["--cal-color" as string]: colorVar(pool.color) }} aria-hidden="true" />
                    <span className="dash-sched-item__main">
                      <span className="dash-sched-item__title">{pool.name}</span>
                      <span className="dash-sched-item__meta">
                        {pool.members.filter((one) => one.active).map((one) => name(one.member)).join(", ") || "Nobody active"} · {POOL_ASSIGN_WORDS[pool.assign]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing?.kind === "person" && (
        <PersonSheet
          setup={setup}
          member={editing.member}
          isNew={editing.isNew}
          team={editing.team}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reload();
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === "pool" && (
        <PoolSheet
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
    </div>
  );
};

/* ── a person ──────────────────────────────────────────────────────────── */

const PersonSheet = ({
  setup,
  member,
  isNew,
  team,
  onClose,
  onSaved,
}: {
  readonly setup: SchedulingOverview;
  readonly member: string;
  readonly isNew: boolean;
  readonly team: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}): JSX.Element => {
  const held = setup.profiles.find((one) => one.member === member);
  const workspaceMember = setup.members.find((one) => one.userId === member);
  const [draft, setDraft] = useState<Omit<SchedulingProfile, "revision" | "updatedAt">>(
    held ?? {
      member,
      displayName: team ? "" : workspaceMember?.email.split("@")[0] || (member === "local" ? "Me" : member),
      ...(workspaceMember?.email ? { email: workspaceMember.email } : {}),
      bookable: true,
      timezone: browserZone(),
      hours: DEFAULT_HOURS,
      outsideBlocks: "open",
      settings: {},
      approvals: { requireSignIn: false, email: true },
      color: memberColor(member),
    },
  );
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const inherited = resolveSettings([{ layer: "workspace", settings: setup.defaults }]);

  return (
    <SetupSheet
      trail={`Calendar / People${team ? " / Team member" : ""}`}
      title={isNew ? (team ? "Add a team member" : "Set up for bookings") : draft.displayName || "Person"}
      onClose={onClose}
      onSave={async () => {
        if (!draft.displayName.trim()) throw new Error("Give them a name.");
        await api.putProfile(member, draft);
        await onSaved();
      }}
      {...(!isNew ? { onRemove: async () => (await api.removeProfile(member), await onSaved()) } : {})}
      testId="person-sheet"
    >
      <SheetSection title="Who" description={team ? "Team members answer approval requests from a page of their own, without signing in." : undefined}>
        <FormRow label="Name">{(id) => <TextInput id={id} value={draft.displayName} maxLength={80} placeholder="Sam Rivera" onChange={(value) => set("displayName", value)} testId="person-name" />}</FormRow>
        <FormRow label="Email" hint={team ? "Where approval requests go. Needed for a team member." : "Where approval requests go."}>
          {(id) => <TextInput id={id} type="email" value={draft.email ?? ""} placeholder="sam@example.com" onChange={(value) => set("email", value.trim() ? value.trim() : undefined)} testId="person-email" />}
        </FormRow>
        <FormRow label="Colour" hint="Their appointments wear it on the calendar.">
          {() => <ColorPicker label="Colour" value={draft.color ?? memberColor(member)} onChange={(color) => set("color", color)} />}
        </FormRow>
      </SheetSection>

      <SheetSection title="Availability" description="When they can be booked, in their own time zone. Blocks placed on their calendar refine it.">
        <FormRow label="Bookable" hint="Off keeps their setup but offers none of their time.">
          {() => <Switch checked={draft.bookable} onChange={(value) => set("bookable", value)} label={draft.bookable ? "Taking bookings" : "Not taking bookings"} testId="person-bookable" />}
        </FormRow>
        <FormRow label="Time zone">{(id) => <TimeZoneSelect id={id} value={draft.timezone} onChange={(value) => set("timezone", value)} />}</FormRow>
        <FormRow label="Working hours" wide>{() => <HoursEditor value={draft.hours} onChange={(hours) => set("hours", hours)} testId="person-hours" />}</FormRow>
        <FormRow label="Outside blocks" hint="Whether their hours that no block covers are open to anyone, or bookable only through blocks.">
          {() => (
            <Segmented
              label="Outside blocks"
              value={draft.outsideBlocks}
              options={[
                { value: "open", label: "Anyone can book" },
                { value: "closed", label: "Only through blocks" },
              ]}
              onChange={(value) => set("outsideBlocks", value)}
            />
          )}
        </FormRow>
      </SheetSection>

      <SheetSection title="Their defaults" description="What applies to their bookings unless an appointment type or block says otherwise. The buffer between appointments is set for everyone, or per block.">
        <SettingsEditor keys={LAYER_KEYS.host} value={draft.settings} inherited={inherited} onChange={(settings) => set("settings", settings)} />
      </SheetSection>
    </SetupSheet>
  );
};

/* ── a pool ────────────────────────────────────────────────────────────── */

const PoolSheet = ({
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
  const held = setup.pools.find((one) => one.id === id);
  const [draft, setDraft] = useState<Omit<Pool, "createdAt" | "updatedAt">>(
    held ?? { id, name: "", color: 4, timezone: browserZone(), members: setup.profiles.map((one) => ({ member: one.member, priority: 1, active: true })), assign: "round_robin", sticky: true, leastBusyWindow: "week" },
  );
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const memberOf = (member: string) => draft.members.find((one) => one.member === member);

  return (
    <SetupSheet
      trail="Calendar / Pools"
      title={isNew ? "New pool" : draft.name || "Pool"}
      onClose={onClose}
      onSave={async () => {
        if (!draft.name.trim()) throw new Error("Give the pool a name.");
        await api.putPool(id, draft);
        await onSaved();
      }}
      {...(!isNew ? { onRemove: async () => (await api.removePool(id), await onSaved()) } : {})}
      testId="pool-sheet"
    >
      <SheetSection title="Pool">
        <FormRow label="Name">{(field) => <TextInput id={field} value={draft.name} maxLength={80} placeholder="Field technicians" onChange={(value) => set("name", value)} testId="pool-name" />}</FormRow>
        <FormRow label="Colour">{() => <ColorPicker label="Colour" value={draft.color} onChange={(color) => set("color", color)} />}</FormRow>
        <FormRow label="Time zone" hint="Blocks placed on the pool are read in it.">
          {(field) => <TimeZoneSelect id={field} value={draft.timezone} onChange={(value) => set("timezone", value)} />}
        </FormRow>
      </SheetSection>
      <SheetSection title="Who is in it" description="Active members take bookings; a lower priority number goes first when the pool assigns by priority.">
        <div className="dash-sched-members">
          {setup.profiles.map((profile) => {
            const one = memberOf(profile.member);
            return (
              <div key={profile.member} className="dash-sched-members__row">
                <Switch
                  checked={Boolean(one)}
                  onChange={(on) => set("members", on ? [...draft.members, { member: profile.member, priority: 1, active: true }] : draft.members.filter((each) => each.member !== profile.member))}
                  label={profile.displayName}
                />
                {one && (
                  <>
                    <label className="dash-sched-members__field">
                      <span className="dash-hint">Priority</span>
                      <NumberInput value={one.priority} min={1} max={100} onChange={(value) => set("members", draft.members.map((each) => (each.member === profile.member ? { ...each, priority: value ?? 1 } : each)))} />
                    </label>
                    <Switch checked={one.active} onChange={(active) => set("members", draft.members.map((each) => (each.member === profile.member ? { ...each, active } : each)))} label={one.active ? "Active" : "Paused"} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </SheetSection>
      <SheetSection title="Who takes the next booking">
        <FormRow label="Assign">
          {(field) => (
            <select id={field} className="dash-sched-input" value={draft.assign} onChange={(event) => set("assign", event.target.value as Pool["assign"])}>
              {POOL_ASSIGN.map((assign) => (
                <option key={assign} value={assign}>
                  {POOL_ASSIGN_WORDS[assign]}
                </option>
              ))}
            </select>
          )}
        </FormRow>
        {draft.assign === "least_busy" && (
          <FormRow label="Busy over">
            {() => (
              <Segmented
                label="Busy over"
                value={draft.leastBusyWindow}
                options={[
                  { value: "day", label: "That day" },
                  { value: "week", label: "That week" },
                ]}
                onChange={(value) => set("leastBusyWindow", value)}
              />
            )}
          </FormRow>
        )}
        <FormRow label="Keep with the same person" hint="Someone who booked before gets the person they had, when that person is free.">
          {() => <Switch checked={draft.sticky} onChange={(value) => set("sticky", value)} label={draft.sticky ? "On" : "Off"} />}
        </FormRow>
      </SheetSection>
    </SetupSheet>
  );
};
