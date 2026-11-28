// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A single line break in a reply is a line break, the way chat apps show it.
// Markdown joins such lines into one paragraph with a space, so a bot's
// "1\n2\n3" read as "1 2 3". Only text nodes change: inline code, code
// blocks keep their own newlines. Table cells also accept an attribute-free <br>.
//
// Behaviour ported from upstream d124292a2 (OpenMausBot, MIT).

type Node = { type: string; value?: string; children?: Node[] };

export function remarkSoftBreaks() {
  return (tree: Node) => {
    const visit = (node: Node, inCell = false) => {
      if (!node.children) return;
      const tableCell = inCell || node.type === "tableCell";
      node.children = node.children.flatMap((child): Node[] => {
        if (tableCell && child.type === "html" && /^<br\s*\/?>$/i.test(child.value ?? "")) {
          return [{ type: "break" }];
        }
        if (child.type !== "text" || !child.value?.includes("\n")) {
          visit(child, tableCell);
          return [child];
        }
        return child.value.split("\n").flatMap((value, index): Node[] => [
          ...(index ? [{ type: "break" }] : []),
          ...(value ? [{ type: "text", value }] : []),
        ]);
      });
    };
    visit(tree);
  };
}
