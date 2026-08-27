import type { DbAdapter } from "../adapters/db.js";
import type { EmailAdapter } from "../adapters/email.js";
import type { LlmAdapter, LlmMessage } from "../adapters/llm.js";
import type { ComponentRegistry } from "../components/registry.js";
import type { AuthContext, CustomTab, DataSourceContext, DigestConfig } from "../types.js";
import { nextCronRun } from "./cron.js";

export interface DigestEngineOptions {
  db: DbAdapter;
  llm: LlmAdapter;
  email: EmailAdapter;
  registry: ComponentRegistry<any, any>;
  /** Base system prompt for summary generation. */
  summaryPrompt?: string;
  /** How to map a tab back to an AuthContext when running in the scheduler.
   *  Scheduler runs as the system, but the dataSource() may need per-owner auth. */
  resolveAuth?: (tab: CustomTab) => AuthContext;
  /**
   * Optional per-run auth refresh. Tabs with digests stamped at save-time may
   * outlive their auth context (e.g. JWT expiry). When provided, this hook
   * runs immediately before each `runOne()` and replaces the tab's auth with
   * the returned value — typically by minting a fresh service token or
   * re-issuing a JWT.
   *
   * Throwing here aborts the run for that tab and surfaces the error in
   * `DigestRunResult.error` (the next poll will retry).
   *
   * @example
   *   refreshAuth: async (savedAuth, tab) => {
   *     const token = await mintServiceToken({
   *       ownerId: tab.ownerId,
   *       audience: "freebird-digest",
   *     });
   *     return { ...savedAuth, token };
   *   }
   */
  refreshAuth?: (
    savedAuth: AuthContext,
    tab: CustomTab,
  ) => AuthContext | Promise<AuthContext>;
}

export interface DigestRunResult {
  tabId: string;
  sent: boolean;
  error?: string;
  emailId?: string;
}

/**
 * The digest engine is the shared piece between the in-process scheduler
 * (inside @freebirdai/server) and the standalone @freebirdai/digest-worker.
 * They wrap it with different cron/polling strategies; behavior is identical.
 */
export class DigestEngine {
  private readonly summaryPrompt: string;
  private readonly resolveAuth: (tab: CustomTab) => AuthContext;

  constructor(private readonly opts: DigestEngineOptions) {
    this.summaryPrompt =
      opts.summaryPrompt ??
      "You are generating a short, actionable digest email for a user. " +
        "Summarize the data from each component in 1-3 sentences, highlight " +
        "anything unusual, and keep the total under 300 words.";
    this.resolveAuth =
      opts.resolveAuth ?? ((tab) => ({ userId: tab.ownerId }));
  }

  /**
   * Runs one digest, sends the email, and advances nextRunAt.
   * Returns a result describing what happened.
   */
  async runOne(tab: CustomTab): Promise<DigestRunResult> {
    const digest = tab.digest;
    if (!digest) return { tabId: tab.id, sent: false, error: "tab has no digest config" };

    try {
      let auth = this.resolveAuth(tab);
      if (this.opts.refreshAuth) {
        auth = await this.opts.refreshAuth(auth, tab);
      }
      const snapshot = await this.buildSnapshot(tab, auth);
      const body = await this.summarize(tab, digest, snapshot);
      const subject = renderSubject(digest, tab, new Date());
      const sent = await this.opts.email.send({
        to: digest.email,
        from: this.opts.email.defaultFrom,
        subject,
        text: body.text,
        html: body.html,
      });
      await this.advanceSchedule(tab, digest, auth);
      return {
        tabId: tab.id,
        sent: true,
        emailId: sent && "id" in sent ? sent.id : undefined,
      };
    } catch (err) {
      return {
        tabId: tab.id,
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Run every currently-due digest. Safe to call from a cron/poll loop. */
  async runDue(now: Date = new Date()): Promise<DigestRunResult[]> {
    const due = await this.opts.db.listDueDigests(now);
    const results: DigestRunResult[] = [];
    for (const tab of due) {
      results.push(await this.runOne(tab));
    }
    return results;
  }

  private async buildSnapshot(
    tab: CustomTab,
    auth: AuthContext,
  ): Promise<Array<{ id: string; title: string; data: unknown }>> {
    const out: Array<{ id: string; title: string; data: unknown }> = [];
    for (const cell of tab.layout.cells) {
      const def = this.opts.registry.get(cell.componentId);
      if (!def || !def.dataSource) continue;
      const ctx: DataSourceContext = {
        tabId: tab.id,
        auth,
        runAt: new Date(),
        props: cell.props,
      };
      try {
        const data = await def.dataSource(ctx);
        out.push({ id: def.id, title: def.title, data });
      } catch (err) {
        out.push({
          id: def.id,
          title: def.title,
          data: {
            __error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
    return out;
  }

  private async summarize(
    tab: CustomTab,
    digest: DigestConfig,
    snapshot: Array<{ id: string; title: string; data: unknown }>,
  ): Promise<{ text: string; html: string }> {
    const messages: LlmMessage[] = [
      { role: "system", content: this.summaryPrompt },
      ...(digest.extraPrompt ? [{ role: "system" as const, content: digest.extraPrompt }] : []),
      {
        role: "user",
        content:
          `Tab: ${tab.title}\n` +
          `Generated at: ${new Date().toUTCString()}\n\n` +
          snapshot
            .map((s) => `## ${s.title} (${s.id})\n\`\`\`json\n${safeJson(s.data)}\n\`\`\``)
            .join("\n\n"),
      },
    ];

    const { text } = await this.opts.llm.generate({ messages });

    if (digest.format === "html") {
      return { text: stripMd(text), html: mdToHtml(text) };
    }
    if (digest.format === "json") {
      return {
        text,
        html: `<pre>${escapeHtml(safeJson({ summary: text, snapshot }))}</pre>`,
      };
    }
    return { text, html: mdToHtml(text) };
  }

  private async advanceSchedule(
    tab: CustomTab,
    digest: DigestConfig,
    auth: AuthContext,
  ): Promise<void> {
    const now = new Date();
    const next = nextCronRun(digest.intervalCron, now);
    await this.opts.db.updateTab(
      tab.id,
      {
        digest: {
          ...digest,
          lastRunAt: now,
          nextRunAt: next,
        },
      },
      auth,
    );
  }
}

export const createDigestEngine = (opts: DigestEngineOptions): DigestEngine =>
  new DigestEngine(opts);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderSubject = (digest: DigestConfig, tab: CustomTab, now: Date): string => {
  const tpl = digest.subjectTemplate ?? "FreeBird digest: {title} — {date}";
  return tpl
    .replace("{title}", tab.title)
    .replace("{date}", now.toISOString().slice(0, 10));
};

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const stripMd = (s: string): string =>
  s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#>-]/g, "")
    .replace(/\n{3,}/g, "\n\n");

/** Minimal markdown-ish renderer for digest emails. Good enough for our needs. */
const mdToHtml = (s: string): string => {
  const escaped = escapeHtml(s);
  return escaped
    .split(/\n\n+/)
    .map((p) => {
      if (/^#+\s/.test(p)) {
        const level = Math.min(p.match(/^#+/)![0].length, 6);
        return `<h${level}>${p.replace(/^#+\s/, "")}</h${level}>`;
      }
      return `<p>${p.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
};
