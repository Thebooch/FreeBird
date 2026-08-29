import type { LlmAdapter, LlmTool } from "@freebirdai/dash-agent";
import { z } from "zod";
import type { Evidence } from "./types.js";

/**
 * Going deeper: reading a lot of records instead of a sample.
 *
 * The ordinary path reads fifty rows and asks one model whether they answer the
 * question. That is right for "how many active leases" and useless for "why did
 * turnover jump" — the second needs the records themselves, and there are more
 * of them than fit in one call.
 *
 * So this is a map-reduce. Records are cut into chunks, each chunk is read on
 * its own, and a final pass joins what came back. Each chunk is asked for three
 * things rather than one:
 *
 *   1. what it says about the question that was actually asked
 *   2. what else in it bears on that question
 *   3. what pattern it shows that nobody asked about
 *
 * The third is the reason this exists. Somebody looking at four hundred records
 * by hand notices that half the vacancies are one property, or that a category
 * stopped being used in March. A model reading a chunk can notice the same
 * thing, but only if it is asked — and a chunk is small enough that noticing is
 * cheap. What it cannot do is see across chunks, which is the join's job.
 *
 * Chunks are read on the cheap tier: this is bulk reading, and there are many
 * calls. The consolidated finding then goes to the ordinary response step,
 * which writes what the user reads — so the voice stays in one place, and a
 * deep answer sounds like the rest of the conversation rather than a report.
 */

/**
 * A hundred records per chunk.
 *
 * Large enough that a pattern is visible inside one — fifty rows is a sample, a
 * hundred is a stretch of data — and small enough that a cheap model reads all
 * of it attentively rather than summarising the middle away.
 */
export const CHUNK_SIZE = 100;

/**
 * A ceiling on the fan-out, in chunks rather than records.
 *
 * Twenty chunks is two thousand records and twenty-one model calls. Past that
 * the honest move is to say how much was read rather than to keep spending: an
 * answer drawn from two thousand records with the limit stated beats one drawn
 * from ten thousand with the cost hidden.
 */
export const MAX_CHUNKS = 20;

export const chunkRows = <T,>(rows: readonly T[], size = CHUNK_SIZE): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size) as T[]);
  return out;
};

export const CHUNK_SYSTEM_PROMPT = [
  "You are reading one stretch of somebody's own records to help answer a question about them.",
  "",
  "You are shown a numbered chunk out of several. Report three things:",
  "",
  "- `direct`: what THIS chunk says about the question. Numbers, names, dates - counts and",
  "  extremes from these rows only. If it says nothing about the question, say so plainly;",
  "  an empty chunk is a fact and inventing one is not.",
  "- `related`: what else in these rows bears on the question without answering it. The field",
  "  that is always empty, the value that only ever appears alongside another, the record that",
  "  does not fit the shape of the rest.",
  "- `trends`: a pattern in these rows that nobody asked about but somebody would want to know.",
  "  A concentration, a gap, a run of dates, a category that stops. Leave it empty rather than",
  "  reaching - a pattern claimed from a hundred rows and absent from the next hundred is worse",
  "  than silence, and the joining step can only reconcile what was really seen.",
  "",
  "Every claim must be traceable to a row in front of you. Do not estimate totals for records",
  "you were not shown; another chunk has those and the joining step will add them up.",
].join("\n");

const chunkSchema = z.object({
  direct: z.string().max(1500).default(""),
  related: z.string().max(1000).default(""),
  trends: z.string().max(1000).default(""),
});

const chunkTool: LlmTool = {
  name: "read_chunk",
  description: "Report what this stretch of records says.",
  schema: chunkSchema,
};

export const JOIN_SYSTEM_PROMPT = [
  "You are joining what several readers found, each in a different stretch of the same records.",
  "",
  "Each reported what their chunk said about the question, what else bore on it, and any",
  "pattern they noticed. None of them saw the others' records. Produce one finding:",
  "",
  "- `answer`: the answer to the question across ALL the chunks. Add up what has to be added",
  "  up, take the extreme of the extremes, and say plainly when the chunks disagree rather than",
  "  picking one.",
  "- `trends`: patterns that hold across chunks, and only those. A pattern one reader saw and",
  "  the others did not is a property of that stretch, not of the data - either say so with that",
  "  scope attached or drop it. This is the one thing no single chunk could tell you, so it is",
  "  the part worth being strict about.",
  "- `caveats`: what the readers could not see, disagreed on, or flagged as missing.",
  "",
  "Do not introduce a number no chunk reported. Where the chunks together still do not answer",
  "the question, say what is missing - the reply that goes to the user will say so honestly.",
].join("\n");

const joinSchema = z.object({
  answer: z.string().max(2500).default(""),
  trends: z.string().max(1500).default(""),
  caveats: z.string().max(1000).default(""),
});

const joinTool: LlmTool = {
  name: "join_findings",
  description: "Join what each reader found into one finding.",
  schema: joinSchema,
};

export interface ChunkFinding {
  readonly chunk: number;
  readonly rows: number;
  readonly direct: string;
  readonly related: string;
  readonly trends: string;
}

export interface DeepFinding {
  readonly answer: string;
  readonly trends: string;
  readonly caveats: string;
  readonly chunks: readonly ChunkFinding[];
  /** Records actually read, and how many chunks they were cut into. */
  readonly scanned: number;
  readonly chunkCount: number;
  /** Chunks the cap refused to read. Zero when everything was covered. */
  readonly skipped: number;
}

const readChunk = async (
  llm: LlmAdapter,
  input: {
    question: string;
    rows: readonly Record<string, unknown>[];
    index: number;
    total: number;
    source: string;
  },
  options: { model?: string | undefined; signal?: AbortSignal | undefined },
): Promise<ChunkFinding> => {
  const empty: ChunkFinding = {
    chunk: input.index + 1,
    rows: input.rows.length,
    direct: "",
    related: "",
    trends: "",
  };
  try {
    const result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 900,
      messages: [
        { role: "system" as const, content: CHUNK_SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: [
            `Question: ${input.question}`,
            `Source: ${input.source}`,
            `Chunk ${input.index + 1} of ${input.total} — ${input.rows.length} record(s).`,
            "",
            JSON.stringify(input.rows).slice(0, 60_000),
          ].join("\n"),
        },
      ],
      tools: { read_chunk: chunkTool },
      toolChoice: { name: "read_chunk" as const },
    });
    const call = result.toolCalls.find((candidate) => candidate.name === "read_chunk");
    const parsed = call ? chunkSchema.safeParse(call.args) : null;
    if (!parsed?.success) return empty;
    return {
      ...empty,
      direct: parsed.data.direct.trim(),
      related: parsed.data.related.trim(),
      trends: parsed.data.trends.trim(),
    };
  } catch {
    /*
     * One chunk failing must not lose the other nineteen. It comes back empty
     * and the join is told how many chunks reported nothing, so a partial read
     * is visible rather than silently narrower.
     */
    return empty;
  }
};

export interface AnalyseDeepOptions {
  readonly model?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly maxChunks?: number;
  /**
   * Records per chunk. Defaults to {@link CHUNK_SIZE}.
   *
   * A tuning parameter, not part of the mechanism — which is why it is
   * settable. A small account cannot fill a hundred-row chunk, and the useful
   * question there is still whether a real model reads a real stretch of these
   * records and finds something, not whether the stretch is exactly a hundred.
   */
  readonly chunkSize?: number;
  /** Test seam: run chunks in order rather than together. */
  readonly sequential?: boolean;
}

export const analyseDeep = async (
  llm: LlmAdapter,
  input: { readonly question: string; readonly evidence: Evidence },
  options: AnalyseDeepOptions = {},
): Promise<DeepFinding> => {
  const source = input.evidence.candidate.title;
  const all = chunkRows(input.evidence.rows, options.chunkSize ?? CHUNK_SIZE);
  const cap = options.maxChunks ?? MAX_CHUNKS;
  const chunks = all.slice(0, cap);
  const skipped = all.length - chunks.length;

  const call = (rows: readonly Record<string, unknown>[], index: number) =>
    readChunk(
      llm,
      { question: input.question, rows, index, total: chunks.length, source },
      { ...(options.model ? { model: options.model } : {}), ...(options.signal ? { signal: options.signal } : {}) },
    );

  /*
   * Chunks are independent by construction — each reader is told it sees one
   * stretch and nothing else — so they run together. Sequentially, twenty
   * chunks is twenty round trips of latency for no extra correctness.
   */
  const findings: ChunkFinding[] = options.sequential
    ? await chunks.reduce<Promise<ChunkFinding[]>>(
        async (previous, rows, index) => [...(await previous), await call(rows, index)],
        Promise.resolve([]),
      )
    : await Promise.all(chunks.map((rows, index) => call(rows, index)));

  const scanned = chunks.reduce((total, rows) => total + rows.length, 0);
  const said = findings.filter((finding) => finding.direct || finding.related || finding.trends);

  /*
   * Nothing to join. Skipping the call is not an optimisation: asking a model
   * to consolidate silence produces a confident summary of nothing, which is
   * the one failure this whole path is built to avoid.
   */
  if (said.length === 0) {
    return {
      answer: "",
      trends: "",
      caveats: `None of the ${chunks.length} chunk(s) read said anything about this.`,
      chunks: findings,
      scanned,
      chunkCount: chunks.length,
      skipped,
    };
  }

  const body = findings
    .map((finding) =>
      [
        `Chunk ${finding.chunk} (${finding.rows} records)`,
        finding.direct ? `  answer: ${finding.direct}` : "  answer: (nothing)",
        finding.related ? `  related: ${finding.related}` : "",
        finding.trends ? `  pattern: ${finding.trends}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  try {
    const result = await llm.generate({
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      temperature: 0,
      maxOutputTokens: 1400,
      messages: [
        { role: "system" as const, content: JOIN_SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: [
            `Question: ${input.question}`,
            `Source: ${source}`,
            `${chunks.length} chunk(s), ${scanned} record(s) in total.` +
              (skipped > 0 ? ` ${skipped} further chunk(s) were not read.` : ""),
            "",
            body,
          ].join("\n"),
        },
      ],
      tools: { join_findings: joinTool },
      toolChoice: { name: "join_findings" as const },
    });
    const call = result.toolCalls.find((candidate) => candidate.name === "join_findings");
    const parsed = call ? joinSchema.safeParse(call.args) : null;
    if (!parsed?.success) {
      /*
       * The chunks are still real findings. Handing them over unjoined is a
       * worse answer than a joined one and a far better one than nothing.
       */
      return {
        answer: said.map((finding) => finding.direct).filter(Boolean).join(" "),
        trends: said.map((finding) => finding.trends).filter(Boolean).join(" "),
        caveats: "These were read in chunks and could not be consolidated.",
        chunks: findings,
        scanned,
        chunkCount: chunks.length,
        skipped,
      };
    }
    return {
      answer: parsed.data.answer.trim(),
      trends: parsed.data.trends.trim(),
      caveats: parsed.data.caveats.trim(),
      chunks: findings,
      scanned,
      chunkCount: chunks.length,
      skipped,
    };
  } catch (cause) {
    return {
      answer: said.map((finding) => finding.direct).filter(Boolean).join(" "),
      trends: said.map((finding) => finding.trends).filter(Boolean).join(" "),
      caveats: `These were read in chunks and could not be consolidated: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      chunks: findings,
      scanned,
      chunkCount: chunks.length,
      skipped,
    };
  }
};
