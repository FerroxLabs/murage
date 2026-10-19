// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receipt re-completion reads an existing attachment before reusing it
// (attachments.ts saveReceiptImage), so completeImageOutput and everything
// that completes a receipt through it is async. A call that is not awaited
// would let its caller go on (mark a row published, drop a restore hold,
// answer 200) before the completion finished or failed. Every call to these
// functions in the server source is an operand of `await`. The one
// synchronous completion, completeNewImageOutput, is reached only from
// publishAssistantImage, right after the receipt is retained, where the
// runtime event fold needs the image staged before the turn completes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = dirname(fileURLToPath(import.meta.url));
const ASYNC_COMPLETIONS = new Set([
  "saveReceiptImage", "completeImageOutput", "finishImageReceipt", "resumePendingAssistantImages", "completeReleasedReceipt",
  "completeReleased", "resumePending", "publishImage", "completeAll", "refreshPublished", "resumePendingPublications",
]);

type Site = { file: string; line: number; name: string; awaited: boolean; enclosing: string };

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** The named function the call sits in (a declaration, a method, or a
 * function expression bound to a variable or property). */
function enclosingFunction(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText();
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && (ts.isVariableDeclaration(at.parent) || ts.isPropertyAssignment(at.parent)) && ts.isIdentifier(at.parent.name)) return at.parent.name.text;
  }
  return "";
}

function sites(): Site[] {
  const found: Site[] = [];
  const files = readdirSync(SERVER, { recursive: true, encoding: "utf8" })
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("node_modules") && !name.split(/[\\/]/).includes("testing"));
  for (const file of files) {
    const text = readFileSync(join(SERVER, file), "utf8");
    if (![...ASYNC_COMPLETIONS, "completeNewImageOutput"].some(name => text.includes(name))) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name && (ASYNC_COMPLETIONS.has(name) || name === "completeNewImageOutput")) {
          let parent = node.parent;
          while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
          found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, name, awaited: ts.isAwaitExpression(parent), enclosing: enclosingFunction(node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("receipt completion is awaited by every caller", () => {
  const all = sites();

  it("finds the completion callers", () => {
    const names = new Set(all.map(site => site.name));
    for (const name of ["saveReceiptImage", "completeImageOutput", "finishImageReceipt", "resumePendingAssistantImages", "completeReleased", "resumePending", "publishImage", "completeAll", "refreshPublished", "resumePendingPublications", "completeNewImageOutput"]) {
      expect(names, name).toContain(name);
    }
    // the async completion's callers; the fifth, publishAssistantImage, takes the synchronous path
    expect(all.filter(site => site.name === "completeImageOutput").map(site => site.enclosing).sort())
      .toEqual(["completeAll", "finishImageReceipt", "publishImage", "refreshPublished"]);
  });

  it("awaits every call", () => {
    const missing = all.filter(site => ASYNC_COMPLETIONS.has(site.name) && !site.awaited).map(site => `${site.file}:${site.line} ${site.name}`);
    expect(missing).toEqual([]);
  });

  it("reaches the synchronous completion only from publishAssistantImage", () => {
    expect(all.filter(site => site.name === "completeNewImageOutput").map(site => `${site.file}:${site.enclosing}`)).toEqual(["output-publication.ts:publishAssistantImage"]);
  });
});
