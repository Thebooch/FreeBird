import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";

/**
 * A reply, as a document: the tree `markdown.ts` reads, as React elements.
 *
 * Only elements are made here — never `dangerouslySetInnerHTML` — so whatever
 * the model writes, the most it can do is be shown.
 */

const inline = (nodes: readonly Inline[]): ReactNode =>
  nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "em":
        return <em key={index}>{inline(node.children)}</em>;
      case "code":
        return (
          <code key={index} className="dash-md__code">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a key={index} className="dash-md__link" href={node.href} target="_blank" rel="noopener noreferrer">
            {inline(node.children)}
          </a>
        );
    }
  });

const block = (node: Block, index: number): ReactNode => {
  switch (node.kind) {
    case "paragraph":
      return (
        <p key={index} className="dash-md__p">
          {node.lines.map((line, row) => (
            <Fragment key={row}>
              {row > 0 && <br />}
              {inline(line)}
            </Fragment>
          ))}
        </p>
      );
    case "heading":
      // Two sizes are enough in a column: a reply's "#" and "##" read as sections, the rest as sub-sections.
      return node.level <= 2 ? (
        <h3 key={index} className="dash-md__h" data-level="1">
          {inline(node.children)}
        </h3>
      ) : (
        <h4 key={index} className="dash-md__h" data-level="2">
          {inline(node.children)}
        </h4>
      );
    case "list": {
      const items = node.items.map((item, row) => <li key={row}>{inline(item)}</li>);
      return node.ordered ? (
        <ol key={index} className="dash-md__list" start={node.start === 1 ? undefined : node.start}>
          {items}
        </ol>
      ) : (
        <ul key={index} className="dash-md__list">
          {items}
        </ul>
      );
    }
    case "code":
      return (
        <pre key={index} className="dash-md__pre">
          <code>{node.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={index} className="dash-md__rule" />;
  }
};

export const ReplyMarkdown = ({ text }: { readonly text: string }): JSX.Element => {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="dash-md">{blocks.map(block)}</div>;
};
