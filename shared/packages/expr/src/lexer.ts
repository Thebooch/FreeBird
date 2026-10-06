import { ExprParseError } from "./errors.js";

export type TokenType = "number" | "string" | "ident" | "punct" | "eof";

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly num?: number;
  readonly pos: number;
}

/** Longest-first so `<=` never lexes as `<` then `=`. */
const PUNCT = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "(",
  ")",
  "[",
  "]",
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
] as const;

const isIdentStart = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";

const isIdentChar = (ch: string): boolean => isIdentStart(ch) || (ch >= "0" && ch <= "9");

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

export const tokenize = (src: string): Token[] => {
  const at = (i: number): string => src[i] ?? "";
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = at(i);

    if (isSpace(ch)) {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(at(i + 1)))) {
      const start = i;
      while (i < src.length && isDigit(at(i))) i++;
      if (at(i) === ".") {
        i++;
        while (i < src.length && isDigit(at(i))) i++;
      }
      if (at(i) === "e" || at(i) === "E") {
        const save = i;
        i++;
        if (at(i) === "+" || at(i) === "-") i++;
        if (isDigit(at(i))) {
          while (i < src.length && isDigit(at(i))) i++;
        } else {
          i = save;
        }
      }
      const text = src.slice(start, i);
      tokens.push({ type: "number", value: text, num: Number(text), pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < src.length && at(i) !== ch) {
        if (at(i) === "\\" && i + 1 < src.length) {
          const esc = at(i + 1);
          value +=
            esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
          i += 2;
          continue;
        }
        value += at(i);
        i++;
      }
      if (i >= src.length) throw new ExprParseError("unterminated string", start);
      i++; // closing quote
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      // Dotted identifiers lex as one token: `customer.email` is a single
      // field reference, not a member access on an arbitrary expression.
      while (i < src.length) {
        while (i < src.length && isIdentChar(at(i))) i++;
        if (at(i) === "." && isIdentStart(at(i + 1))) {
          i++;
          continue;
        }
        break;
      }
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
      continue;
    }

    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      tokens.push({ type: "punct", value: punct, pos: i });
      i += punct.length;
      continue;
    }

    throw new ExprParseError(`unexpected character "${ch}"`, i);
  }

  tokens.push({ type: "eof", value: "", pos: src.length });
  return tokens;
};
