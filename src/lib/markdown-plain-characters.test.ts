// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Kiln & Co" typed into About me was saved as "Kiln &amp; Co" (0.1.60
// testers, rt4 L1): the pinned serializer writes every `&`, `<` and `>` as an
// HTML entity. Each surface that uses the rich editor is opened, edited and
// saved five times here through its real storage, and the text must come back
// exactly as typed every time.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { afterAll, describe, expect, it } from "vitest";

import { readAboutMe, saveAboutMe } from "../../server/about-me";
import { readHouseRules, saveHouseRules } from "../../server/house-rules";
import { richEditable } from "../components/skills/SkillEditor";
import { richEditorContent } from "../components/editor/RichMarkdownEditor";
import { createMarkdownExtensions, minimalTextEscapes, roundTripMarkdownBody } from "./markdown-fidelity";
import { skillBody } from "./skills-api";

const editors: Editor[] = [];
afterAll(() => { for (const editor of editors) editor.destroy(); });

/** Open `markdown` as RichMarkdownEditor does, type `typed` at the end, and
 *  return what its onChange hands the Save button. */
function openTypeSave(markdown: string, typed: string): string {
  expect(richEditable(markdown)).toBe(true);
  const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions({ resizableTables: true }), ...richEditorContent(markdown) });
  editors.push(editor);
  const end = Selection.atEnd(editor.state.doc).from;
  editor.view.dispatch(editor.state.tr.insertText(typed, end));
  return editor.getMarkdown();
}

describe("plain characters in the rich editor", () => {
  it("writes &, < and > as typed where Markdown gives them no meaning", () => {
    for (const text of ["Kiln & Co", "AT&T and R&D", "a < b and c > d", "5 <= 6 -> 7", "x &y z", "&"]) {
      expect(roundTripMarkdownBody(text).markdown, text).toBe(text);
    }
  });

  it("still escapes where the character would become markup or an entity", () => {
    const cases: Array<[string, string]> = [
      ["&amp;", "&amp;amp;"], // typed literally: stays the five characters
      ["&copy; &#39;", "&amp;copy; &amp;#39;"],
      ["<b>bold</b>", "&lt;b>bold&lt;/b>"],
      ["<https://x.test>", "&lt;https://x.test>"],
      ["<!-- no -->", "&lt;!-- no -->"],
    ];
    for (const [typed, markdown] of cases) {
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: typed }] }] };
      const editor = new Editor({ element: null, injectCSS: false, extensions: createMarkdownExtensions(), content: doc });
      editors.push(editor);
      expect(editor.getMarkdown(), typed).toBe(markdown);
      // And it reads back as the same text.
      expect((roundTripMarkdownBody(markdown).doc.content?.[0]?.content ?? []).map(node => node.text).join(""), typed).toBe(typed);
    }
  });

  it("keeps a > that starts a line from turning the line into a quote", () => {
    expect(minimalTextEscapes("&gt; not a quote")).toBe("&gt; not a quote");
    expect(minimalTextEscapes("one\n&gt; two")).toBe("one\n&gt; two");
    expect(minimalTextEscapes("a &gt; b")).toBe("a > b");
  });

  it("leaves code exactly as typed", () => {
    expect(roundTripMarkdownBody("Run `a && b < c`").markdown).toBe("Run `a && b < c`");
    expect(roundTripMarkdownBody("```\nx &amp; y\n```").markdown).toBe("```\nx &amp; y\n```");
  });

  it("repairs text an earlier version saved as &amp; on its next save", () => {
    expect(openTypeSave("Kiln &amp; Co", ".")).toBe("Kiln & Co.");
  });

  it("About me: & survives five save and reopen cycles", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-about-me-amp-"));
    saveAboutMe("Kiln & Co", dir);
    let expected = "Kiln & Co";
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const saved = saveAboutMe(openTypeSave(readAboutMe(dir).text, ` & ${cycle}`), dir);
      expected += ` & ${cycle}`;
      expect(saved.text, `cycle ${cycle}`).toBe(expected);
      expect(saved.chars).toBe([...expected].length);
    }
    expect(readAboutMe(dir).text).not.toContain("&amp;");
  });

  it("House rules: & survives five save and reopen cycles", () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-house-rules-amp-"));
    saveHouseRules({ text: "# Rules\n\n- Quotes & invoices go to Sam" }, dir);
    let expected = "# Rules\n\n- Quotes & invoices go to Sam";
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const saved = saveHouseRules({ text: openTypeSave(readHouseRules(dir).text, ` & ${cycle}`) }, dir);
      expected += ` & ${cycle}`;
      expect(saved.text, `cycle ${cycle}`).toBe(expected);
    }
  });

  it("Skill editor: & survives five save and reopen cycles", () => {
    const header = "---\nname: quotes\ndescription: Quotes & invoices.\n---\n";
    let file = `${header}# Quotes\n\nSend quotes & invoices on Fridays.`;
    let expected = "# Quotes\n\nSend quotes & invoices on Fridays.";
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const body = openTypeSave(skillBody(file), ` & ${cycle}`);
      file = `${header}${body}`;
      expected += ` & ${cycle}`;
      expect(skillBody(file), `cycle ${cycle}`).toBe(expected);
    }
  });
});
