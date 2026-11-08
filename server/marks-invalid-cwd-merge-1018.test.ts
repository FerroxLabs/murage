// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS merge of A and B, server/index.ts wholeCommand: a command folder that is unknown or conflicting reaches auto-approval as
// commandCwd "" plus commandCwdInvalid true. It must fail closed at auto-approve.ts (cwd = invalid ? "" : ...): no auto-approve at
// any level, on any turn kind, and the owner is shown the card. The flag alone must be enough (a stale valid commandCwd beside it).
import { describe, expect, it } from "vitest";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";

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

describe("MARKS merge: an invalid command folder never auto-approves", () => {
  for (const [label, folder] of [["empty cwd plus the flag", { commandCwd: "", commandCwdInvalid: true }], ["the flag beside a valid-looking cwd", { commandCwd: "/w", commandCwdInvalid: true }]] as const) {
    it(`${label}: no approval and a card at every level and turn kind`, () => {
      for (const bot of levels) for (const patch of contexts) {
        const verdict = autoVerdict(bot, "Bash", "touch out", context("touch out", { ...patch, ...folder }));
        expect(verdict, `${bot.id} ${JSON.stringify(patch)}`).toMatchObject({ approve: null, classification: "deny", rule: "unknown-target" });
      }
    });
  }
  it("control: the same command with a valid folder is not held as an unknown target", () => {
    for (const bot of levels) expect(autoVerdict(bot, "Bash", "touch out", context("touch out", {}))).not.toMatchObject({ rule: "unknown-target" });
  });
});
