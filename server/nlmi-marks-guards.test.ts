// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canonPath, deviceInWord, newContext, procCanonical, procTraversal } from "./shell/walk.ts";
import { compilerResponse, genericResponse } from "./shell/marks.ts";
import { markCallOutside } from "./outside-wire.ts";
import { alwaysAskCommand } from "./always-ask.ts";
import { beginOutsideTurn, forgetOutsideState, turnOutsideExempt, turnOutsideMark, wireOutsideStore } from "./email/external-marks.ts";

const reason = (cmd: string) => alwaysAskCommand(cmd, "/w")?.doubt;
describe("MARKS independent guard witnesses", () => {
  it("M-PR-1a previous-character dot guard", () => {
    expect(deviceInWord("/./dev/sda")).toBe("/dev/sda");
    expect(alwaysAskCommand("echo target=/./dev/sda", "/w")?.rule).toBe("disk-erase");
  });
  it("M-PR-1b canonical literal target", () => expect(reason(`python3 -c 'open("/tmp/../dev/sda","w").write("x")'`)).toBe("value-path"));
  it("M-PR-1c unknown call is incomplete", () => expect(reason(`python3 -c 'mystery()'`)).toBe("tokenizer"));
  it("M-PR-2 sed program file", () => expect(reason("sed -f /w/F notes.txt")).toBe("tokenizer"));
  it("M-PR-3a raw-only proc climb", () => {
    expect(procTraversal("/tmp/../proc/../w/out")).toBe(true);
    expect(procCanonical("/w/out")).toBe(false);
    expect(reason("cp blob /tmp/../proc/../w/out")).toBe("value-path");
  });
  it("M-PR-3b canonical-only proc", () => {
    expect(procTraversal("/proc/self/fd/1")).toBe(false);
    expect(procCanonical("/proc/self/fd/1")).toBe(true);
    expect(reason("cp blob /proc/self/fd/1")).toBe("value-path");
  });
  it("M-PR-4 output value is canonicalized", () => expect(reason("dd if=blob of=/tmp/../dev/sda")).toBe("value-path"));
  it("read-position proc stays ordinary", () => expect(canonPath("/proc/self/status", newContext("/w"), "read").value).toBe(false));
  it("M-PR-5a unavailable session execution", () => expect(alwaysAskCommand("bash /w/F.sh", "/w", "command", undefined, undefined, undefined,
    { sessionEdits: new Set(["/w/F.sh"]), sessionFile: () => "unavailable" })?.doubt).toBe("unavailable-exec"));
  it("M-PR-5b provenance never grants an exemption", () => {
    forgetOutsideState();
    expect(wireOutsideStore({ load: () => ({ marks: [], sessions: [], markedTurns: [], outsideSince: 1 }), loadRegistry: () => [], writeRegistry() {}, setMark() {}, clearMark() {}, setSession() {}, addMarkedTurn() {}, setOutsideSince() {} })).toBe(true);
    beginOutsideTurn("t", "i", "turn", false);
    markCallOutside("t", "interpreter", { callKey: "k", lateFrame: true });
    expect(turnOutsideExempt("t", "k")).toBe(false);
    expect(turnOutsideMark("t")?.provenance).toEqual({ callKey: "k", late: true });
    forgetOutsideState();
  });
  it("M-PR-6a compiler only", () => {
    expect(compilerResponse("gcc", ["@/w/L"])).toBe(true);
    expect(genericResponse("gcc", ["@/w/L"], false)).toBe(false);
  });
  it("M-PR-6b generic only", () => {
    expect(compilerResponse("git", ["@/w/L"])).toBe(false);
    expect(genericResponse("git", ["@/w/L"], false)).toBe(true);
  });
  it("M-PR-6c xargs list", () => expect(reason("xargs -a /w/L echo")).toBe("file-fed-args"));
  it("M-PR-6d archive list", () => expect(reason("tar -cf out.tar -T /w/L")).toBe("file-fed-args"));
  it("M-PR-7 scan gate", () => expect(reason(`printf %s ${"a".repeat(131_073 - "printf %s ".length)}`)).toBe("scan-gate"));
});
