// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A single line break in a reply is a line break, the way chat apps show it.
// Markdown joins such lines into one paragraph with a space, so a bot's
// "1\n2\n3" read as "1 2 3". Only text nodes change: inline code, code
// blocks and raw HTML keep their own newlines.
//
// Behaviour ported from upstream d124292a2 (OpenMausBot, MIT).

type Node = { type: string; value?: string; children?: Node[] };

export function remarkSoftBreaks() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): Node[] => {
        if (child.type !== "text" || !child.value?.includes("\n")) {
          visit(child);
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
