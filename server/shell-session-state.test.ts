import { expect, it } from "vitest";
import { autoVerdict, prepareShellJudgement, type CredentialGlobFs } from "./auto-approve.ts";
import type { ShellCwdState } from "../shared/sensitive-globs.ts";
import { ShellSessionRegistry } from "./shell-session-state.ts";
const unavailableFs: CredentialGlobFs = { realpath: async path => path, opendir: async () => { throw new Error("EACCES"); } };
async function readVerdict(command: string, state: ShellCwdState) {
  const prepared = await prepareShellJudgement(command, state, { attributed: true, fs: unavailableFs });
  return autoVerdict({ id: "x3", autoApprove: true, fullAccess: true, noLimits: false }, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: command, shellCwdPrepared: true, globExpansionRule: prepared.rule,
  });
}
it("X3 C H4 structural native identity and overlapping turns remain distinct", async () => {
  const registry = new ShellSessionRegistry();
  for (const [native, turn, cwd] of [["A", "T1", "/proj"], ["B", "T2", undefined]] as const) {
    registry.launch(turn, { thread: "thread", provider: "provider" });
    registry.accept(turn, turn, cwd);
    registry.started({ thread: "thread", provider: "provider", native, incarnation: 1 }, turn);
  }
  const a = registry.select("thread", "provider", "T1")!, b = registry.select("thread", "provider", "T2")!;
  expect(a).not.toBe(b);
  expect(a.identity.native).toBe("A");
  expect(b.identity.native).toBe("B");
  expect([...a.state.targets.keys()]).toEqual(["/proj"]);
  expect(b.state.unknown).toBeTruthy();
  expect(await readVerdict("cat zzzzz?.unlisted", registry.snapshot(b))).toMatchObject({ approve: null, source: "sensitive-guard" });
  expect(registry.select("thread", "provider", undefined)).toBeUndefined();
  expect(registry.select("thread", "provider", "stale")).toBeUndefined();
  expect(registry.select("thread", "other", "T1")).toBeUndefined();
});
it("X3 C H4 resume retains launch state and retirement rejects late publication", async () => {
  const registry = new ShellSessionRegistry();
  const identity = { thread: "thread", provider: "provider", native: "A#2", incarnation: 1 };
  registry.launch("one", { ...identity, identity });
  registry.accept("one", "T1", "/proj");
  const record = registry.select("thread", "provider", "T1")!;
  registry.launch("two", { ...identity, identity });
  registry.accept("two", "T2");
  expect(registry.select("thread", "provider", "T2")).toBe(record);
  expect([...record.state.targets.keys()]).toEqual(["/proj"]);
  expect((await readVerdict("cat README*", registry.snapshot(record))).approve).not.toBeNull();
  registry.retire("thread", "provider", record);
  expect(registry.publish(record, { targets: new Map([["/replacement", "late"]]) }, registry.claim(record))).toBe(false);
  expect(registry.select("thread", "provider", "T1")).toBeUndefined();
  registry.launch("three", { ...identity, identity: { ...identity, native: "A", incarnation: 2 } });
  registry.accept("three", "T3");
  expect(registry.select("thread", "provider", "T3")).not.toBe(record);
});
it.each(["thread", "provider", "all"])("X3 C H4 retirement boundary %s removes pending and live bindings", boundary => {
  const registry = new ShellSessionRegistry();
  registry.launch("g", { thread: "t", provider: "p" });
  registry.accept("g", "turn", "/proj");
  registry.started({ thread: "t", provider: "p", native: "n", incarnation: 1 }, "turn");
  const record = registry.select("t", "p", "turn")!;
  registry.retire(boundary === "thread" ? "t" : undefined, boundary === "provider" ? "p" : undefined);
  registry.accept("g", "turn");
  expect(registry.select("t", "p", "turn")).toBeUndefined();
  expect(registry.publish(record, { targets: new Map() }, registry.claim(record))).toBe(false);
});

it("X3 C completed old turn cannot select or retire a replacement session", () => {
  const registry = new ShellSessionRegistry();
  for (const [native, turn] of [["old", "T1"], ["replacement", "T2"]]) {
    registry.launch(turn!, { thread: "t", provider: "p" });
    registry.accept(turn!, turn!, "/proj");
    registry.started({ thread: "t", provider: "p", native: native!, incarnation: 1 }, turn);
  }
  const old = registry.select("t", "p", "T1")!, replacement = registry.select("t", "p", "T2")!;
  registry.complete("t", "p", "T1");
  expect(registry.select("t", "p", "T1")).toBeUndefined();
  registry.exit("t", "p", "T1");
  expect(registry.select("t", "p", "T2")).toBe(replacement);
  expect(registry.publish(old, { targets: new Map() }, registry.claim(old))).toBe(false);
  registry.started({ thread: "t", provider: "p", native: "old", incarnation: 1 }, "T1");
  registry.launch("late", { thread: "t", provider: "p" });
  registry.accept("late", "T1", "/other");
  expect(registry.select("t", "p", "T1")).toBeUndefined();
});


it("l4: an overlapping request completion never clears a later unknown effect", () => {
  const registry = new ShellSessionRegistry();
  const identity = { thread: "t", provider: "p", native: "n", incarnation: 1 };
  registry.launch("g", { ...identity, identity }); registry.accept("g", "T", "/w");
  const record = registry.select("t", "p", "T")!;
  registry.publish(record, { targets: new Map([["/w", "spawn"]]) }, registry.claim(record));
  registry.propose(record, "T", "A", { targets: new Map([["/w", "cd"]]), install: true });
  registry.publish(record, { targets: new Map(), unknown: "later dynamic cd" }, registry.claim(record));
  registry.propose(record, "T", "B", { targets: new Map([["/other", "cd"]]), install: true });
  registry.completeRequest("t", "p", "T", "A", 0);
  expect(record.state.unknown).toBeTruthy();
  registry.completeRequest("t", "p", "T", "B", 0);
  expect(record.state.unknown).toBeTruthy();
});
it("l4: no bound record never guesses a project folder", async () => {
  const registry = new ShellSessionRegistry();
  const missing = registry.snapshot(registry.select("t", "p", "never-started"));
  expect(missing.unknown).toBeTruthy();
  expect(missing.targets.size).toBe(0);
  expect((await readVerdict("cat README*", missing)).approve).toBeNull();
});
