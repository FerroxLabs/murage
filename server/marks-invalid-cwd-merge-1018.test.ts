// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS merge of A and B, server/index.ts wholeCommand: a command folder that is unknown or conflicting reaches auto-approval as
// commandCwd "" plus commandCwdInvalid true. It must fail closed at auto-approve.ts (cwd = invalid ? "" : ...): no auto-approve at
// any level, on any turn kind, and the owner is shown the card. The flag alone must be enough (a stale valid commandCwd beside it).
import { describe, expect, it } from "vitest";
import { approvalKey, autoVerdict, type AutoContext } from "./auto-approve.ts";
import { exactCommandKey } from "../shared/exact-command.ts";
import { expectNoLimitsOwnerOutcome } from "./testing/no-limits-1019.ts";

const levels = [
  { id: "ask" }, { id: "auto", autoApprove: true },
  { id: "full", autoApprove: true, fullAccess: true },
  { id: "owner", autoApprove: true, fullAccess: true, noLimits: true },
];
const contexts = [{}, { ownerStarted: false }, { routineLevel: true, routineCarveOut: true, automated: true },
  { unattended: true }, { channelOwner: true }, { outsideRead: ["interpreter"] }];
const context = (command: string, patch = {}) => ({ commandText: command, commandCwd: "/w", workFolder: "/w",
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
  unseen: { platform: "posix", fs: { realpath: (path: string) => path, stat: () => ({ isFile: () => true, isDirectory: () => false }) } },
  sessionFile: () => "unavailable", ...patch }) as unknown as AutoContext;

// NOLIM 1.0.19 (N1, N2.4): the No limits bot runs this unknown-target row for work whose stored origin is the owner's; an unattended,
// automated or channel-owner turn is "unproven" and keeps the card. Every other level keeps the card everywhere.
const noLimitsRuns = (bot: { noLimits?: boolean }, patch: { unattended?: boolean; automated?: boolean; channelOwner?: boolean }) =>
  bot.noLimits === true && patch.unattended !== true && patch.automated !== true && patch.channelOwner !== true;

describe("MARKS merge: an invalid command folder never auto-approves", () => {
  for (const [label, folder] of [["empty cwd plus the flag", { commandCwd: "", commandCwdInvalid: true }], ["the flag beside a valid-looking cwd", { commandCwd: "/w", commandCwdInvalid: true }]] as const) {
    it(`${label}: no approval and a card at every level and turn kind`, () => {
      for (const bot of levels) for (const patch of contexts) {
        const verdict = autoVerdict(bot, "Bash", "touch out", context("touch out", { ...patch, ...folder }));
        if (noLimitsRuns(bot, patch)) expectNoLimitsOwnerOutcome(verdict, "touch out", "unknown-target", `${bot.id} ${JSON.stringify(patch)}`);
        else expect(verdict, `${bot.id} ${JSON.stringify(patch)}`).toMatchObject({ approve: null, classification: "deny", rule: "unknown-target" });
      }
    });
  }
  it("control: the same command with a valid folder is not held as an unknown target", () => {
    for (const bot of levels) expect(autoVerdict(bot, "Bash", "touch out", context("touch out", {}))).not.toMatchObject({ rule: "unknown-target" });
  });
});

// MurageMain ruling 11-08 (N4, security): an explicit command folder the engine marks invalid never auto-approves at ANY level or turn
// kind, with the folder empty or a valid-looking "/w". approve null always means a raised card (always-ask), never a silent run.
describe("MARKS N4: an invalid command folder is never run silently (4 levels x 6 turn kinds x 2 folders)", () => {
  it.each(["touch out", "ls", "cat x", "echo hi > ./o"])("%s: no approval and an always-ask card everywhere", (command) => {
    for (const folder of [{ commandCwd: "", commandCwdInvalid: true }, { commandCwd: "/w", commandCwdInvalid: true }]) {
      for (const bot of levels) for (const patch of contexts) {
        const verdict = autoVerdict(bot, "Bash", command, context(command, { ...patch, ...folder }));
        const label = `${command} ${bot.id} ${JSON.stringify(patch)} ${JSON.stringify(folder)}`;
        if (noLimitsRuns(bot, patch)) expectNoLimitsOwnerOutcome(verdict, command, "unknown-target", label);
        else expect(verdict, label).toMatchObject({ approve: null, source: "always-ask", classification: "deny", rule: "unknown-target" });
      }
    }
  });
  it("a remembered grant (per-program and exact) answers a valid folder but never an invalid one", () => {
    const exactCommand = { engine: "claude", cwd: "/w", command: "touch out" };
    const grants = [approvalKey("Bash", "touch out"), exactCommandKey(exactCommand)];
    expect(grants.every((g) => typeof g === "string")).toBe(true);
    const bots = [{ id: "grant", alwaysAllow: grants }, { id: "grant-full", autoApprove: true, fullAccess: true, alwaysAllow: grants }];
    // control: with a valid folder the exact grant is what approves at ask level
    expect(autoVerdict(bots[0] as never, "Bash", "touch out", context("touch out", { exactCommand }))).toMatchObject({ source: "exact-command" });
    for (const bot of bots) for (const folder of [{ commandCwd: "", commandCwdInvalid: true }, { commandCwd: "/w", commandCwdInvalid: true }]) {
      expect(autoVerdict(bot as never, "Bash", "touch out", context("touch out", { exactCommand, ...folder })), `${bot.id} ${folder.commandCwd}`)
        .toMatchObject({ approve: null, source: "always-ask", classification: "deny", rule: "unknown-target", reason: "invalid-command-folder" });
    }
  });
});
