// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const file = new URL("./browser-surface.cjs", import.meta.url);
const source = readFileSync(file, "utf8");
// Execute the shipped isolated-world expression with DOM doubles, without
// exporting private browser internals or opening a real browser profile.
const module = { exports: {} };
new Function("require", "module", "exports", "__dirname", source + "\nmodule.exports.pageExpression = PAGE_TEXT_EXPRESSION;")(
  createRequire(file), module, module.exports, dirname(fileURLToPath(file)),
);

it("merges crossing protected field values across elements in page text", () => {
  const ownerDocument = { querySelectorAll: () => [], getElementById: () => null };
  const field = value => ({ tagName: "INPUT", type: "password", value, innerText: value, textContent: value,
    children: [], labels: [], ownerDocument, getAttribute: () => null, closest: () => null });
  const body = { tagName: "BODY", innerText: "abc" + "def", children: [field("ab" + "cd"), field("cd" + "ef")], getAttribute: () => null };
  expect(runInNewContext(module.exports.pageExpression, { document: { body } })).toBe("[redacted]");
});
