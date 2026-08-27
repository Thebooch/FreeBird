import type { ExprAst, ExprNode } from "./ast.js";
import { type EvalContext, FUNCTIONS, guardStringLength, toNumber } from "./functions.js";
import { readProp } from "./limits.js";

/**
 * Truthiness follows JavaScript: null, undefined, false, 0, NaN and "" are
 * falsy, everything else is truthy.
 */
export const truthy = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  return true;
};

/**
 * Equality is strict. Real payloads mix `"0"` and `0` constantly, and loose
 * comparison there produces filters that look right and silently aren't —
 * exactly the class of bug this whole design is trying to avoid. Coerce
 * explicitly in the pipeline's `coerce` step instead.
 */
const strictEquals = (a: unknown, b: unknown): boolean => {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === null || right === null) return left === right;
  return left === right;
};

const compare = (op: "<" | "<=" | ">" | ">=", a: unknown, b: unknown): boolean => {
  let left: number | string;
  let right: number | string;

  if (typeof a === "string" && typeof b === "string") {
    left = a;
    right = b;
  } else {
    const na = toNumber(a);
    const nb = toNumber(b);
    // A comparison against a missing or non-numeric value is false, never an
    // error — one ragged row must not fail the whole widget.
    if (na === null || nb === null) return false;
    left = na;
    right = nb;
  }

  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
};

const arithmetic = (op: "+" | "-" | "*" | "/" | "%", a: unknown, b: unknown): unknown => {
  if (op === "+" && (typeof a === "string" || typeof b === "string")) {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    return guardStringLength(String(a) + String(b));
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na === null || nb === null) return null;
  switch (op) {
    case "+":
      return na + nb;
    case "-":
      return na - nb;
    case "*":
      return na * nb;
    case "/":
      return nb === 0 ? null : na / nb;
    case "%":
      return nb === 0 ? null : na % nb;
  }
};

const inOperator = (needle: unknown, haystack: unknown): boolean => {
  if (Array.isArray(haystack)) return haystack.some((item) => strictEquals(item, needle));
  if (typeof haystack === "string" && typeof needle === "string") {
    return haystack.includes(needle);
  }
  return false;
};

const evalNode = (node: ExprNode, row: unknown, ctx: EvalContext): unknown => {
  switch (node.kind) {
    case "literal":
      return node.value;

    case "field": {
      let current: unknown = row;
      for (const key of node.path) {
        current = readProp(current, key);
        if (current === undefined) return null;
      }
      return current === undefined ? null : current;
    }

    case "unary": {
      const operand = evalNode(node.operand, row, ctx);
      if (node.op === "!") return !truthy(operand);
      const n = toNumber(operand);
      return n === null ? null : -n;
    }

    case "binary": {
      // Short-circuit before evaluating the right side.
      if (node.op === "&&") {
        return truthy(evalNode(node.left, row, ctx))
          ? truthy(evalNode(node.right, row, ctx))
          : false;
      }
      if (node.op === "||") {
        return truthy(evalNode(node.left, row, ctx))
          ? true
          : truthy(evalNode(node.right, row, ctx));
      }

      const left = evalNode(node.left, row, ctx);
      const right = evalNode(node.right, row, ctx);

      switch (node.op) {
        case "==":
          return strictEquals(left, right);
        case "!=":
          return !strictEquals(left, right);
        case "<":
        case "<=":
        case ">":
        case ">=":
          return compare(node.op, left, right);
        case "in":
          return inOperator(left, right);
        default:
          return arithmetic(node.op, left, right);
      }
    }

    case "call": {
      const def = FUNCTIONS[node.name];
      if (!def) return null; // unreachable — the parser rejects unknown names
      const args = node.args.map((arg) => evalNode(arg, row, ctx));
      return def.call(args, ctx);
    }

    case "array":
      return node.items.map((item) => evalNode(item, row, ctx));
  }
};

export const evalExpr = (ast: ExprAst, row: unknown, ctx: EvalContext): unknown =>
  evalNode(ast.root, row, ctx);

/** Convenience for `filter`, which only cares about truthiness. */
export const evalPredicate = (ast: ExprAst, row: unknown, ctx: EvalContext): boolean =>
  truthy(evalNode(ast.root, row, ctx));
