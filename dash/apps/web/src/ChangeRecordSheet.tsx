import { Button } from "@freebirdai/dash-components";
import {
  RecordForm,
  WriteReview,
  changedValues,
  type FormValues,
  type RecordChangeRequest,
  type ReferenceOption,
} from "@freebirdai/dash-react";
import type {
  ConnectionSpec,
  EntityLinkView,
  WriteCommitView,
  WriteFieldError,
  WriteFormView,
  WriteReviewView,
} from "@freebirdai/dash-spec";
import { readField } from "@freebirdai/dash-spec";
import { useEffect, useMemo, useState } from "react";
import { WriteApiError, writesApi, type ChangeAddress } from "./writes.js";

/**
 * One change to one record, from the button that asked for it to the answer.
 *
 * Three steps, and the middle one is the point: **values → review → sent**.
 * The form only gathers values. The review is the server's — it read the
 * record as it is now and built exactly what will be sent — and it is the
 * only thing a person says yes to. A delete, or an action that takes no
 * values, starts at the review.
 *
 * What happens when it goes wrong is said plainly, because each case needs
 * something different: fix a value; look again at a record somebody else
 * just changed; check whether a change whose answer was lost was made.
 */

type Step =
  | { readonly kind: "loading" }
  | { readonly kind: "form"; readonly form: WriteFormView; readonly errors: readonly WriteFieldError[]; readonly message?: string }
  | { readonly kind: "review"; readonly review: WriteReviewView; readonly form?: WriteFormView; readonly error?: string; readonly detail?: string; readonly spent?: boolean }
  | { readonly kind: "done"; readonly result: WriteCommitView }
  | { readonly kind: "failed"; readonly message: string };

export interface ChangeRecordSheetProps {
  readonly request: RecordChangeRequest;
  readonly connection: ConnectionSpec | undefined;
  readonly entityLinks: readonly EntityLinkView[];
  readonly onClose: () => void;
  /** After a change was made: refresh what it made stale, and go wherever it leads. */
  readonly onDone: (result: WriteCommitView) => void;
}

/** The rows of a list response, wherever the endpoint says they are. */
const rowsOf = (body: unknown, rowsPath: string | undefined): unknown[] => {
  const at = !rowsPath || rowsPath === "$" ? body : readField(body, rowsPath.replace(/^\$\./, ""));
  return Array.isArray(at) ? at : [];
};

/**
 * Choices for fields that name another record: that record type's own list,
 * read through the same query route and cache as any widget, named the way
 * its pages name it. One request per record type, and only when a form needs it.
 */
const useReferenceOptions = (
  form: WriteFormView | undefined,
  connection: ConnectionSpec | undefined,
  links: readonly EntityLinkView[],
): Record<string, readonly ReferenceOption[]> => {
  const [options, setOptions] = useState<Record<string, readonly ReferenceOption[]>>({});
  const wanted = useMemo(
    () => [...new Set((form?.fields ?? []).map((field) => field.references).filter((one): one is string => Boolean(one)))],
    [form],
  );
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    for (const entity of wanted) {
      const link = links.find((one) => one.entity === entity);
      if (!link?.list || !link.identity) continue;
      const op = connection.ops.find((one) => one.id === link.list);
      void fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: connection.id, op: link.list, params: {}, maxAgeMs: 10 * 60_000 }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { body?: unknown } | null) => {
          if (cancelled || !payload) return;
          const choices = rowsOf(payload.body, op?.rowsPath)
            .slice(0, 500)
            .flatMap((row): ReferenceOption[] => {
              const id = readField(row, link.identity!);
              if (id === undefined || id === null) return [];
              const name = link.title
                .map((path) => readField(row, path))
                .filter((value) => value !== undefined && value !== null && value !== "")
                .join(" ");
              return [{ value: String(id), label: name ? `${name} (${String(id)})` : String(id) }];
            });
          setOptions((current) => ({ ...current, [entity]: choices }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [wanted, connection, links]);
  return options;
};

const addressOf = (request: RecordChangeRequest): ChangeAddress => ({
  kind: request.kind,
  ...(request.action ? { action: request.action.id } : {}),
  ...(request.id ? { id: request.id } : {}),
  ...(request.parents ? { parents: request.parents } : {}),
});

export const ChangeRecordSheet = ({
  request,
  connection,
  entityLinks,
  onClose,
  onDone,
}: ChangeRecordSheetProps): JSX.Element => {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [values, setValues] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const address = useMemo(() => addressOf(request), [request]);
  const form = step.kind === "form" ? step.form : step.kind === "review" ? step.form : undefined;
  const references = useReferenceOptions(form, connection, entityLinks);
  const creating = request.kind === "create" || (form?.mode === "upsert" && form.exists === false);

  /** Build the review from these values — the server's, never this screen's. */
  const review = async (from: WriteFormView | undefined, entered: FormValues): Promise<void> => {
    setBusy(true);
    try {
      const sent = from ? changedValues(from.values, entered, creating) : {};
      const made = await writesApi.prepare(request.connection, request.entity, address, sent);
      setStep({ kind: "review", review: made, ...(from ? { form: from } : {}) });
    } catch (error) {
      if (error instanceof WriteApiError && error.fields && from) {
        setStep({ kind: "form", form: from, errors: error.fields, message: error.message });
      } else if (from) {
        setStep({ kind: "form", form: from, errors: [], message: error instanceof Error ? error.message : String(error) });
      } else {
        setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStep({ kind: "loading" });
    void (async () => {
      try {
        // A delete takes no values: straight to what will happen.
        if (request.kind === "delete") {
          if (!cancelled) await review(undefined, {});
          return;
        }
        const loaded = await writesApi.form(request.connection, request.entity, address);
        if (cancelled) return;
        if (request.kind === "action" && loaded.fields.length === 0) {
          await review(undefined, {});
          return;
        }
        /*
         * A required yes/no shows as a box that is not ticked, and has to mean
         * exactly that: a checkbox has no third state for "not answered".
         */
        const start: Record<string, unknown> = { ...loaded.values };
        for (const field of loaded.fields) {
          if (field.type === "boolean" && field.required && start[field.field] === undefined) start[field.field] = false;
        }
        setValues(start);
        setStep({ kind: "form", form: { ...loaded, values: start }, errors: [] });
      } catch (error) {
        if (!cancelled) setStep({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const confirm = async (current: WriteReviewView, from: WriteFormView | undefined): Promise<void> => {
    setBusy(true);
    try {
      const result = await writesApi.commit(current);
      setStep({ kind: "done", result });
      onDone(result);
    } catch (error) {
      if (error instanceof WriteApiError && error.code === "stale" && error.review) {
        setStep({ kind: "review", review: error.review, ...(from ? { form: from } : {}), error: error.message });
      } else if (error instanceof WriteApiError) {
        setStep({
          kind: "review",
          review: current,
          ...(from ? { form: from } : {}),
          error: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
          // Sent, or refused by the API: this review cannot be sent again. Nothing sent: it can.
          spent: error.outcome !== "not-sent",
        });
      } else {
        setStep({ kind: "review", review: current, ...(from ? { form: from } : {}), error: String(error), spent: true });
      }
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    if (step.kind === "review" && !step.spent) void writesApi.discard(step.review.pendingId).catch(() => undefined);
    onClose();
  };

  const heading =
    request.kind === "update" && request.title === "Edit"
      ? `Edit ${(request.entityName ?? "record").toLowerCase()}`
      : request.title;

  return (
    <div className="dash-sheet-overlay" role="presentation" onClick={close}>
      <aside
        className="dash-sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
        data-testid="change-record-sheet"
      >
        <div className="dash-sheet-panel__head">
          <h2>{step.kind === "review" ? step.review.title : heading}</h2>
          <Button tone="ghost" size="sm" onClick={close} ariaLabel="Close">
            ✕
          </Button>
        </div>

        {step.kind === "loading" && <p className="dash-hint">Reading the record as it is now…</p>}

        {step.kind === "failed" && (
          <div className="dash-callout dash-callout--bad" role="alert" data-testid="change-record-failed">
            {step.message}
          </div>
        )}

        {step.kind === "form" && (
          <>
            {!step.form.verified && (
              <p className="dash-hint">This is the first time this change is being made from here.</p>
            )}
            {step.message && (
              <div className="dash-callout dash-callout--bad" role="alert">
                {step.message}
              </div>
            )}
            <RecordForm
              fields={step.form.fields}
              values={values}
              onChange={setValues}
              errors={step.errors}
              editing={!creating}
              disabled={busy}
              references={references}
            />
            <div className="dash-row dash-row--end">
              <Button onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button tone="primary" busy={busy} onClick={() => void review(step.form, values)} testId="change-record-review">
                Review the change
              </Button>
            </div>
          </>
        )}

        {step.kind === "review" && (
          <WriteReview
            review={step.review}
            busy={busy}
            {...(step.error ? { error: step.error } : {})}
            {...(step.detail ? { detail: step.detail } : {})}
            onCancel={close}
            confirmDisabled={Boolean(step.spent)}
            {...(step.form ? { onEdit: () => setStep({ kind: "form", form: step.form!, errors: [] }) } : {})}
            onConfirm={() => {
              if (step.spent) return;
              void confirm(step.review, step.form);
            }}
          />
        )}

        {step.kind === "done" && (
          <>
            <div className="dash-callout dash-callout--good" role="status" data-testid="change-record-done">
              <strong>{step.result.title}</strong> — done.
              {step.result.changed.length > 0 && <> Changed: {step.result.changed.join(", ")}.</>}
            </div>
            <div className="dash-row dash-row--end">
              <Button tone="primary" onClick={onClose} testId="change-record-close">
                Close
              </Button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
};
