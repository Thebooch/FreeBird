/**
 * Tiny UTC cron parser — just enough to compute "next run at" from a 5-field
 * expression. No external dependency so it works everywhere FreeBird runs.
 *
 * Supported fields (UTC):
 *    minute  (0-59)
 *    hour    (0-23)
 *    dom     (1-31)   day-of-month
 *    month   (1-12)
 *    dow     (0-6)    day-of-week, Sunday=0
 *
 * Each field supports:
 *    *              — any
 *    n              — literal
 *    n-m            — range
 *    a,b,c          — list
 *    *\/n or n/m    — step
 *
 * This is deliberately small. If you need advanced cron (seconds, L, W, #),
 * plug in `cron-parser` via the server package.
 */

type Field = boolean[];

const makeField = (expr: string, lo: number, hi: number): Field => {
  const arr = Array.from({ length: hi - lo + 1 }, () => false);
  const parts = expr.split(",");
  for (const part of parts) {
    const [range, stepStr] = part.includes("/") ? part.split("/") : [part, "1"];
    const step = Math.max(1, parseInt(stepStr ?? "1", 10));
    let from = lo;
    let to = hi;
    if (range && range !== "*") {
      if (range.includes("-")) {
        const [a, b] = range.split("-").map((n) => parseInt(n, 10));
        from = a!;
        to = b!;
      } else {
        from = to = parseInt(range, 10);
      }
    }
    for (let v = from; v <= to; v += step) {
      if (v >= lo && v <= hi) arr[v - lo] = true;
    }
  }
  return arr;
};

interface ParsedCron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export const parseCron = (expr: string): ParsedCron => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}" — expected 5 fields, got ${parts.length}`);
  }
  return {
    minute: makeField(parts[0]!, 0, 59),
    hour: makeField(parts[1]!, 0, 23),
    dom: makeField(parts[2]!, 1, 31),
    month: makeField(parts[3]!, 1, 12),
    dow: makeField(parts[4]!, 0, 6),
  };
};

/**
 * Returns the next UTC Date at or after `from` that satisfies the cron.
 * Increments a minute at a time — simple and fast enough (worst case ~525k
 * iterations for yearly schedules, which runs in a few ms).
 */
export const nextCronRun = (expr: string, from: Date): Date => {
  const c = parseCron(expr);
  const d = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes(),
    0,
    0,
  ));
  // advance to next minute boundary
  d.setUTCSeconds(0, 0);
  if (d.getTime() <= from.getTime()) d.setUTCMinutes(d.getUTCMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 366 * 4; i++) {
    if (
      c.minute[d.getUTCMinutes()] &&
      c.hour[d.getUTCHours()] &&
      c.dom[d.getUTCDate() - 1] &&
      c.month[d.getUTCMonth()] &&
      c.dow[d.getUTCDay()]
    ) {
      return d;
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`Cron "${expr}" yielded no runs within 4 years — check the expression`);
};
