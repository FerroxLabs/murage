// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { repairMarkdownTables } from "./markdown-tables";

it.each([
  "```text\r\n| A | B |\r\n| 1 | 2 |\r\n```\r\n",
  "~~~~text\n| A | B |\n| 1 | 2 |\n~~~~\n",
  "`````text\n```\n| A | B |\n| 1 | 2 |\n`````\n",
  "```\n| A | B |\n| 1 | 2 |",
  "    | A | B |\n    | 1 | 2 |\n",
  "| A | B |\r\n| :--- | ---: |\r\n| 1 | 2 |\r\n",
  "One | two\nThree | four\n",
])("leaves complete tables, code and ambiguous prose byte for byte: %s", text => {
  expect(repairMarkdownTables(text)).toBe(text);
});
it("keeps CRLF, escaped pipes and all original rows when inserting a separator", () => {
  const header = "| A \\| alias | B |\r\n";
  const body = "| 1 | 2\\| |\r\n| 3 | 4 |\r\n";
  expect(repairMarkdownTables(header + body)).toBe(header + "| --- | --- |\r\n" + body);
});
it("keeps alignment while restoring an inner separator pipe", () => {
  expect(repairMarkdownTables("| A | B |\n| :--- ---: |\n| 1 | 2 |"))
    .toBe("| A | B |\n| :--- | ---: |\n| 1 | 2 |");
});
it("is stable after repair and does not insert separators into body rows", () => {
  const text = "| A | B |\n| 1 | 2 |\n| 3 | 4 |\n\n| C | D |\n| 5 | 6 |";
  const repaired = repairMarkdownTables(text);
  expect(repaired.match(/\| --- \| --- \|/g)).toHaveLength(2);
  expect(repairMarkdownTables(repaired)).toBe(repaired);
});
it.each([
  "| A | B |\n| 1 | 2 |\n| 3 | 4 | IMPORTANT |",
  "| A | B |\n| 1 | 2 |\n3 | 4 | IMPORTANT",
  "| A | B |\n| --- --- |\n| 1 | 2 |\n| 3 | 4 | IMPORTANT |",
])("preserves the whole candidate when a later row overflows: %s", text => {
  expect(repairMarkdownTables(text)).toBe(text);
});
it.each(["-", ":-", "-:", ":-:", "--"])("preserves valid short delimiters: %s", delimiter => {
  const text = `| A | B |\n| ${delimiter} | ${delimiter} |\n| 1 | 2 |`;
  expect(repairMarkdownTables(text)).toBe(text);
});
it.each([
  "- ```text\n  | A | B |\n  | 1 | 2 |\n  ``` ",
  "1. ~~~text\r\n   | A | B |\r\n   | 1 | 2 |\r\n   ~~~\r\n",
  "- item\n  - ````text\n    | A | B |\n    | 1 | 2 |\n    ````",
  "> - ```text\n>   | A | B |\n>   | 1 | 2 |\n>   ```",
])("preserves container fences byte for byte: %s", text => {
  expect(repairMarkdownTables(text)).toBe(text);
  const following = "\n\n| C | D |\n| 3 | 4 |";
  expect(repairMarkdownTables(text + following)).toBe(text + "\n\n| C | D |\n| --- | --- |\n| 3 | 4 |");
});
