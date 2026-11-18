// SPDX-License-Identifier: AGPL-3.0-or-later
// G0 LLA+ (r4 item 7), STRUCTURAL guard: the Chief proposal turn (runChiefProposalTurn) never stops a turn its ledger lease refused. The
// refused lease owns the one close (LLS/LLA: no second interruptTurn, no reset of a process not confirmed gone), so each of the function's
// own engine stops (the late hand-back stop and the finally stop + resetSession) and its closeTurnLineage run only when !proposalLease.verdict.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { fixtureFunctionSource } from "./testing/runtime-source-fixture.ts";

const body = fixtureFunctionSource(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), "runChiefProposalTurn");
const file = ts.createSourceFile("proposal.ts", body, ts.ScriptTarget.Latest, true);
/** True when an enclosing `if` whose condition requires !proposalLease.verdict holds the node in its then-branch. */
const guarded = (node: ts.Node): boolean => {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent)
    if (ts.isIfStatement(parent) && parent.thenStatement === child && /(^|&&\s*|\(\s*)!proposalLease\.verdict\b/.test(parent.expression.getText(file))) return true;
  return false;
};

it("LLA+: every engine stop and the lineage close of the Chief proposal turn sit under !proposalLease.verdict", () => {
  expect(body).toContain("admitLedgerLease(");
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); };
  visit(file);
  const stops = calls.filter(c => /^instance\.adapter\.(interruptTurn|resetSession)$/.test(c.expression.getText(file)));
  const lineage = calls.filter(c => c.getText(file) === "closeTurnLineage(proposalTurn)");
  expect([stops.length, lineage.length], "reached: the late hand-back stop, the finally stop, its reset, and the lineage close").toEqual([3, 1]);
  for (const call of [...stops, ...lineage]) expect(guarded(call), call.getText(file).slice(0, 80)).toBe(true);
});
