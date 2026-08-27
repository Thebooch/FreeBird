export type BinaryOp =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

export type ExprNode =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "field"; readonly path: readonly string[] }
  | { readonly kind: "unary"; readonly op: "!" | "-"; readonly operand: ExprNode }
  | {
      readonly kind: "binary";
      readonly op: BinaryOp;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly ExprNode[] }
  | { readonly kind: "array"; readonly items: readonly ExprNode[] };

export interface ExprAst {
  readonly root: ExprNode;
  readonly source: string;
  readonly nodeCount: number;
  /** Every field reference the expression reads, for dependency checking. */
  readonly fields: readonly string[];
}
