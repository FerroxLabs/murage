// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, resolved failure-copy producer and renderer consumer.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
it("the refused-turn card retains the resolved engine name through rendering", () => {
  // Exercise the server's exact copy without importing its database/worker
  // graph into the renderer's TypeScript program.
  const dispatch = readFileSync(new URL("../../server/memory/dispatch.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("dispatch.ts", dispatch, ts.ScriptTarget.Latest, true);
  const copy = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "turnRefusedLine");
  expect(copy).toBeDefined();
  const turnRefusedLine = new Function(ts.transpile(copy!.getText(ast).replace(/^export /, ""), { target: ts.ScriptTarget.ES2022 }) + ";return turnRefusedLine;")();
  const declaration = source.split("\n").find(line => line.startsWith("const engineNameOf = "))!;
  const nameOf = new Function(ts.transpile(declaration, { target: ts.ScriptTarget.ES2022 }) + ";return engineNameOf;")();
  const resolved = { displayName: "Claude", driverKind: "claude" };
  // The card is made from the same instance dispatch uses, even when a bot's
  // saved selection points elsewhere. Both direct/room call sites use it.
  expect(source).toContain("lateMemoryRefusalLine(engineNameOf(instance))");
  expect(source).toContain("lateMemoryRefusalLine(engineNameOf(instance ?? { driverKind: bot.modelSelection.instanceId }))");
  const markup = renderToStaticMarkup(createElement(RuntimeErrorCard, {
    message: turnRefusedLine(nameOf(resolved), "not-started"), botName: "Fixture", onOpenProviderSettings() {},
  })).split("<details")[0];
  // 1.0.20 A-2: a refusal at the send is Murage's own check: the line names Murage, never the engine that had started correctly
  expect(markup).toContain("Murage couldn&#x27;t start this reply. Send it again.");
  expect(markup).not.toContain("Claude");
  expect(markup).not.toContain("Grok");
});
