// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A reply that is only a number and a full stop ("391.") is, to Markdown, an
// ordered list holding one empty item that starts at 391. The bubble drew it
// as "1." with nothing after it. A list whose items are all empty carries no
// list content, so it goes back to being the text the bot wrote.
//
// The structural types below are the slice of mdast this plugin touches; the
// mdast packages are not direct dependencies, so their types are not imported.

type Point = { offset?: number };
type Node = {
  type: string;
  ordered?: boolean | null;
  children?: Node[];
  value?: string;
  position?: { start: Point; end: Point };
};

const isEmptyOrderedList = (node: Node): boolean =>
  node.type === "list" && node.ordered === true && (node.children?.length ?? 0) > 0 &&
  node.children!.every(item => (item.children?.length ?? 0) === 0);

export function remarkLoneListNumbers() {
  return (tree: Node, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const visit = (parent: Node) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index++) {
        const node = children[index]!;
        if (isEmptyOrderedList(node)) {
          const start = node.position?.start.offset, end = node.position?.end.offset;
          if (start === undefined || end === undefined) continue;
          const raw = source.slice(start, end).trim().split(/\s*\n\s*/).join(" ");
          children[index] = { type: "paragraph", children: [{ type: "text", value: raw }], position: node.position };
          continue;
        }
        visit(node);
      }
    };
    visit(tree);
  };
}
