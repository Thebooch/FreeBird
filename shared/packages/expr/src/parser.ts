import type { BinaryOp, ExprAst, ExprNode } from "./ast.js";
import { ExprParseError } from "./errors.js";
import { FUNCTIONS, isKnownFunction } from "./functions.js";
import { LIMITS, assertSafeKey } from "./limits.js";
import { type Token, tokenize } from "./lexer.js";

const KEYWORDS = new Set(["true", "false", "null", "in"]);

/**
 * Precedence-climbing parser. Grammar, loosest binding first:
 *
 *   or         := and ("||" and)*
 *   and        := equality ("&&" equality)*
 *   equality   := comparison (("==" | "!=") comparison)*
 *   comparison := additive (("<" | "<=" | ">" | ">=" | "in") additive)*
 *   additive   := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := unary (("*" | "/" | "%") unary)*
 *   unary      := ("!" | "-") unary | primary
 *   primary    := number | string | true | false | null
 *               | ident | ident "(" args ")" | "(" expr ")" | "[" items "]"
 *
 * There is no assignment, no member call, no lambda, and no way to introduce
 * a name. Everything the language can do is in this file and functions.ts.
 */
export const parseExpr = (source: string): ExprAst => {
  if (source.length > LIMITS.maxSourceChars) {
    throw new ExprParseError("expression is too long", -1);
  }
  const tokens = tokenize(source);

  let pos = 0;
  let nodeCount = 0;
  let depth = 0;
  const fields = new Set<string>();

  const peek = (): Token => tokens[pos] ?? { type: "eof", value: "", pos: source.length };
  const next = (): Token => {
    const token = peek();
    pos++;
    return token;
  };
  const countNode = (): void => {
    nodeCount++;
    if (nodeCount > LIMITS.maxNodes) {
      throw new ExprParseError("expression is too complex", peek().pos);
    }
  };
  const isPunct = (value: string): boolean => {
    const token = peek();
    return token.type === "punct" && token.value === value;
  };
  const eatPunct = (value: string): boolean => {
    if (!isPunct(value)) return false;
    pos++;
    return true;
  };
  const expectPunct = (value: string): void => {
    if (!eatPunct(value)) {
      throw new ExprParseError(`expected "${value}"`, peek().pos);
    }
  };
  const enter = <T>(fn: () => T): T => {
    depth++;
    if (depth > LIMITS.maxDepth) {
      throw new ExprParseError("expression is nested too deeply", peek().pos);
    }
    try {
      return fn();
    } finally {
      depth--;
    }
  };

  const binaryLevel = (
    operators: readonly string[],
    operand: () => ExprNode,
  ): (() => ExprNode) =>
    function level(): ExprNode {
      let left = operand();
      for (;;) {
        const token = peek();
        const matches =
          (token.type === "punct" || token.type === "ident") &&
          operators.includes(token.value);
        if (!matches) return left;
        // `in` is an identifier token, so guard against a field named "in".
        next();
        const right = operand();
        countNode();
        left = { kind: "binary", op: token.value as BinaryOp, left, right };
      }
    };

  const parsePrimary = (): ExprNode =>
    enter((): ExprNode => {
      const token = next();

      if (token.type === "number") {
        countNode();
        return { kind: "literal", value: token.num ?? Number(token.value) };
      }

      if (token.type === "string") {
        countNode();
        return { kind: "literal", value: token.value };
      }

      if (token.type === "punct" && token.value === "(") {
        const inner = parseOr();
        expectPunct(")");
        return inner;
      }

      if (token.type === "punct" && token.value === "[") {
        const items: ExprNode[] = [];
        if (!isPunct("]")) {
          for (;;) {
            items.push(parseOr());
            if (items.length > LIMITS.maxArrayLiteral) {
              throw new ExprParseError("list literal has too many items", token.pos);
            }
            if (!eatPunct(",")) break;
          }
        }
        expectPunct("]");
        countNode();
        return { kind: "array", items };
      }

      if (token.type === "ident") {
        if (token.value === "true" || token.value === "false") {
          countNode();
          return { kind: "literal", value: token.value === "true" };
        }
        if (token.value === "null") {
          countNode();
          return { kind: "literal", value: null };
        }

        // Function call: a bare (undotted) name followed by "(".
        if (isPunct("(") && !token.value.includes(".")) {
          if (!isKnownFunction(token.value)) {
            throw new ExprParseError(`unknown function "${token.value}"`, token.pos);
          }
          next(); // "("
          const args: ExprNode[] = [];
          if (!isPunct(")")) {
            for (;;) {
              args.push(parseOr());
              if (args.length > LIMITS.maxCallArgs) {
                throw new ExprParseError(
                  `"${token.value}" was given too many arguments`,
                  token.pos,
                );
              }
              if (!eatPunct(",")) break;
            }
          }
          expectPunct(")");
          const def = FUNCTIONS[token.value]!;
          const [min, max] = def.arity;
          if (args.length < min || args.length > max) {
            const expected = min === max ? `${min}` : `${min}–${max}`;
            throw new ExprParseError(
              `"${token.value}" takes ${expected} argument(s), got ${args.length}`,
              token.pos,
            );
          }
          countNode();
          return { kind: "call", name: token.value, args };
        }

        if (KEYWORDS.has(token.value)) {
          throw new ExprParseError(`"${token.value}" is not valid here`, token.pos);
        }

        const path = token.value.split(".");
        for (const part of path) assertSafeKey(part, token.pos);
        fields.add(path[0]!);
        countNode();
        return { kind: "field", path };
      }

      throw new ExprParseError(
        token.type === "eof" ? "expression ended unexpectedly" : `unexpected "${token.value}"`,
        token.pos,
      );
    });

  const parseUnary = (): ExprNode =>
    enter((): ExprNode => {
      if (isPunct("!") || isPunct("-")) {
        const op = next().value as "!" | "-";
        const operand = parseUnary();
        countNode();
        return { kind: "unary", op, operand };
      }
      return parsePrimary();
    });

  const parseMultiplicative = binaryLevel(["*", "/", "%"], parseUnary);
  const parseAdditive = binaryLevel(["+", "-"], parseMultiplicative);
  const parseComparison = binaryLevel(["<", "<=", ">", ">=", "in"], parseAdditive);
  const parseEquality = binaryLevel(["==", "!="], parseComparison);
  const parseAnd = binaryLevel(["&&"], parseEquality);
  const parseOr = binaryLevel(["||"], parseAnd);

  const root = parseOr();
  const trailing = peek();
  if (trailing.type !== "eof") {
    throw new ExprParseError(`unexpected "${trailing.value}" after the expression`, trailing.pos);
  }

  return { root, source, nodeCount, fields: [...fields] };
};
