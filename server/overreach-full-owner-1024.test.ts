// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #6 (MAIN 2026-11-26, Sean: never over-strict on the owner's own turns; strict only for wipes, keys, other people's threads).
// Entry: autoVerdict (server/auto-approve.ts), the one verdict every approval card goes through.
import { describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";

const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const turn = (command: string, extra: object = {}) => ({ commandText: command, commandCwd: "/tmp/proj", ...OWNER, ...extra });
const verdict = (bot: object, command: string, extra: object = {}) => autoVerdict(bot, "Bash", command, turn(command, extra));

const RUNS = [
  ["unreadable", 'echo "unterminated'],
  ["unreadable", 'eval "$X"'],
  ["unreadable", "bash ./build.sh"],
  ["unknown-target", 'rm -rf "$UNKNOWN_DIR/x"'],
  ["protected-path", "chmod 777 /etc/hosts"],
  ["protected-path", "mv a /etc/foo"],
] as const;

describe("OVERREACH #6 the owner's own Full access turn runs what No limits runs", () => {
  it.each(RUNS)("O6-run %s: %s runs with no card", (_rule, command) => {
    expect(verdict(FULL, command).approve, command).not.toBeNull();
    expect(verdict(NO_LIMITS, command).approve, `${command} at No limits`).not.toBeNull();
  });
  it.each(["rm -rf /usr", "rm -rf ~", "rm -rf /", "dd if=./a of=/dev/sda"])("O6-wipe %s still cards at Full and at No limits", command => {
    expect(verdict(FULL, command)).toMatchObject({ approve: null, source: "always-ask" });
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: null, source: "always-ask" });
  });
  it.each(['eval "$X"; rm -rf ~', 'f(){ rm -rf "$1"; }; f ~', 'rm -rf "$UNKNOWN_DIR"/../..; rm -rf ~'])("O6-hidden-wipe %s: an unreadable text that holds a wipe still cards", command => {
    expect(verdict(FULL, command)).toMatchObject({ approve: null });
    expect(verdict(NO_LIMITS, command)).toMatchObject({ approve: null });
  });
  it("O6-key the key guard still holds a key read at Full", () => {
    expect(verdict(FULL, "cat ~/.ssh/id_rsa")).toMatchObject({ approve: null });
  });
  it.each(RUNS)("O6-others %s: %s keeps its card for an unattended turn, a channel message, and a turn the owner did not start", (rule, command) => {
    // an unreadable hit on those origins is run by MAIN-RULING NOLIMITS-1022 H1 (dev/1024), not by #6; unknown-target and protected-path are #6 only
    if (rule !== "unreadable") expect(verdict(FULL, command, { unattended: true, automated: true }).approve, "unattended").toBeNull();
    if (rule !== "unreadable") expect(verdict(FULL, command, { automated: true, channelOwner: true }).approve, "channel").toBeNull();
    expect(autoVerdict(FULL, "Bash", command, { commandText: command, commandCwd: "/tmp/proj", fullAccessOrigin: "other", stopLine: null, outsideRead: null }).approve, "guest").toBeNull();
  });
  it("O6-cut a call that was cut before it could be read keeps its card", () => {
    expect(verdict(FULL, 'echo "unterminated', { inputTruncated: true }).approve).toBeNull();
  });
});
