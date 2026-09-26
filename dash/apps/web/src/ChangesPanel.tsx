import { Badge, Button } from "@freebirdai/dash-components";
import type { EntityWritesView } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { writesApi, type ConnectionWrites } from "./writes.js";

/**
 * What this account's records can have done to them from Dash.
 *
 * There is nothing to switch on: every connection can change what its API
 * lets it change, from boards, record pages and the chat, and every change is
 * shown as a review — what it is now, what it will be — and only sent when
 * somebody says yes to it. So this is a list, not a set of switches.
 *
 * It is also where the two setup chores for writes live: reading an API's
 * write endpoints from its specification again, and settling which record
 * field holds each value an edit sends back.
 */

export interface ChangesPanelProps {
  readonly connectionId: string;
  readonly title: string;
  readonly catalogId: string | null | undefined;
  /** Something about what can be written changed; the board should re-ask. */
  readonly onChanged?: () => void;
}

const offered = (writes: EntityWritesView): string => {
  const parts: string[] = [];
  if (writes.create) parts.push(writes.create.mode === "upsert" ? "add or edit" : "create");
  if (writes.update && writes.update.mode !== "upsert") parts.push("edit");
  if (writes.remove) parts.push("delete");
  if (writes.actions.length > 0) {
    const only = writes.actions.length === 1 ? writes.actions[0]!.title.trim() : "";
    parts.push(only ? only.toLowerCase() : `${writes.actions.length} action${writes.actions.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
};

export const ChangesPanel = ({ connectionId, title, catalogId, onChanged }: ChangesPanelProps): JSX.Element => {
  const [data, setData] = useState<ConnectionWrites | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await writesApi.connection(connectionId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<string | void>): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const said = await work();
      if (said) setNote(said);
      await load();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <section data-testid="changes-panel">
        <h4>Changes</h4>
        <p className="dash-callout dash-callout--bad">{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section data-testid="changes-panel">
        <h4>Changes</h4>
        <p className="dash-hint">Reading what {title} can change…</p>
      </section>
    );
  }

  const readAgain = data.rereadable && catalogId && data.canManage;

  return (
    <section data-testid="changes-panel">
      <h4>Changes to {title}</h4>
      {note && <p className="dash-callout dash-callout--good">{note}</p>}
      {error && <p className="dash-callout dash-callout--bad">{error}</p>}

      {data.writeOpCount === 0 ? (
        <>
          <p className="dash-hint">
            No endpoints that change records are known for this API yet.
            {data.rereadable
              ? " They are read from its specification when the connection is added — that reads the documentation, not your account."
              : ""}
          </p>
          {readAgain && (
            <Button
              disabled={busy}
              busy={busy}
              testId="read-write-endpoints"
              onClick={() =>
                void run(async () => {
                  const result = await writesApi.refresh(catalogId);
                  return `Read ${result.writes} endpoints that change records.`;
                })
              }
            >
              Read write endpoints
            </Button>
          )}
        </>
      ) : (
        <>
          <p className="dash-hint">
            These can be changed from boards, record pages and the chat. Every change is shown for review — what it is
            now and what it will be — and only sent when you approve it.
          </p>
          <ul className="dash-conn-list" data-testid="writes-entities">
            {data.entities.map((entity) => {
              const can = entity.allowed ?? entity.writes;
              return (
                <li key={entity.id} data-testid={`writes-entity-${entity.id}`}>
                  <div className="dash-conn-list__text">
                    <div className="dash-row" style={{ gap: 8, alignItems: "baseline" }}>
                      <strong>{entity.name.many}</strong>
                      <span className="dash-hint">{offered(can) || "Nothing you may change"}</span>
                    </div>
                    <div className="dash-row" style={{ gap: 6 }}>
                      {entity.inferred && <Badge tone="warn">From documentation prose</Badge>}
                      {entity.unmatched.length > 0 && (
                        <span className="dash-hint">
                          An edit cannot read {entity.unmatched.length === 1 ? "one value" : `${entity.unmatched.length} values`} (
                          {entity.unmatched.map((field) => field.label).slice(0, 4).join(", ")}
                          {entity.unmatched.length > 4 ? ", …" : ""}) and would leave {entity.unmatched.length === 1 ? "it" : "them"} out.
                        </span>
                      )}
                    </div>
                  </div>
                  {entity.unmatched.length > 0 && data.canManage && (
                    <Button
                      size="sm"
                      disabled={busy}
                      testId={`writes-match-${entity.id}`}
                      onClick={() =>
                        void run(async () => {
                          const result = await writesApi.match(connectionId, entity.id);
                          return result.unmatched.length === 0
                            ? "Every value an edit sends is now read from the record first."
                            : `Matched ${result.matched}. Still unread: ${result.unmatched.join(", ")}.`;
                        })
                      }
                    >
                      Match fields
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {readAgain && (
            <p className="dash-hint">
              <button
                type="button"
                className="dash-linkish"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await writesApi.refresh(catalogId);
                    return `Read again: ${result.writes} endpoints (${result.added} new, ${result.removed} gone).`;
                  })
                }
              >
                Read write endpoints again
              </button>{" "}
              — from the specification, not your account.
            </p>
          )}
        </>
      )}
    </section>
  );
};
