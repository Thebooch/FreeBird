import { tokenize } from "./lexer.js";

/** Rename field tokens while leaving quoted values and function names untouched. */
export const renameExprFields = (
  source: string,
  names: Readonly<Record<string, string>>,
): string => {
  const tokens = tokenize(source);
  let out = source;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index]!;
    if (token.type !== "ident" || tokens[index + 1]?.value === "(") continue;
    const replacement = names[token.value];
    if (replacement)
      out = out.slice(0, token.pos) + replacement + out.slice(token.pos + token.value.length);
  }
  return out;
};
