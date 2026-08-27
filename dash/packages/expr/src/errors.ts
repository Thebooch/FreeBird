/**
 * Parse errors are surfaced to humans and to the authoring agent's repair
 * loop, so they carry a position and read as plain English.
 */
export class ExprParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(position >= 0 ? `${message} (at position ${position})` : message);
    this.name = "ExprParseError";
    this.position = position;
  }
}

/**
 * Thrown only when a runtime guard trips (a resource cap). Ordinary type
 * mismatches never throw — real API payloads are messy, and one null field
 * must not take down a whole dashboard. See the coercion rules in eval.ts.
 */
export class ExprEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprEvalError";
  }
}
