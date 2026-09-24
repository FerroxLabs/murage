// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "/" menu of the rich editor: its 13 items, their filtering, what each
// command does to the document, and that a document built with them saves
// as Markdown the fidelity check accepts for rich editing on the next open.
// Node environment: the editor is headless, as in markdown-fidelity.test.ts.
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeMarkdownFidelity, createMarkdownExtensions, EMPTY_MARKDOWN_DOC } from "@/lib/markdown-fidelity";
import { filterSlashItems, SLASH_ITEMS, type SlashItem } from "./slashMenu";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()?.destroy(); });

function newEditor(): Editor {
  const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions({ resizableTables: true }), content: EMPTY_MARKDOWN_DOC });
  editors.push(editor);
  return editor;
}

function item(label: string): SlashItem {
  const found = SLASH_ITEMS.find(entry => entry.label === label);
  if (!found) throw new Error(`no slash item ${label}`);
  return found;
}

/** Type "/" at the end of the document as a new block, then run the item on
 *  the "/" range, as the Suggestion plugin does. */
function runSlash(editor: Editor, label: string) {
  const end = editor.state.doc.content.size;
  const lastIsEmpty = editor.state.doc.lastChild?.type.name === "paragraph" && editor.state.doc.lastChild.content.size === 0;
  if (!lastIsEmpty) editor.chain().insertContentAt(end, { type: "paragraph" }).run();
  const at = editor.state.doc.content.size - 1;
  editor.chain().setTextSelection(at).insertContent(text("/")).run();
  item(label).action({ editor, range: { from: at, to: at + 1 } });
}

/** Text as JSON: a string would be parsed as HTML, which needs a DOM. */
const text = (value: string) => ({ type: "text", text: value });

function type(editor: Editor, value: string) {
  editor.chain().insertContent({ type: "text", text: value }).run();
}

describe("the slash menu items", () => {
  it("has the 13 commands of the Wayland editor, in order", () => {
    expect(SLASH_ITEMS.map(entry => entry.label)).toEqual([
      "Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Task list",
      "Quote", "Code block", "Inline code", "Divider", "Table", "Bulleted list (nested)",
    ]);
    for (const entry of SLASH_ITEMS) {
      expect(entry.description).not.toMatch(/\u2014/);
      expect(entry.keywords.length).toBeGreaterThan(0);
    }
  });

  it("shows every item for an empty query and filters by label or keyword", () => {
    expect(filterSlashItems("")).toHaveLength(13);
    expect(filterSlashItems("todo").map(entry => entry.label)).toEqual(["Task list"]);
    expect(filterSlashItems("h2").map(entry => entry.label)).toEqual(["Heading 2"]);
    expect(filterSlashItems("HEAD").map(entry => entry.label)).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(filterSlashItems("hr").map(entry => entry.label)).toContain("Divider");
    expect(filterSlashItems("zzz")).toEqual([]);
  });
});

describe("each slash command", () => {
  const cases: Array<[string, string]> = [
    ["Heading 1", "heading"],
    ["Heading 2", "heading"],
    ["Heading 3", "heading"],
    ["Bulleted list", "bulletList"],
    ["Numbered list", "orderedList"],
    ["Task list", "taskList"],
    ["Quote", "blockquote"],
    ["Code block", "codeBlock"],
    ["Divider", "horizontalRule"],
    ["Table", "table"],
    ["Bulleted list (nested)", "bulletList"],
    ["Text", "paragraph"],
  ];
  for (const [label, node] of cases) {
    it(`${label} removes the "/" and makes a ${node}`, () => {
      const editor = newEditor();
      runSlash(editor, label);
      expect(editor.getText()).not.toContain("/");
      const types: string[] = [];
      editor.state.doc.descendants(child => { types.push(child.type.name); });
      expect(types).toContain(node);
      if (label.startsWith("Heading ")) {
        expect(editor.state.doc.firstChild?.attrs.level).toBe(Number(label.slice(-1)));
      }
    });
  }

  it("Inline code turns the next typed text into code", () => {
    const editor = newEditor();
    runSlash(editor, "Inline code");
    type(editor, "npm test");
    expect(editor.getMarkdown()).toBe("`npm test`");
  });
});

describe("a document built with the slash commands", () => {
  function build(): string {
    const editor = newEditor();
    runSlash(editor, "Heading 1"); type(editor, "Weekly plan");
    runSlash(editor, "Text"); type(editor, "What happens this week.");
    runSlash(editor, "Heading 2"); type(editor, "Errands");
    runSlash(editor, "Bulleted list"); type(editor, "Call the bank");
    editor.chain().splitListItem("listItem").insertContent(text("Pay the rent")).run();
    editor.chain().sinkListItem("listItem").run();
    runSlash(editor, "Numbered list"); type(editor, "First");
    editor.chain().splitListItem("listItem").insertContent(text("Second")).run();
    runSlash(editor, "Task list"); type(editor, "Send the invoice");
    editor.chain().splitListItem("taskItem").insertContent(text("Chase the reply")).run();
    editor.chain().sinkListItem("taskItem").run();
    runSlash(editor, "Quote"); type(editor, "Keep it short.");
    runSlash(editor, "Code block"); type(editor, "pnpm test");
    runSlash(editor, "Divider");
    runSlash(editor, "Heading 3"); type(editor, "Notes");
    return editor.getMarkdown();
  }

  it("serializes to the Markdown you would write by hand", () => {
    expect(build()).toBe([
      "# Weekly plan",
      "",
      "What happens this week.",
      "",
      "## Errands",
      "",
      "- Call the bank",
      "  - Pay the rent",
      "",
      "1. First",
      "2. Second",
      "",
      "- [ ] Send the invoice",
      "  - [ ] Chase the reply",
      "",
      "> Keep it short.",
      "",
      "```",
      "pnpm test",
      "```",
      "",
      "---",
      "",
      "### Notes",
    ].join("\n"));
  });

  it("opens rich again: the fidelity check reproduces it byte for byte", () => {
    const markdown = `${build()}\n`;
    const report = analyzeMarkdownFidelity(markdown);
    expect(report.unsupportedTokenClasses).toEqual([]);
    expect(report.reasons).toEqual([]);
    expect(report.richEditable).toBe(true);
  });

  it("a table from the menu saves as a Markdown table; the file then opens in Source mode, never re-padded silently", () => {
    const editor = newEditor();
    runSlash(editor, "Heading 2"); type(editor, "Prices");
    runSlash(editor, "Table");
    type(editor, "Item");
    const markdown = editor.getMarkdown();
    expect(markdown).toMatch(/^## Prices\n\n+\| Item +\| +\| +\|\n\| -+ \| -+ \| -+ \|\n(\| +\| +\| +\|\n){2}$/);
    // @tiptap/markdown 3.31.3 pads cells and adds blank lines around a
    // table, so tables stay outside the rich set (see source-table.md in
    // the fidelity corpus): the gate sends the file to Source mode.
    const report = analyzeMarkdownFidelity(`${markdown}\n`);
    expect(report.unsupportedTokenClasses).toEqual(["table"]);
    expect(report.richEditable).toBe(false);
  });
});
