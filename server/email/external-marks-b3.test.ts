// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
let createGracefulShutdown: typeof import("../graceful-shutdown.ts").createGracefulShutdown;
import type { OutsideStore } from "./external-marks.ts";

const faults = vi.hoisted(() => ({ sync: false, close: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    fsyncSync: (fd: number) => { if (faults.sync) throw new Error("fsync failed"); fs.fsyncSync(fd); },
    closeSync: (fd: number) => { fs.closeSync(fd); if (faults.close) throw new Error("close failed"); },
  };
});
let marks: typeof import("./external-marks.ts");
let fileOutsideStore: typeof import("../outside-store.ts").fileOutsideStore;
let root: string, path: string, disk: OutsideStore;
let now: number;
const at = 100_000;
const fail = () => { throw new Error("disk full"); };
const restart = async () => {
  vi.resetModules();
  marks = await import("./external-marks.ts");
  ({ createGracefulShutdown } = await import("../graceful-shutdown.ts"));
  ({ fileOutsideStore } = await import("../outside-store.ts"));
  disk = fileOutsideStore(path);
  expect(marks.wireOutsideStore(disk, () => now)).toBe(true);
};
const begin = (resumed = false) => marks.beginGuardedOutsideTurn("t", "i", "turn", resumed);
const noSeal = () => expect(readFileSync(path, "utf8")).not.toContain('"k":"seal"');
const unsealed = () => {
  expect(marks.sessionTainted("t", "i")).toBe(true);
  expect(marks.readOnlySoFar("t", "i")).toBe(false);
  expect(marks.sessionEdits("t", "i").has(marks.SESSION_EDITS_OVERFLOW)).toBe(true);
  expect(marks.turnWasMarked("t", `t#open${at}`)).toBe(true);
  expect(marks.notProvenClean("t", at)).toBe(true);
};
const shutdown = (jobs: Array<() => void | Promise<void>> = []) => new Promise<void>((resolve) => {
  createGracefulShutdown({ cleanup: jobs, finalCleanup: marks.sealOutsideStore, exit: () => resolve(), timeoutMs: 10 })();
});
const view = () => ({ tainted: marks.sessionTainted("t", "i"), readOnly: marks.readOnlySoFar("t", "i"),
  turns: [...marks.markedTurnsOf("t")], edits: [...marks.sessionEdits("t", "i")], read: marks.turnOutsideRead("t") });

// Model writes lost in a crash while retaining the durable open and clean birth row.
const loseMarks = () => {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter((line) => {
    const row = JSON.parse(line);
    return row.k !== "mark" && row.k !== "turn" && !(row.k === "session" && row.row.tainted);
  });
  writeFileSync(path, `${lines.join("\n")}\n`);
};
const unsealedAt = (when: number) => {
  expect(marks.sessionTainted("t", "i")).toBe(true);
  expect(marks.readOnlySoFar("t", "i")).toBe(false);
  expect(marks.sessionEdits("t", "i")).toContain(marks.SESSION_EDITS_OVERFLOW);
  expect(marks.turnWasMarked("t", `t#open${when}`)).toBe(true);
};
const flush = async (overrides: Partial<Parameters<typeof marks.flushOutsideStore>[0]> = {}) => {
  const begun = performance.now();
  try {
    return await marks.flushOutsideStore({ flushCoalesced() {}, busy: () => false, pending: () => false,
      closeIdle: async () => ({ confirmed: true, release() {} }), ...overrides });
  } finally {
    const elapsed = performance.now() - begun;
    console.info(`B3 flush plus seal: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(1200);
  }
};

beforeEach(async () => {
  faults.sync = false; faults.close = false; now = at;
  root = mkdtempSync(join(tmpdir(), "murage-b3-"));
  path = join(root, "outside-state.jsonl");
  await restart();
});
afterEach(() => { faults.sync = false; faults.close = false; vi.useRealTimers(); removeTempDirSync(root); });

describe("B3 outside turn durability", () => {
  it("B3-1 open append failure gives 409 without dispatch and preserves the restart view", async () => {
    marks.beginOutsideTurn("t", "i", "previous", false);
    const before = view();
    marks.wireOutsideStore({ ...disk, openTurn: fail }, () => now);
    // Execute the actual admission block with its dependencies supplied by this fixture.
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const block = source.match(/if \(!beginGuardedOutsideTurn\(threadId, instanceId, undefined, resumedSession\)\) \{[^}]+\{ status: 409 \}\);\s*\}/)?.[0];
    expect(block).toBeDefined();
    const admission = new Function("beginGuardedOutsideTurn", "threadId", "instanceId", "resumedSession", "dispatch", "outsideRefusalMessage", `${block}\ndispatch();`);
    const dispatch = vi.fn();
    let error: unknown;
    try { admission(marks.beginGuardedOutsideTurn, "t", "i", true, dispatch, marks.outsideRefusalMessage); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 409 });
    expect(dispatch).not.toHaveBeenCalled();
    const roomBlock = source.match(/if \(!openOutsideTurn\(threadId, instance.instanceId\)\) \{[^}]+\{ status: 409 \}\);\s*\}/)?.[0];
    expect(roomBlock).toBeDefined();
    const roomAdmission = new Function("openOutsideTurn", "threadId", "instance", "dispatch", "outsideRefusalMessage", `${roomBlock}\ndispatch();`);
    expect(() => roomAdmission(marks.openOutsideTurn, "t", { instanceId: "i" }, dispatch, marks.outsideRefusalMessage)).toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await restart();
    expect(view()).toEqual(before);
  });

  it("B3-2 a null store refuses admission", async () => {
    marks.wireOutsideStore(null);
    expect(begin()).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    // A load error alone is different: a writable store admits and keeps readers not ready.
    await restart();
    marks.wireOutsideStore({ ...disk, load: fail });
    expect(begin()).toBe(true);
    expect(disk.load().opens).toHaveLength(1);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.readOnlySoFar("t", "i")).toBe(false);
  });

  it("B3-3 a failed mark blocks the shutdown seal and recovers writes and the synthetic turn", async () => {
    marks.wireOutsideStore({ ...disk, setMark: fail }, () => now);
    expect(begin()).toBe(true);
    marks.markTurnOutside("t", "web page");
    expect(marks.outsideReady()).toBe(false);
    await shutdown(); noSeal(); await restart(); unsealed();
    expect(marks.recallRowsOutside("reader", [{ threadId: "t", at }])).toBe("memory");
  });

  it("B3-4 failed turn and session writes after the mark block the seal", async () => {
    let broken = false;
    marks.wireOutsideStore({ ...disk, addMarkedTurn: fail, setSession: (row) => { if (broken) fail(); disk.setSession(row); } }, () => now);
    expect(begin()).toBe(true); broken = true;
    marks.markTurnOutside("t", "web page");
    expect(disk.load().marks).toHaveLength(1);
    expect(disk.load().markedTurns).toHaveLength(0);
    expect(disk.load().sessions[0]?.tainted).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    await shutdown(); noSeal(); await restart(); unsealed();
  });

  it("B3-5 a crash after endOutsideTurn retains the unsealed open", async () => {
    expect(begin()).toBe(true);
    marks.endOutsideTurn("t", "turn");
    expect(disk.load().markedTurns).toHaveLength(0);
    noSeal(); await restart(); unsealed();
  });

  it("B3-6 a second lifetime seal never retires the first lifetime open", async () => {
    expect(begin()).toBe(true);
    const runA = disk.load().opens[0]!.runId;
    const beforeLoad = readFileSync(path, "utf8");
    await restart();
    expect(readFileSync(path, "utf8")).toBe(beforeLoad);
    await shutdown();
    expect(disk.load().opens[0]!.runId).toBe(runA);
    await restart(); unsealed();
  });

  it("B3-7 a fresh session in lifetime C is clean and remains clean on reload", async () => {
    expect(begin()).toBe(true);
    await restart(); await shutdown(); await restart(); unsealed();
    now = at + 100;
    expect(begin()).toBe(true);
    expect(marks.sessionTainted("t", "i")).toBe(false);
    expect(marks.readOnlySoFar("t", "i")).toBe(true);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
    expect(marks.sessionEdits("t", "i").size).toBe(0);
  });

  it("B3-8 a clean run seals and resumes clean with open before all clears", async () => {
    marks.markTurnEmailDerived("ordering");
    const writes: string[] = [];
    marks.persistTurnMarks({ all: () => ["ordering"], add() {}, remove: () => { writes.push("email remove"); }, sessionFrom: () => undefined, setSessionFrom() {} });
    marks.wireOutsideStore({ ...disk,
      openTurn: (...args) => { writes.push("open"); disk.openTurn(...args); },
      clearMark: (id) => { writes.push("clearMark"); disk.clearMark(id); },
      setSession: (row) => { writes.push(row.tainted ? "session tainted" : "session fresh"); disk.setSession(row); },
    }, () => now);
    now++;
    expect(marks.beginGuardedOutsideTurn("ordering", "i", "order", false)).toBe(true);
    expect(writes).toEqual(["open", "email remove", "clearMark", "session fresh"]);
    expect(begin()).toBe(true);
    marks.endOutsideTurn("t", "turn");
    await shutdown();
    expect(disk.load().opens).toEqual([]);
    await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
    expect(marks.turnWasMarked("t", `t#open${now}`)).toBe(false);
    expect(marks.notProvenClean("t", now)).toBe(false);
    expect(begin(true)).toBe(true);
    expect(marks.turnOutsideRead("t")).toBeNull();
  });

  it("B3-9 a hanging cleanup job cannot seal even after it eventually finishes", async () => {
    vi.useFakeTimers(); expect(begin()).toBe(true);
    let finish!: () => void;
    const done = shutdown([() => new Promise<void>((resolve) => { finish = resolve; })]);
    await vi.advanceTimersByTimeAsync(11); await done; noSeal();
    finish(); await Promise.resolve(); await Promise.resolve(); noSeal();
    await restart(); unsealed();
  });

  it("B3-10 rejected cleanup and unconfirmed disposal each prevent a seal", async () => {
    expect(begin()).toBe(true);
    await shutdown([async () => { throw new Error("cleanup failed"); }]); noSeal();
    await restart();
    // Use the same disposal check as the production cleanup job.
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const block = source.match(/const unconfirmed = await registry.disposeAll\(\);\s*if \(unconfirmed.length\) noteStoreFailure\(\);/)?.[0];
    expect(block).toBeDefined();
    const dispose = new Function("registry", "noteStoreFailure", `return (async () => { ${block} })();`);
    await shutdown([() => dispose({ disposeAll: async () => ["engine"] }, marks.noteStoreFailure)]);
    expect(marks.outsideReady()).toBe(false); noSeal(); await restart(); unsealed();
  });

  it("B3-11 late failed marks and marks during shutdown each block the seal", async () => {
    expect(begin()).toBe(true); marks.endOutsideTurn("t", "turn");
    marks.wireOutsideStore({ ...disk, setMark: fail }, () => now);
    marks.markTurnOutside("t", "web page");
    await shutdown([() => marks.markTurnOutside("t", "email")]); noSeal();
    await restart(); unsealed();
    // Fresh latch: even a duplicate mark during shutdown must block the seal.
    await shutdown([() => marks.markTurnOutside("t", "email")]); noSeal();
    await restart(); unsealed();
  });

  it("B3-12 a lost wrote row keeps rewired readers closed and refuses another turn", async () => {
    expect(begin()).toBe(true);
    marks.wireOutsideStore({ ...disk, setSession: fail }, () => now);
    marks.noteSessionWrote("t2", "i2"); // a session the rewire did not recover as wrote already
    expect(marks.outsideReady()).toBe(false);
    marks.forgetOutsideState(); // Same process, explicitly not a restart.
    expect(marks.wireOutsideStore(disk, () => now)).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.readOnlySoFar("t", "i")).toBe(false);
    expect(begin()).toBe(false);
    await shutdown(); noSeal(); await restart(); unsealed();
  });

  it("B3-13 a swallowed registry append error raises the latch", async () => {
    expect(begin()).toBe(true);
    renameSync(path, `${path}.saved`); mkdirSync(path);
    expect(() => marks.downloadRegistry().add([{ kind: "file", path: join(root, "download"), since: at }])).not.toThrow();
    expect(marks.outsideReady()).toBe(false);
    removeTempDirSync(path); renameSync(`${path}.saved`, path);
    await shutdown(); noSeal();
  });

  it("B3-14 email add, remove and session writes each raise the latch", async () => {
    for (const operation of ["add", "remove", "setSessionFrom"] as const) {
      await restart(); expect(begin()).toBe(true);
      marks.persistTurnMarks({ all: () => operation === "remove" ? ["t"] : [], add() {}, remove() {}, sessionFrom: () => undefined, setSessionFrom() {}, [operation]: fail });
      if (operation === "add") marks.markTurnEmailDerived("t");
      if (operation === "remove") marks.beginTurnMarks("t");
      if (operation === "setSessionFrom") marks.noteSessionStart("t", "i", 1);
      expect(marks.outsideReady()).toBe(false);
      await shutdown(); noSeal();
    }
  });

  it("B3-15 seal fsync failure leaves no seal and open close failure refuses admission", async () => {
    expect(begin()).toBe(true); faults.sync = true;
    marks.sealOutsideStore(); noSeal(); expect(marks.outsideReady()).toBe(false);
    faults.sync = false; await restart(); faults.close = true;
    expect(begin(true)).toBe(false); expect(marks.outsideReady()).toBe(false); noSeal();
    faults.close = false; await restart();
    marks.sealOutsideStore();
    const sealed = readFileSync(path, "utf8");
    marks.sealOutsideStore(); expect(readFileSync(path, "utf8")).toBe(sealed);
    expect(() => disk.setMark({ threadId: "late", source: "email", at })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(sealed);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.ownWritten("missing")).toBe(true);
    expect(marks.anyOwnWrite()).toBe(true);
  });

  it("B3-16 an open for X leaves resumed and fresh Y sessions clean", async () => {
    disk.setSession({ threadId: "t", instanceId: "Y", tainted: false, wrote: false, edits: [], startedAt: at - 1 });
    expect(marks.beginGuardedOutsideTurn("t", "X", "x", false)).toBe(true);
    await restart();
    expect(marks.sessionTainted("t", "X")).toBe(true);
    expect(marks.sessionTainted("t", "Y")).toBe(false);
    expect(marks.readOnlySoFar("t", "Y")).toBe(true);
    expect(marks.sessionEdits("t", "Y").size).toBe(0);
    expect(marks.wireOutsideStore(disk, () => now)).toBe(true);
    expect(marks.sessionTainted("t", "Y")).toBe(false);
    expect(marks.beginGuardedOutsideTurn("t", "Y", "y", true)).toBe(true);
    expect(marks.turnOutsideRead("t")).toBeNull();
    now++;
    expect(marks.beginGuardedOutsideTurn("t", "Y", "fresh-y", false)).toBe(true);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "X")).toBe(true);
    expect(marks.sessionTainted("t", "Y")).toBe(false);
  });

  it("B3-17 a failed own write denies the change before the route runs", async () => {
    const { ownToolGate, ownCreatedBot } = await import("../outside-own.ts");
    expect(begin()).toBe(true); marks.markTurnOutside("t", "email");
    marks.wireOutsideStore({ ...disk, addOwnWrite: fail }, () => now);
    const change = vi.fn();
    const result = ownToolGate({ threadId: "t", botId: "b", tool: "update_bot", targetBotId: "other", lane: false });
    if (!result) change();
    expect(result).toHaveProperty("refuse"); expect(change).not.toHaveBeenCalled();
    expect(marks.ownWritten("other")).toBe(true); expect(marks.anyOwnWrite()).toBe(true);
    expect(() => ownCreatedBot("t", "new-bot")).toThrow();
    await shutdown(); noSeal();
    await restart();
    marks.wireOutsideStore({ ...disk, addOwnWrite: fail }, () => now);
    const { markRecordOutsideDerived } = await import("../memory/outside-derived.ts");
    expect(() => { markRecordOutsideDerived(undefined as never, "record"); change(); }).toThrow();
    expect(change).not.toHaveBeenCalled();
    await restart();
    marks.wireOutsideStore({ ...disk, addOwnWrite: fail }, () => now);
    const { recordOutsideInstallChange } = await import("../outside-wire.ts");
    expect(recordOutsideInstallChange("unknown-path", { origin: "engine", title: "Bash", input: { command: "npm install example" } }, root)).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(marks.ownWritten("install:path-unknown")).toBe(true);
  });

  // Mutants: omit the open binding, infer birth from time, or mint a new generation on resume.
  it.each(["advancing", "backward"])("B3-6b first session turn recovers with an %s clock", async (mode) => {
    let tick = at;
    marks.wireOutsideStore(disk, () => mode === "advancing" ? tick++ : tick--);
    expect(begin()).toBe(true);
    const open = disk.load().opens[0]!;
    const row = disk.load().sessions[0]!;
    expect(open.sessionKey).toBe(row.sessionKey);
    expect(open.gen).toBe(row.gen);
    expect(open.birthRunId).toBe(row.birthRunId);
    expect(row.gen).toBe(1);
    await restart();
    expect(marks.sessionTainted("t", "i")).toBe(true);
    expect(marks.readOnlySoFar("t", "i")).toBe(false);
    expect(marks.sessionEdits("t", "i")).toContain(marks.SESSION_EDITS_OVERFLOW);
  });

  it("B3-binding resumed generation 3 survives lost marks and a new process", async () => {
    const binding = { sessionKey: "kept-session", gen: 3, birthRunId: "birth-run" };
    disk.setSession({ threadId: "t", instanceId: "i", ...binding, tainted: false, wrote: false, edits: [], startedAt: at + 900 });
    marks.wireOutsideStore(disk, () => at - 900);
    expect(begin(true)).toBe(true);
    expect(disk.load().opens[0]).toMatchObject(binding);
    marks.markTurnOutside("t", "email");
    loseMarks(); await restart(); unsealedAt(at - 900);
    // A replacement session has its own binding even when the clock moves backward.
    now = at - 1000;
    expect(begin(false)).toBe(true);
    const replacement = disk.load().sessions[0]!;
    expect(replacement.sessionKey).not.toBe(binding.sessionKey);
    expect(replacement.birthRunId).not.toBe(binding.birthRunId);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
    expect(marks.readOnlySoFar("t", "i")).toBe(true);
    expect(marks.sessionEdits("t", "i").size).toBe(0);
  });

  it("B3-binding legacy rows recover by thread and instance", async () => {
    disk.setSession({ threadId: "t", instanceId: "i", tainted: false, wrote: false, edits: [], startedAt: at + 1 });
    marks.wireOutsideStore(disk, () => now);
    expect(begin(true)).toBe(true);
    expect(disk.load().sessions[0]!.sessionKey).toBe(disk.load().opens[0]!.sessionKey);
    // The upgrade write was lost too: the old unbound row must still recover.
    disk.setSession({ threadId: "t", instanceId: "i", tainted: false, wrote: false, edits: [], startedAt: at + 1 });
    await restart(); unsealed();
  });

  it("B3-10a rejected cleanup alone blocks the seal", async () => {
    expect(begin()).toBe(true);
    await shutdown([async () => { throw new Error("rejected"); }]);
    noSeal(); await restart(); unsealed();
  });

  it("B3-10b unconfirmed disposal alone blocks the seal", async () => {
    expect(begin()).toBe(true);
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const block = source.match(/const unconfirmed = await registry.disposeAll\(\);\s*if \(unconfirmed.length\) noteStoreFailure\(\);/)?.[0];
    expect(block).toBeDefined();
    const dispose = new Function("registry", "noteStoreFailure", `return (async () => { ${block} })();`);
    await shutdown([() => dispose({ disposeAll: async () => ["child"] }, marks.noteStoreFailure)]);
    noSeal(); await restart(); unsealed();
  });

  // Mutant: move beginOutsideShutdown into the first asynchronous job.
  it("B3-11a a mark between the shutdown callback and its jobs raises a fresh latch", async () => {
    expect(begin()).toBe(true);
    expect(marks.outsideReady()).toBe(true);
    const done = shutdown();
    marks.markTurnOutside("t", "email");
    expect(marks.outsideReady()).toBe(false);
    await done; noSeal(); await restart(); unsealed();
  });

  it.each(["raised latch", "terminal seal"])("B3-admission %s gives 409 and zero dispatch", async (barrier) => {
    expect(begin()).toBe(true);
    if (barrier === "raised latch") marks.noteStoreFailure();
    else await shutdown();
    const before = readFileSync(path, "utf8");
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const block = source.match(/if \(!beginGuardedOutsideTurn\(threadId, instanceId, undefined, resumedSession\)\) \{[^}]+\{ status: 409 \}\);\s*\}/)?.[0];
    expect(block).toBeDefined();
    const admit = new Function("beginGuardedOutsideTurn", "threadId", "instanceId", "resumedSession", "dispatch", "outsideRefusalMessage", `${block}\ndispatch();`);
    const dispatch = vi.fn();
    let error: unknown;
    try { admit(marks.beginGuardedOutsideTurn, "t", "i", true, dispatch, marks.outsideRefusalMessage); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status: 409 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("B3-open fsync failure refuses admission", async () => {
    faults.sync = true;
    expect(begin()).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    expect(disk.load().sessions).toEqual([]);
    faults.sync = false;
    await shutdown(); noSeal(); await restart();
    expect(marks.sessionTainted("t", "i")).toBe(true);
  });

  // Mutant per case: skip fsync or ignore append refusal at this producer.
  for (const site of ["own route", "bot creation", "memory record", "install change"] as const) {
    it.each(["append", "fsync"])(`B3-own ${site} refuses a failed %s before mutation`, async (failure) => {
      expect(begin()).toBe(true); marks.markTurnOutside("t", "email");
      const { ownToolGate, ownCreatedBot } = await import("../outside-own.ts");
      const { markRecordOutsideDerived } = await import("../memory/outside-derived.ts");
      const { recordOutsideInstallChange } = await import("../outside-wire.ts");
      if (failure === "append") marks.wireOutsideStore({ ...disk, addOwnWrite: fail }, () => now);
      else faults.sync = true;
      const change = vi.fn();
      if (site === "own route") {
        const decision = ownToolGate({ threadId: "t", botId: "b", tool: "update_bot", targetBotId: "other", lane: false });
        if (!decision) change();
        expect(decision).toHaveProperty("refuse");
      } else if (site === "bot creation") {
        expect(() => { ownCreatedBot("t", "new"); change(); }).toThrow();
      } else if (site === "memory record") {
        expect(() => { markRecordOutsideDerived(undefined as never, "new"); change(); }).toThrow();
      } else {
        const allowed = recordOutsideInstallChange("t", { origin: "engine", title: "Bash", input: { command: "npm install example" } }, root);
        if (allowed) change();
        expect(allowed).toBe(false);
      }
      expect(change).not.toHaveBeenCalled();
      expect(marks.outsideReady()).toBe(false);
      faults.sync = false; await shutdown(); noSeal();
    });
  }

  it("B3-own repeated keys still require append and fsync before another change", async () => {
    expect(begin()).toBe(true);
    expect(marks.ownWrite("bot:repeat")).toBe(true);
    faults.sync = true;
    expect(marks.ownWrite("bot:repeat")).toBe(false);
    expect(marks.outsideReady()).toBe(false);
    faults.sync = false; await shutdown(); noSeal();
  });

  it("B3-terminal producers have no effect after the final seal", async () => {
    expect(begin()).toBe(true); await shutdown();
    const before = readFileSync(path, "utf8");
    const beforeView = view();
    const beforeRegistry = marks.downloadRegistry().list();
    marks.downloadRegistry().add([{ kind: "file", path: join(root, "late"), since: at }]);
    expect(marks.downloadRegistry().list()).toEqual(beforeRegistry);
    marks.markTurnOutside("t", "email");
    marks.markTurnEmailDerived("t");
    marks.noteSessionWrote("t", "i");
    marks.noteSessionEdit("t", "i", "/late");
    marks.noteSessionStart("t", "i", 4);
    expect(marks.ownWrite("late")).toBe(false);
    expect(begin()).toBe(false);
    expect(marks.openOutsideTurn("t", "i")).toBe(false);
    expect(view()).toEqual(beforeView);
    expect(marks.turnEmailDerived("t")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  // Mutants: set-based replay, terminal latch on flush, omission of instance binding.
  it("B3-positional cancelled logoff then lost marks leaves the later open unsealed", async () => {
    expect(begin()).toBe(true);
    expect(await flush()).toBe(true);
    expect(disk.load().opens).toHaveLength(0);
    now++;
    expect(begin(true)).toBe(true);
    marks.markTurnOutside("t", "email"); loseMarks();
    expect(disk.load().opens).toHaveLength(1);
    await restart(); unsealedAt(at + 1);
  });

  it("B3-flush repeated seals retire only earlier opens from their own run", async () => {
    expect(begin()).toBe(true);
    const firstRun = disk.load().opens[0]!.runId;
    await restart();
    expect(await flush()).toBe(true);
    expect(disk.load().opens[0]!.runId).toBe(firstRun);
    expect(marks.beginGuardedOutsideTurn("other", "i", "new", false)).toBe(true);
    expect(await flush()).toBe(true);
    expect(disk.load().opens).toHaveLength(1);
    expect(begin(true)).toBe(true);
    marks.markTurnOutside("t", "email"); loseMarks();
    await restart(); unsealed();
  });

  it("B3-flush no live child seals before the acknowledgement", async () => {
    expect(begin()).toBe(true);
    const order: string[] = [];
    expect(await flush({ flushCoalesced: () => { order.push("flush"); }, closeIdle: async () => {
      order.push("close"); return { confirmed: true, release() { order.push("release"); } };
    } })).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"k":"seal"');
    order.push("ack");
    expect(order).toEqual(["flush", "close", "release", "ack"]);
    await restart(); expect(marks.sessionTainted("t", "i")).toBe(false);
  });

  it("B3-flush an in-flight turn is never closed or sealed", async () => {
    expect(begin()).toBe(true);
    const closeIdle = vi.fn(async () => ({ confirmed: true, release() {} }));
    expect(await flush({ busy: () => true, closeIdle })).toBe(false);
    expect(closeIdle).not.toHaveBeenCalled(); noSeal();
    marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
  });

  it("B3-flush a raised latch never seals", async () => {
    expect(begin()).toBe(true); marks.noteStoreFailure();
    expect(await flush()).toBe(false); noSeal(); await restart(); unsealed();
  });

  it("B3-flush a pending store write never seals", async () => {
    expect(begin()).toBe(true);
    const closeIdle = vi.fn(async () => ({ confirmed: true, release() {} }));
    expect(await flush({ pending: () => true, closeIdle })).toBe(false);
    expect(closeIdle).not.toHaveBeenCalled(); noSeal();
    marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
  });

  it.each(["drained", "failed"])("B3-flush coalesced store writes are %s before closure", async (state) => {
    const atomic = await import("../atomic.ts");
    const key = join(root, "pending");
    expect(begin()).toBe(true);
    const write = vi.fn(() => { if (state === "failed") fail(); writeFileSync(key, "saved"); });
    atomic.scheduleCoalesced(key, write, 60_000);
    const closeIdle = vi.fn(async () => {
      expect(write).toHaveBeenCalledOnce();
      expect(atomic.hasPendingCoalesced(key)).toBe(false);
      return { confirmed: true, release() {} };
    });
    try {
      const result = flush({ flushCoalesced: atomic.flushCoalesced, pending: atomic.hasPendingCoalesced, closeIdle });
      if (state === "failed") {
        await expect(result).rejects.toThrow("disk full");
        expect(atomic.hasPendingCoalesced(key)).toBe(true);
        expect(closeIdle).not.toHaveBeenCalled(); noSeal();
        marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
      } else {
        expect(await result).toBe(true);
        expect(closeIdle).toHaveBeenCalledOnce();
        expect(readFileSync(key, "utf8")).toBe("saved");
        await restart(); expect(marks.sessionTainted("t", "i")).toBe(false);
      }
    } finally { atomic.cancelCoalesced(key); }
  });

  it("B3-flush a write queued during child closure prevents a seal", async () => {
    expect(begin()).toBe(true); let pending = false;
    expect(await flush({ pending: () => pending, closeIdle: async () => {
      pending = true; return { confirmed: true, release() {} };
    } })).toBe(false);
    noSeal(); marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
  });

  it("B3-flush idle warm children close before sealing and admission cannot interleave", async () => {
    expect(begin()).toBe(true);
    let childAlive = true;
    const lateFrame = () => { if (childAlive) marks.markTurnOutside("t", "email"); };
    expect(await flush({ closeIdle: async () => {
      expect(begin(true)).toBe(false);
      await Promise.resolve(); childAlive = false;
      return { confirmed: !childAlive, release() {} };
    } })).toBe(true);
    const before = readFileSync(path, "utf8");
    lateFrame(); expect(readFileSync(path, "utf8")).toBe(before);
    await restart(); expect(marks.sessionTainted("t", "i")).toBe(false);
    // Cancelled logoff rewarms only after another open, whose lost marks recover.
    expect(begin(true)).toBe(true); childAlive = true; lateFrame(); loseMarks();
    await restart(); unsealed();
  });

  it("B3-flush an unconfirmed child means no seal", async () => {
    expect(begin()).toBe(true);
    expect(await flush({ closeIdle: async () => ({ confirmed: false, release() {} }) })).toBe(false);
    noSeal(); marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
  });

  it("B3-flush a closure that confirms after the deadline, before the timer fires, means no seal", async () => {
    // Mutant: remove the post-closure deadline check. The closure blocks past the budget, then resolves confirmed in a microtask that beats the timer.
    expect(begin()).toBe(true);
    const late = async () => { const from = performance.now(); while (performance.now() - from < 30) { /* hold the loop past the budget */ } return { confirmed: true, release() {} }; };
    expect(await flush({ closeIdle: late, budgetMs: 5 })).toBe(false);
    noSeal(); await restart(); unsealed();
  });

  it("B3-flush a child that never closes answers within the bound without a seal", async () => {
    expect(begin()).toBe(true);
    expect(await flush({ closeIdle: () => new Promise(() => {}), budgetMs: 20 })).toBe(false);
    noSeal(); await restart(); unsealed();
  });


  it("B3-synthetic reconciliation honours both instance and session binding", async () => {
    disk.setSession({ threadId: "t", instanceId: "Y", tainted: false, wrote: false, edits: [], startedAt: at - 10 });
    expect(marks.beginGuardedOutsideTurn("t", "X", "x", false)).toBe(true);
    await restart();
    const synthetic = marks.markedTurnsOf("t")[0]!;
    expect(synthetic.instanceId).toBe("X");
    expect(synthetic.sessionKey).toBe(disk.load().sessions.find((row) => row.instanceId === "X")!.sessionKey);
    disk.addMarkedTurn(synthetic);
    await restart();
    expect(marks.sessionTainted("t", "X")).toBe(true);
    expect(marks.sessionTainted("t", "Y")).toBe(false);
    expect(marks.beginGuardedOutsideTurn("t", "X", "replacement", false)).toBe(true);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "X")).toBe(false);
    expect(marks.sessionTainted("t", "Y")).toBe(false);
  });

  // Run Claude's actual idle-close body with controlled child exit confirmations.
  // Mutants: remove closeSession, ignore childExited, close a running child.
  it.each(["idle", "unconfirmed", "in flight"])("B3-flush Claude idle close: %s", async (state) => {
    expect(begin()).toBe(true);
    const source = readFileSync(new URL("../drivers/claude.ts", import.meta.url), "utf8");
    const start = source.indexOf("holdIdle: async () => {");
    const end = source.indexOf("        resetSession:", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const body = source.slice(start + "holdIdle: ".length, end).trim().replace(/,$/, "")
      .replace("const exits: Array<Promise<boolean>>", "const exits");
    const child = { closed: false };
    const sessions = new Map([["t", { child, turn: state === "in flight" ? {} : undefined }]]);
    const active = new Map(state === "in flight" ? [["t", {}]] : []);
    const closeSession = vi.fn(() => { if (state !== "unconfirmed") child.closed = true; });
    const idle = new Function("sessions", "active", "prewarming", "closeSession", "childExited", "retiring", "retiringByThread", "stopRetiring",
      `let idleHeld = 0; const HOLD_CLOSE_MS = 10; return (${body});`)(sessions, active,
      { has: () => false, wait: async () => true }, closeSession, async () => child.closed, new Map(), new Map(), async () => 0);
    expect(source).toContain('closeSession(threadId, "late frames while idle")');
    const sealed = await flush({ busy: () => state === "in flight", closeIdle: idle });
    expect(sealed).toBe(state === "idle");
    if (state === "in flight") expect(closeSession).not.toHaveBeenCalled();
    else expect(closeSession).toHaveBeenCalledWith("t", "deletion-hold");
    if (state === "idle") {
      expect(child.closed).toBe(true);
      const before = readFileSync(path, "utf8");
      if (!child.closed) marks.markTurnOutside("t", "email");
      expect(readFileSync(path, "utf8")).toBe(before);
      await restart(); expect(marks.sessionTainted("t", "i")).toBe(false);
    } else {
      noSeal(); marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
    }
  });


  it.each(["idle", "unconfirmed", "in flight", "timeout"])("B3-flush registry child hold: %s", async (state) => {
    const { ProviderRegistry } = await import("../harness/registry.ts");
    const { makeFakeDriver } = await import("../testing/fake-driver.ts");
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ i: { driver: "fake" } });
    const raw = fake.created.get("i")!;
    let resolveClose!: (hold: { confirmed: boolean; release(): void }) => void;
    const release = vi.fn();
    const closeIdle = vi.fn(() => state === "timeout"
      ? new Promise<{ confirmed: boolean; release(): void }>((resolve) => { resolveClose = resolve; })
      : Promise.resolve({ confirmed: state === "idle", release }));
    raw.instance.adapter.holdIdle = closeIdle;
    if (state === "in flight") raw.emit({ type: "turn.started", eventId: "started", provider: "fake", threadId: "t", createdAt: new Date().toISOString() });
    expect(begin()).toBe(true);
    expect(await flush({ closeIdle: () => registry.holdIdleForFlush(20) })).toBe(state === "idle");
    expect(fake.disposed).toEqual([]);
    expect(registry.get("i")).not.toBeNull();
    if (state === "in flight") expect(closeIdle).not.toHaveBeenCalled();
    else expect(closeIdle).toHaveBeenCalledOnce();
    if (state === "timeout") {
      resolveClose({ confirmed: false, release });
      await Promise.resolve(); await Promise.resolve();
      expect(release).toHaveBeenCalledOnce();
    }
    if (state === "idle") {
      expect(release).toHaveBeenCalledOnce();
      await restart(); expect(marks.sessionTainted("t", "i")).toBe(false);
    } else {
      noSeal(); marks.markTurnOutside("t", "email"); loseMarks(); await restart(); unsealed();
    }
    await registry.disposeAll();
  });

  it("B3-flush production acknowledgement follows the shared boundary on both transports", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function flushRequested(");
    const end = source.indexOf('for (const signal of ["SIGINT", "SIGTERM"]', start);
    const block = source.slice(start, end);
    expect(block.indexOf("await flushOutsideStore(")).toBeGreaterThan(0);
    expect(block.indexOf("writeFlushAck(ack, ok)")).toBeGreaterThan(block.indexOf("await flushOutsideStore("));
    expect(block).toContain("pending: hasPendingCoalesced");
    expect(block).toContain("busy: engineSwitchWouldInterrupt");
    expect(block).toContain("registry.holdIdleForFlush");
    expect(block).not.toContain("disposeAll");
    expect(block).not.toContain("process.exit");
    expect(source).toContain("flushRequested(flushAckPath(message)).then(postDesktopPrivateMessage)");
    expect(source).toContain("flushRequested(flushAckPath(message)).then((reply) => process.send?.(reply))");
  });
  it("B3-app-close and SIGTERM use the same final seal", async () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toContain('process.on(signal, closeRequested)');
    expect(source).toContain('if (isAppCloseRequest(message)) closeRequested()');
    expect(source).toContain('finalCleanup: sealOutsideStore');
    const { isAppCloseRequest } = await import("../graceful-shutdown.ts");
    expect(begin()).toBe(true);
    expect(isAppCloseRequest({ type: "murage:close" })).toBe(true);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
  });
  it("B3-synthetic a legacy turn row naming one instance leaves another instance clean", async () => {
    // Mutant: drop the instance clause from wire-time reconciliation (rows with no session binding rely on it alone).
    disk.setSession({ threadId: "t", instanceId: "Y", tainted: false, wrote: false, edits: [], startedAt: at - 10 });
    disk.addMarkedTurn({ threadId: "t", turnId: "legacy-x", instanceId: "X", at, begunAt: at });
    await restart();
    expect(marks.sessionTainted("t", "Y")).toBe(false);
    disk.addMarkedTurn({ threadId: "t", turnId: "legacy-y", instanceId: "Y", at, begunAt: at });
    await restart();
    expect(marks.sessionTainted("t", "Y")).toBe(true);
  });

  it("B3-flush Claude holdIdle called directly never closes an in-flight turn", async () => {
    // Mutant: remove the in-flight skip from holdIdle (the flush pre-check never reaches it, so this calls the body itself).
    const source = readFileSync(new URL("../drivers/claude.ts", import.meta.url), "utf8");
    const start = source.indexOf("holdIdle: async () => {");
    const end = source.indexOf("        resetSession:", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const body = source.slice(start + "holdIdle: ".length, end).trim().replace(/,$/, "")
      .replace("const exits: Array<Promise<boolean>>", "const exits");
    const child = { closed: false };
    const sessions = new Map([["t", { child, turn: {} }]]);
    const active = new Map([["t", {}]]);
    const closeSession = vi.fn(() => { child.closed = true; });
    const idle = new Function("sessions", "active", "prewarming", "closeSession", "childExited", "retiring", "retiringByThread", "stopRetiring",
      `let idleHeld = 0; const HOLD_CLOSE_MS = 10; return (${body});`)(sessions, active,
      { has: () => false, wait: async () => true }, closeSession, async () => child.closed, new Map(), new Map(), async () => 0);
    const hold = await idle();
    expect(closeSession).not.toHaveBeenCalled();
    expect(child.closed).toBe(false);
    hold.release();
  });

  it("B3-H1 an open for a fresh session after a clean bound row recovers tainted when the new session rows are lost", async () => {
    // Mutant: skip an unsealed open whenever the latest bound row of the key differs (no positional supersede in replay).
    expect(begin()).toBe(true);
    await shutdown(); await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
    expect(begin()).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const opens = lines.map((line) => JSON.parse(line)).filter((row) => row.k === "open");
    const fresh = opens[opens.length - 1].sessionKey as string;
    expect(fresh).not.toBe(opens[0].sessionKey);
    writeFileSync(path, `${lines.filter((line) => { const row = JSON.parse(line); return !(row.k === "session" && row.row.sessionKey === fresh) && row.k !== "mark" && row.k !== "turn"; }).join("\n")}\n`);
    await restart();
    unsealed();
    expect(marks.beginGuardedOutsideTurn("t", "i", "next", true)).toBe(true);
    expect(marks.turnOutsideRead("t")).not.toBeNull();
  });

  it("B3-P2 an unsealed open of an earlier session does not hide a later session whose rows were lost", async () => {
    // Mutant: recovery keeps the state built from the earlier unsealed open and skips the later open of another session.
    expect(begin()).toBe(true);
    await restart();
    unsealed();
    expect(begin()).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const opens = lines.map((line) => JSON.parse(line)).filter((row) => row.k === "open");
    expect(opens).toHaveLength(2);
    const later = opens[1].sessionKey as string;
    expect(later).not.toBe(opens[0].sessionKey);
    writeFileSync(path, `${lines.filter((line) => { const row = JSON.parse(line); return !(row.k === "session" && row.row.sessionKey === later) && row.k !== "mark" && row.k !== "turn"; }).join("\n")}\n`);
    await restart();
    unsealed();
    expect(marks.beginGuardedOutsideTurn("t", "i", "next", true)).toBe(true);
    expect(marks.turnOutsideRead("t")).not.toBeNull();
    expect([...marks.markedTurnsOf("t")].some((turn) => turn.sessionKey === later)).toBe(true);
  });

  it("B3-L1 a close during a logoff flush still writes the terminal seal", async () => {
    // Mutant: sealOutsideStore returns while flushBoundary is set (the seal is skipped silently).
    expect(begin()).toBe(true);
    let finish!: (hold: { confirmed: boolean; release(): void }) => void;
    const flushing = marks.flushOutsideStore({ flushCoalesced() {}, busy: () => false, pending: () => false, budgetMs: 1000,
      closeIdle: () => new Promise((resolve) => { finish = resolve; }) });
    await shutdown();
    expect(readFileSync(path, "utf8")).toContain('"k":"seal"');
    finish({ confirmed: true, release() {} });
    expect(await flushing).toBe(false);
    await restart();
    expect(marks.sessionTainted("t", "i")).toBe(false);
  });

  it("B3-L2 the refusal text during a logoff flush says so, and the disk text returns after it", async () => {
    // Mutant: outsideRefusalMessage ignores the flush boundary.
    expect(marks.outsideRefusalMessage()).toContain("Check available disk space");
    let finish!: (hold: { confirmed: boolean; release(): void }) => void;
    const flushing = marks.flushOutsideStore({ flushCoalesced() {}, busy: () => false, pending: () => false, budgetMs: 1000,
      closeIdle: () => new Promise((resolve) => { finish = resolve; }) });
    expect(begin()).toBe(false);
    expect(marks.outsideRefusalMessage()).toMatch(/^Murage is saving its place before it closes, so this turn did not run\. Send it again in a moment\.$/);
    expect(marks.outsideRefusalMessage()).not.toContain("disk");
    finish({ confirmed: true, release() {} });
    expect(await flushing).toBe(true);
    expect(marks.outsideRefusalMessage()).toContain("Check available disk space");
  });

  it("B3-W199 scan hooks do not treat a symlinked program in the work folder as read-only", async (ctx) => {
    const { scanDisk, outsideContextFields } = await import("../outside-wire.ts");
    const { noteEnginePath, forgetEngineEnv, outsideScanMarks, readOnlyShape } = await import("../outside-scan.ts");
    const bin = join(root, "bin"), work = join(root, "work"), outside = join(root, "outside");
    for (const dir of [bin, work, outside]) mkdirSync(dir);
    writeFileSync(join(work, "reader"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(outside, "reader"), "#!/bin/sh\n", { mode: 0o755 });
    // Windows creates a file symlink only with the symlink privilege (Developer Mode or an elevated user): skip on that box only when it is refused.
    try { symlinkSync(join(work, "reader"), join(bin, "ls")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32") ctx.skip(); throw error; }
    symlinkSync(join(outside, "reader"), join(bin, "cat"));
    // Put the turn after the fixture's file timestamps so freshness cannot hide the lookup defect.
    marks.wireOutsideStore(disk, () => Date.now() + 60_000);
    expect(begin()).toBe(true);
    noteEnginePath("t", bin);
    try {
      const hooks = scanDisk("t", work);
      expect(hooks.probe?.(join(bin, "ls"), true)?.real).toBe(join(work, "reader"));
      expect(readOnlyShape("ls -la", hooks)).toBe(false);
      expect(outsideScanMarks("ls -la", hooks)).toContain("interpreter");
      expect(readOnlyShape("ls -la", outsideContextFields("t", work).readOnlyHooks)).toBe(false);
      expect(readOnlyShape("cat example.txt", hooks)).toBe(true);
    } finally { forgetEngineEnv(); }
  });
});
