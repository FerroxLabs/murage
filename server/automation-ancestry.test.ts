// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  _resetAutomationAncestryForTest, automationAncestry, automationAncestryAt, configureAutomationAncestryFile, recordAutomationAncestry,
  recordRequestAncestry, requestAutomationAncestry, threadAutomationAncestry,
} from "./automation-ancestry.ts";

const dirs: string[] = [];
function ledgerFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ancestry-"));
  dirs.push(dir);
  return join(dir, "automation-ancestry.json");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

afterEach(() => _resetAutomationAncestryForTest());

it("reads any carried routine, wake or unattended hop as automation", () => {
  expect(automationAncestry({ automationThread: false, threadId: "t" })).toBe(false);
  for (const carried of [
    { automationThread: true }, { carried: true }, { unattended: true }, { automationSource: "schedule" }, { routineRunId: "r" },
    { routineAuthority: { permissionMode: "ask" } }, { decisionRoutineSource: {} }, { routineWake: true }, { askerWakeCeiling: "ask" },
  ]) expect(automationAncestry({ automationThread: false, threadId: "t", ...carried }), JSON.stringify(carried)).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "t", unattended: false, routineWake: false })).toBe(false);
});

it("inherits the chain root's record and fails closed on a root with none", () => {
  expect(automationAncestry({ automationThread: false, threadId: "t", chainRootThreadId: "unknown-root" })).toBe(true);
  recordAutomationAncestry("owner-root", false);
  recordAutomationAncestry("routine-root", true);
  expect(automationAncestry({ automationThread: false, threadId: "t", chainRootThreadId: "owner-root" })).toBe(false);
  expect(automationAncestry({ automationThread: false, threadId: "t", chainRootThreadId: "routine-root" })).toBe(true);
});

it("keeps a thread's automation record for its retries, never for a fresh turn", () => {
  recordAutomationAncestry("t", true);
  expect(automationAncestry({ automationThread: false, threadId: "t", rerun: true })).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "t" })).toBe(false);
  recordAutomationAncestry("t", false);
  expect(threadAutomationAncestry("t")).toBe(false);
  expect(automationAncestry({ automationThread: false, threadId: "t", rerun: true })).toBe(false);
});

// Fable H2 / Astra 2: a re-run or continuation with no record (a restart without the ledger, a thread this process never saw) fails closed.
it("fails closed on a re-run whose thread has no record", () => {
  expect(automationAncestry({ automationThread: false, threadId: "never-seen", rerun: true })).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "never-seen", rerun: true, rerunAt: Date.now() })).toBe(true);
});

// Fable M3: a continuation is judged by the turn that posted its card, not by a later owner turn on the same thread.
it("judges a card continuation by the turn running when the card was posted", () => {
  recordAutomationAncestry("t", true, 1_000);
  recordAutomationAncestry("t", false, 2_000);
  expect(automationAncestryAt("t", 1_500)).toBe(true);
  expect(automationAncestryAt("t", 2_500)).toBe(false);
  expect(automationAncestryAt("t", 500)).toBeUndefined();
  expect(automationAncestry({ automationThread: false, threadId: "t", rerun: true, rerunAt: 1_500 })).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "t", rerun: true, rerunAt: 2_500 })).toBe(false);
  // a card older than the ledger reaches counts as automation
  expect(automationAncestry({ automationThread: false, threadId: "t", rerun: true, rerunAt: 500 })).toBe(true);
});

// Fable H2 / Astra 2: the ledger survives a restart, so an owner chain stays an owner chain and a routine chain stays one.
it("keeps every record across a restart, and a damaged ledger reads as automation", () => {
  const file = ledgerFile();
  configureAutomationAncestryFile(file);
  recordAutomationAncestry("routine-handoff", true, 1_000);
  recordAutomationAncestry("owner-root", false, 1_000);
  recordRequestAncestry("ask-1", true);
  recordRequestAncestry("ask-1", false);
  _resetAutomationAncestryForTest();
  expect(threadAutomationAncestry("routine-handoff")).toBeUndefined();
  configureAutomationAncestryFile(file);
  expect(automationAncestry({ automationThread: false, threadId: "routine-handoff", rerun: true })).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "x", chainRootThreadId: "owner-root" })).toBe(false);
  // a request mark is never lowered
  expect(requestAutomationAncestry("ask-1")).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).v).toBe(1);
  writeFileSync(file, "{not json");
  configureAutomationAncestryFile(file);
  expect(automationAncestry({ automationThread: false, threadId: "x", chainRootThreadId: "owner-root" })).toBe(true);
  expect(automationAncestry({ automationThread: false, threadId: "routine-handoff", rerun: true })).toBe(true);
});
