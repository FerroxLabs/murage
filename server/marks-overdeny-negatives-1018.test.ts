import { describe, expect, it } from "vitest";
import { alwaysAskCommand as alwaysAskRaw } from "./always-ask.ts";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { withoutDoubts } from "./shell/marks.ts";
import { cell, nlh0, ownerMarks } from "./testing/marks-nlh0.ts";

// MARKS R1 (MurageMain 11-08, G1): these rows state the owner clean No limits strict read, so each call runs under ownerMarks;
// every other level and origin reads as NLH0 (the raw "non-owner reads as NLH0" row at the end of this file).
const alwaysAskCommand: typeof alwaysAskRaw = (...args) => ownerMarks(() => alwaysAskRaw(...args));

const cwd = "/home/tester/project";
const levels = [
  { id: "ask" }, { id: "auto", autoApprove: true },
  { id: "full", autoApprove: true, fullAccess: true },
  { id: "owner", autoApprove: true, fullAccess: true, noLimits: true },
];
const contexts = [{}, { ownerStarted: false }, { routineLevel: true, routineCarveOut: true, automated: true },
  { unattended: true }, { channelOwner: true }, { outsideRead: ["interpreter"] }];
const options = { platform: "posix" as const, fs: {
  realpath: (path: string) => path,
  stat: () => ({ isFile: () => true, isDirectory: () => false }),
} };
const rows = [
  "echo x > /dev/sda", "echo x 2> /etc/x",
  "echo x > /dev/null/../stdout",
  "source /etc/profile.d/x.sh", "source ../../x.sh",
  ". /etc/profile.d/x.sh", ". ../../x.sh",
];
// MurageMain 11-08 FULLDENY-DEV ruling: ordinary device sinks exempt (1.0.17 parity); raw devices stay system
// (/dev/stdout|stderr|tty|stdin left the held rows; `node /dev/null` runs: an empty script reads nothing, S4-INTERP treats it as a plain run)
const SINK_ROWS = ["echo x > /dev/stdout", "echo x > /dev/stderr", "echo x > /dev/tty", "echo x > /dev/stdin", "node /dev/null"];
describe("MARKS over-denial fixes: ordinary device sinks run at owner No limits", () => {
  it.each(SINK_ROWS)("%s runs", command => {
    expect(alwaysAskCommand(command, cwd, "command", undefined, undefined, "/home/tester", options)).toBeNull();
    const ctx = { commandText: command, commandCwd: cwd, workFolder: cwd,
      fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
      promptFacts: { cwd, home: "/home/tester" }, unseen: options,
      sessionFile: () => "unavailable" } as unknown as AutoContext;
    expect(autoVerdict(levels[3]!, "Bash", command, ctx).approve).not.toBeNull();
  });
});

describe("MARKS over-denial fixes retain protected and outside targets", () => {
  it.each(rows)("%s stays held", command => {
    const read = () => alwaysAskCommand(command, cwd, "command", undefined, undefined, "/home/tester", options);
    // R1: outside the owner turn the read is NLH0's
    nlh0(`${command}|read`, alwaysAskRaw(command, cwd, "command", undefined, undefined, "/home/tester", options));
    for (const bot of levels) for (const patch of contexts) {
      const ctx = { commandText: command, commandCwd: cwd, workFolder: cwd,
        fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
        promptFacts: { cwd, home: "/home/tester" }, unseen: options,
        sessionFile: () => "unavailable", ...patch } as unknown as AutoContext;
      cell(command, bot, patch, autoVerdict(bot, "Bash", command, ctx), () => undefined);
    }
    for (const hit of [read(), withoutDoubts(read)]) {
      expect(hit).not.toBeNull();
      expect(["deny", "ask"]).toContain(hit?.classification);
      expect(["protected-path", "unknown-target", "disk-erase", "unreadable"]).toContain(hit?.rule);
      if (!command.includes("../../")) expect(hit?.classification).toBe("deny");
    }
    for (const bot of levels) for (const patch of contexts) {
      const ctx = { commandText: command, commandCwd: cwd, workFolder: cwd,
        fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
        promptFacts: { cwd, home: "/home/tester" }, unseen: options,
        sessionFile: () => "unavailable", ...patch } as unknown as AutoContext;
      const verdict = autoVerdict(bot, "Bash", command, ctx);
      cell(command, bot, patch, verdict, () => {
        expect(verdict.approve).toBeNull();
        expect(["deny", "ask"]).toContain(verdict.classification);
        if (!command.includes("../../")) expect(verdict.classification).toBe("deny");
      });
    }
  });
});
