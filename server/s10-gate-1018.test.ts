// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10, MurageMain's ruling 11-06): past 128 KiB the verdict does not read a command in full. On an owner No limits
// turn there is no card for length: the wipe list, the deny rows and the key guard still read it. At every other level
// it cards for length. Below the gate nothing changes.
import { describe, expect, it } from "vitest";
import { autoVerdict, COMMAND_GATE_CHARS } from "./auto-approve.ts";
import { approvalSummary } from "../shared/approval-summary.ts";

const script = (chars: number, tail = "") => {
  const out: string[] = [];
  let n = tail.length;
  for (let k = 0; ; k++) {
    const line = `echo "step ${k}" && mkdir -p build/${k % 9}`;
    if (n + line.length + 1 > chars) break;
    out.push(line);
    n += line.length + 1;
  }
  return out.join("\n") + tail;
};
const NO_LIMITS = { id: "nl", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "fa", autoApprove: true, fullAccess: true };
const AUTO = { id: "auto", autoApprove: true };
// `outsideRead: null`: a clean turn, as NOLIMITS's lane reads it once both lanes are in (unknown and unused on S10 alone)
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const verdict = (bot: object, command: string, owner: object = OWNER) =>
  autoVerdict(bot as never, "shell", approvalSummary(command), { ...owner, exactCommand: { command } } as never);
const PAST = COMMAND_GATE_CHARS + 2048;

describe("the 128 KiB gate", () => {
  it("sits at 128 KiB, above the longest real command (62,757 characters)", () => {
    expect(COMMAND_GATE_CHARS).toBe(128 * 1024);
  });

  it("an owner No limits turn runs a plain script past the gate, with no card for length", () => {
    const long = script(PAST);
    expect(long.length).toBeGreaterThan(COMMAND_GATE_CHARS);
    const v = verdict(NO_LIMITS, long);
    expect(v.approve).not.toBeNull();
  });

  it("past the gate on No limits the wipe list still reads the far end", () => {
    const v = verdict(NO_LIMITS, script(PAST, "\nrm -rf /"));
    expect(v.approve).toBeNull();
    expect(v.source).toBe("always-ask");
  });

  it("past the gate on No limits the key guard reads the far end and decides as it does for a short command", () => {
    const tail = "\ncat ~/.ssh/id_rsa";
    const short = verdict(NO_LIMITS, script(2048, tail));
    const long = verdict(NO_LIMITS, script(PAST, tail));
    expect({ approve: long.approve === null, source: long.source }).toEqual({ approve: short.approve === null, source: short.source });
    // and at Full access, where a key read cards, the far end is still found below the gate
    expect(verdict(FULL, script(COMMAND_GATE_CHARS - 4096, tail)).approve).toBeNull();
  });

  it("past the gate at Full access it cards for length", () => {
    const v = verdict(FULL, script(PAST));
    expect(v.approve).toBeNull();
    expect(v).toMatchObject({ source: "always-ask", rule: "unreadable" });
  });

  it("past the gate at Full access a command carried only in the call's arguments cards for length (Astra r7 #1)", () => {
    const command = script(PAST);
    const v = autoVerdict(FULL as never, "shell", "run", { ...OWNER, call: { toolCall: { input: { command } } } } as never);
    expect(v.approve).toBeNull();
    expect(v).toMatchObject({ source: "always-ask", rule: "unreadable" });
  });

  it("past the gate on No limits a PowerShell key glob is found as it is below the gate (Astra r7 #4)", () => {
    const head = "Get-Content ~/.aw?/credentials #";
    const read = (pad: number) => {
      const command = head + "a".repeat(pad);
      const v = autoVerdict(NO_LIMITS as never, "powershell", approvalSummary(command), { ...OWNER, exactCommand: { command } } as never);
      return { approve: v.approve === null, source: v.source, rule: "rule" in v ? v.rule : undefined };
    };
    const short = read(1024);
    expect(short.rule).toBe("held=key-row");
    expect(read(COMMAND_GATE_CHARS + 2048)).toEqual(short);
  });

  it("past the gate on a No limits turn the owner did not start it cards for length", () => {
    const v = verdict(NO_LIMITS, script(PAST), { fullAccessOrigin: "other", ownerStarted: false, stopLine: null, unattended: true });
    expect(v.approve).toBeNull();
  });

  it("past the gate at Auto it cards", () => {
    expect(verdict(AUTO, script(PAST)).approve).toBeNull();
  });

  it("below the gate Full access and No limits read it in full, with no card for length", () => {
    const below = script(COMMAND_GATE_CHARS - 4096);
    expect(verdict(FULL, below).approve).not.toBeNull();
    expect(verdict(NO_LIMITS, below).approve).not.toBeNull();
  });
});
