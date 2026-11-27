// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

const draw = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
it("renders a header and body with no separator as a table", () => {
  const html = draw("| Name | Count |\n| Apples | 2 |");
  expect(html).toContain("<table");
  expect(html).toContain("<th");
  expect(html).toContain("Apples</td>");
});
it.each(["| --- --- |", "--- | --- |", "| --- | ---", "| :--- ---: |"])("repairs a separator with a missing pipe: %s", separator => {
  const html = draw(`| Name | Count |\n${separator}\n| Apples | 2 |`);
  expect(html).toContain("<table");
  expect(html).toContain("Apples</td>");
  expect(html).not.toContain("---");
});
it("keeps escaped pipes in their cells when inserting a separator", () => {
  const html = draw("| Name \\| alias | Count |\n| Apples \\| fruit | 2 |");
  expect(html).toContain("<table");
  expect(html.match(/<th(?: |>)/g)).toHaveLength(2);
  expect(html.match(/<td(?: |>)/g)).toHaveLength(2);
  expect(html).toContain("Name | alias</th>");
  expect(html).toContain("Apples | fruit</td>");
});
it.each(["```text\n", "~~~~\n", "`````text\n```\n"])("keeps pipes in fenced code unchanged: %s", opener => {
  const text = "| Name | Count |\n| Apples | 2 |";
  const html = draw(opener + text + "\n" + (opener.startsWith("~") ? "~~~~" : opener.startsWith("`````") ? "`````" : "```"));
  expect(html).not.toContain("<table");
  expect(html).toContain(text);
});
it("leaves indented code and prose with pipes alone", () => {
  for (const text of ["    | Name | Count |\n    | Apples | 2 |", "Use a | b in the command.\nThen c | d.", "| One row | alone |", "| A | B |\n| Different | column | count |"])
    expect(draw(text)).not.toContain("<table");
});
it("keeps an ordinary table and escaped trailing pipe readable", () => {
  expect(draw("| Name | Count |\n| --- | --- |\n| Apples | 2 |")).toContain("Apples</td>");
  expect(draw("| A | B |\n| One | two\\| | ")).toContain("two|</td>");
});
it.each(["| 3 | 4 | IMPORTANT |", "3 | 4 | IMPORTANT"])("keeps overflowing content visible: %s", tail => {
  const html = draw(`| A | B |\n| 1 | 2 |\n${tail}`);
  expect(html).toContain("IMPORTANT");
  expect(html).not.toContain("<table");
});
it("renders short delimiters as structure rather than extra data", () => {
  const html = draw("| A | B |\n| - | - |\n| 1 | 2 |");
  expect(html.match(/<tr>/g)).toHaveLength(2);
  expect(html).not.toContain("-</td>");
});
it("keeps a list-contained fence and its table-like code intact", () => {
  const html = draw("- ```text\n  | A | B |\n  | 1 | 2 |\n  ``` ");
  // MAIN RULING 1114-AFIX-CHAT-LIST-MARKUP: accept attributes while retaining list structure and source bytes.
  const list = html.match(/<ul(?:\s[^>]*)?>([\s\S]*?)<\/ul>/)?.[1];
  expect(list).toBeDefined();
  const items = [...(list?.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g) ?? [])];
  expect(items).toHaveLength(1);
  expect(items[0]?.[1]).toMatch(/<pre(?:\s[^>]*)?>\| A \| B \|\n\| 1 \| 2 \|<\/pre>/);
  expect(html).toContain("| A | B |\n| 1 | 2 |");
  expect(html).not.toContain("| --- | --- |");
  expect(html).not.toContain("<table");
});

it.each(["<br>", "<BR />", "<br/>"])("renders %s as a line break in a table cell", tag => {
  const html = draw(`| Label | Reply |\n| --- | --- |\n| Plan | First${tag}Second |`);
  expect(html).toMatch(/First<br\/?>(?:\n)?Second<\/td>/);
});

it("keeps ordinary inline markup and code literal", () => {
  const html = draw('| Label | Reply |\n| --- | --- |\n| Plan | First<br class="spacing">Second |\n| Code | `<br>` |');
  expect(html).toContain("First&lt;br class=&quot;spacing&quot;&gt;Second");
  expect(html).toContain("&lt;br&gt;</code>");
  expect(html).not.toMatch(/<br\b/);
  expect(draw("First<br>Second")).toContain("First&lt;br&gt;Second");
});
