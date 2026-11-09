// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS r12 re-baseline helpers (MurageMain ruling 11-07, item 1). Since r10 the raw strict reader keeps a closed-list
// doubt over a deferred protected-path hit, so it answers `unreadable` where the doubt-free read (Full access, and the
// owner's own No limits turn) names `protected-path`. A row moved to these helpers asserts the doubt-free answer AND
// that nothing got weaker: the strict read still cards, the verdict cards at Ask, Auto, Full access and No limits, and
// Full access still names protected-path. A row that wanted no card asserts that the doubt-free read is clean, that the
// strict read adds at most a closed-list doubt, and that Auto, Full access and the owner's No limits turn give no card.
// Import it after the file's own vi.resetModules() (await import) so that it reads the same HOME as the file.
import { expect } from "vitest";
import { alwaysAskCommand } from "../always-ask.ts";
import { autoVerdict, type AutoContext } from "../auto-approve.ts";
import { withoutDoubts } from "../shell/marks.ts";

type Shell = "pwsh" | undefined;
const LEVELS: Array<[string, Parameters<typeof autoVerdict>[0]]> = [
  ["Ask", { id: "marks-r12-ask" }],
  ["Auto", { id: "marks-r12-auto", autoApprove: true }],
  ["Full access", { id: "marks-r12-full", autoApprove: true, fullAccess: true }],
  ["No limits", { id: "marks-r12-nolimits", autoApprove: true, fullAccess: true, noLimits: true }],
];
const strictRead = (cmd: string, cwd?: string, shell?: Shell) => alwaysAskCommand(cmd, cwd, "command", shell);
/** The doubt-free read: what Full access and the owner's own No limits turn read. */
export const doubtFree = (cmd: string, cwd?: string, shell?: Shell) => withoutDoubts(() => strictRead(cmd, cwd, shell));
export const doubtFreeRule = (cmd: string, cwd?: string, shell?: Shell) => doubtFree(cmd, cwd, shell)?.rule ?? null;
/** The verdict on the owner's own clean turn at each level. */
function verdicts(cmd: string, cwd?: string, shell?: Shell) {
  const context = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: cmd, commandCwd: cwd } as unknown as AutoContext;
  return LEVELS.map(([level, bot]) => [level, autoVerdict(bot, shell === "pwsh" ? "PowerShell" : "Bash", cmd, context)] as const);
}
/** A protected-path row: the doubt-free read names it, the strict read cards, every level cards, Full access names it. */
export function expectProtectedPath(cmd: string, cwd?: string, shell?: Shell): void {
  expect(doubtFreeRule(cmd, cwd, shell), `doubt-free read of ${JSON.stringify(cmd)}`).toBe("protected-path");
  expect(strictRead(cmd, cwd, shell), `strict read of ${JSON.stringify(cmd)} cards`).not.toBeNull();
  for (const [level, verdict] of verdicts(cmd, cwd, shell)) {
    expect(verdict.approve, `${level} cards ${JSON.stringify(cmd)}`).toBeNull();
    if (level === "Full access") expect(verdict, `Full access names protected-path for ${JSON.stringify(cmd)}`).toMatchObject({ source: "always-ask", rule: "protected-path" });
  }
}
/** MARKS r13 (Astra M4): a row whose doubt-free read is itself a reader card, not a named rule: the strict read cards and
 * every level (Ask, Auto, Full access, No limits) cards. */
export function expectCardsEverywhere(cmd: string, cwd?: string, shell?: Shell): void {
  expect(doubtFree(cmd, cwd, shell), `doubt-free read of ${JSON.stringify(cmd)} cards`).not.toBeNull();
  expect(strictRead(cmd, cwd, shell), `strict read of ${JSON.stringify(cmd)} cards`).not.toBeNull();
  for (const [level, verdict] of verdicts(cmd, cwd, shell)) expect(verdict.approve, `${level} cards ${JSON.stringify(cmd)}`).toBeNull();
}
/** The reader part of an ordinary row: the doubt-free read is clean; the strict read adds at most a closed-list doubt. */
export function expectReaderOrdinary(cmd: string, cwd?: string, shell?: Shell, note?: string): void {
  expect(doubtFree(cmd, cwd, shell), note ?? `doubt-free read of ${JSON.stringify(cmd)}`).toBeNull();
  const strict = strictRead(cmd, cwd, shell);
  if (strict) expect(strict, note ?? `strict read of ${JSON.stringify(cmd)} adds only a closed-list doubt`).toMatchObject({ rule: "unreadable", doubt: expect.any(String) });
}
/** An ordinary row: the reader part, and no card at Auto, Full access or on the owner's own No limits turn. */
export function expectOrdinary(cmd: string, cwd?: string, shell?: Shell, note?: string): void {
  expectReaderOrdinary(cmd, cwd, shell, note);
  for (const [level, verdict] of verdicts(cmd, cwd, shell)) {
    if (level === "Ask") continue;
    expect(verdict.source, `${level} gives ${JSON.stringify(cmd)} no reader card${note ? ` (${note})` : ""}`).not.toBe("always-ask");
  }
}
