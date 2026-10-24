// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r25 (Astra r24c): when Murage cannot prove that no one can still write a file, it never removes or cuts it; the home stays pending
// and is tried again. No restart rule: a process of the owner's whose open files cannot be read keeps the home pending with the
// engine-unchecked line, whatever the file's age. An interrupted join is never undone by a cut: both files stay exactly as they are and
// the home stays pending. A journal whose barrier was only the fallback is dropped only after the operating system has restarted and
// the bytes are found as written. A root process whose open files cannot be read is not counted (accepted residual R7).
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { owedCodeOf, ownerNoticeText } from "./conversation-deletion.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { loadExclusionAddon } from "./engine-exclusion.ts";
import { exclOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { removeEngineHistoryFiles as removeRaw } from "./engine-history-run.ts";
import { homeKey, Known, Planner, UNDO_JOIN_TRIES, type HomePlanData } from "./engine-plan-core.ts";
import { bootOps, listRedo, redoDirectory } from "./engine-redo.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { legacyRejoin, buildFixture, canaryHits, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// the boot of the operating system this "run" is in (engine-redo.ts bootOps); a restart of the computer is a new one
const realBoot = bootOps.current;
let boots = 1;
const removeEngineHistoryFiles = legacyRejoin(removeRaw);
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-r25-")));
afterAll(() => removeTempDirSync(scratch));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); clearJournals(); boots = 1; bootOps.current = () => ({ boot: `boot-${boots}`, uptime: 1_000 }); });
afterEach(() => { fake.restore(); bootOps.current = realBoot; });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const C = (engine: string) => `canary-${engine}-5521`;
const B = (engine: string) => `bystander-${engine}-9917`;
function clearJournals(): void { const dir = redoDirectory(); if (dir && existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true }); }
const journalFiles = (): string[] => { const dir = redoDirectory(); return dir && existsSync(dir) ? readdirSync(dir) : []; };
const ROLLOUT = ["sessions", "2026", "10", "11", "rollout-2026-10-11T10-00-00-019a0000-aaaa-7bbb-8ccc-000000000001.jsonl"];
/** c8ac27c9f's restart rule read exclOps.bootTimeMs: model "the computer restarted after every file here last changed" where it exists
 * (no member at all now; assigning one changes nothing). */
const restartedSinceFilesChanged = () => { (exclOps as unknown as { bootTimeMs?: () => number }).bootTimeMs = () => Date.now() + 60_000; };
/** The computer restarted (a power cut and a restart): a new boot of the operating system. */
const computerRestarted = () => { boots++; };
const withSync = (answer: (fd: number) => unknown, work: () => void) => {
  const addon = loadExclusionAddon()! as unknown as { fullSync: (fd: number) => unknown };
  const before = addon.fullSync;
  addon.fullSync = answer;
  try { work(); } finally { addon.fullSync = before; }
};

// ── 1. no restart rule: a writer that cannot be ruled out keeps the file, whatever its age ─────────────────────────────

describe("a process of the owner's whose open files cannot be read: the file stays and the home is pending, after a restart too", () => {
  for (const [label, answer] of [
    ["Linux without leases (NFS, FUSE home) and an undumpable process of the owner's", { writers: [], unreadable: [{ pid: 812, uid: 1000 }], openForWrite: null }],
    ["macOS: a process whose fd table cannot be read (uid unknown)", { writers: [], unreadable: [{ pid: 640, uid: null }] }],
  ] as const) {
    it(`${label}: 'engine-unchecked', and the rollout is still there after the computer restarted (an editor opened it after the restart)`, () => {
      const fx = buildFixture("codex", scratch);
      const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
      fake.onWriters = () => answer as never;
      restartedSinceFilesChanged();
      for (let attempt = 0; attempt < 3; attempt++) {
        const ran = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
        expect(ran.failedHomes).toEqual([key(fx)]);
        expect(ran.homeReasons?.[key(fx)]).toBe("engine-unchecked");
        expect(existsSync(rollout)).toBe(true);
      }
    });
  }

  it("a group-writable engine file and another user's unreadable process: pending, never removed on the file's age", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    chmodSync(rollout, 0o664);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 89, uid: 89 }] });
    restartedSinceFilesChanged();
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions).homeReasons?.[key(fx)]).toBe("engine-unchecked");
    expect(existsSync(rollout)).toBe(true);
  });

  it("the owner is never told a restart finishes it: the restart line is gone and the engine-unchecked line is as approved", () => {
    expect(owedCodeOf("engine-unseen")).not.toBe("engine-unseen");
    expect(ownerNoticeText("Kimi", "engine-unchecked")).toBe("Murage could not check whether Kimi is open. It checks again within 10 minutes and finishes removing this conversation by itself.");
    for (const code of ["engine-open", "engine-unchecked", "held", "aside", "other"] as const) expect(ownerNoticeText("Kimi", code)).not.toMatch(/restart/i);
  });
});

// ── 4. a root process whose open files cannot be read is not counted (accepted residual R7) ─────────────────────────────

describe("macOS: an unreadable root process (every Mac runs root daemons) does not hold a deletion", () => {
  it("is not counted, documented as R7: an engine renamed and running as root is an identification miss, not something this check sees", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 99, uid: 0 }] });
    const ran = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(ran.failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("not even for a group-writable file: root is never counted (the system's other users are)", () => {
    const fx = buildFixture("codex", scratch);
    const rollout = join(fx.homes[0]!.home, ...ROLLOUT);
    chmodSync(rollout, 0o664);
    fake.onWriters = () => ({ writers: [], unreadable: [{ pid: 1, uid: 0 }] });
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions).failedHomes).toEqual([]);
    expect(existsSync(rollout)).toBe(false);
  });
});

// ── 2. an undo of a join never cuts bytes that are not the join's own ──────────────────────────────────────────────────

/** A Kimi home as an earlier attempt left it: the old index set aside, and the new one Kimi started at the name meanwhile; then a join
 * cut half way by a failed write. */
function cutJoin(): { fx: Fixture; index: string; away: string; base: number } {
  const fx = buildFixture("kimi", scratch);
  const index = join(fx.homes[0]!.home, "session_index.jsonl");
  const away = `${index}.murage-deleting`;
  writeFileSync(away, readFileSync(index));
  writeFileSync(index, dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }) + dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" }));
  const base = statSync(away).size;
  const real = { pwrite: mutOps.pwrite };
  let cut = false;
  mutOps.pwrite = ((fd: number, bytes: Buffer, position: number) => {
    if (!cut && bytes.includes("NEWER-ROW-ONE")) { cut = true; writeSync(fd, bytes, 0, 40, position); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
    return real.pwrite(fd, bytes, position);
  }) as typeof mutOps.pwrite;
  try { removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { Object.assign(mutOps, real); }
  expect(cut).toBe(true);
  return { fx, index, away, base };
}

describe("a join undone after a power cut: only the join's own bytes ever come off", () => {
  it("Astra r24c: another program appends a bystander to the older file; every try keeps it, the journal stays, and nothing is cut", () => {
    const { index, away, base } = cutJoin();
    // the power cut undid the rename (the newer file is public again); a program opens the older aside, appends a row and closes it
    renameSync(`${index}.murage-rejoining`, index);
    const bystander = dump({ sessionId: "s-by", workDir: "/by", title: B("kimi") });
    appendFileSync(away, bystander);
    const size = statSync(away).size;
    const before = readFileSync(away);
    for (let attempt = 1; attempt <= UNDO_JOIN_TRIES + 2; attempt++) {
      const ran = recoverAll();
      expect(ran.pending, `attempt ${attempt}`).toHaveLength(1);
      expect(statSync(away).size, `attempt ${attempt}`).toBe(size); // never cut to the join's start (151 -> 63 at c8ac27c9f)
      expect(readFileSync(away).equals(before)).toBe(true);
      expect(readFileSync(away, "utf8")).toContain(B("kimi"));
      expect(listRedo().filter((item) => item.kind === "join"), `attempt ${attempt}`).toHaveLength(1);
    }
    expect(size).toBeGreaterThan(base);
    expect(existsSync(index)).toBe(true);
  });

  it("the engine rewrote its newer file in place: both files stay exactly as they are, past every try", () => {
    const { index, away } = cutJoin();
    renameSync(`${index}.murage-rejoining`, index);
    const rewritten = dump({ sessionId: "s5", workDir: "/fifth", title: "REWRITTEN-ROW-FIVE" });
    writeFileSync(index, rewritten);
    const before = readFileSync(away);
    for (let attempt = 1; attempt <= UNDO_JOIN_TRIES + 2; attempt++) expect(recoverAll().pending).toHaveLength(1);
    expect(readFileSync(away).equals(before)).toBe(true);
    expect(readFileSync(index, "utf8")).toBe(rewritten);
    const joins = listRedo().filter((item) => item.kind === "join");
    expect(joins).toHaveLength(1);
    expect(joins[0]!.kind === "join" && joins[0]!.undo).toBe(UNDO_JOIN_TRIES); // counted up to the cap, then no longer written again
  });

  it("bytes that ARE the start of the join's own: nothing is cut either; both files stay exactly as they are and the journal stays", () => {
    const { index, away, base } = cutJoin();
    renameSync(`${index}.murage-rejoining`, index);
    const older = readFileSync(away), newer = readFileSync(index);
    for (let attempt = 1; attempt <= UNDO_JOIN_TRIES + 2; attempt++) {
      expect(recoverAll().pending, `attempt ${attempt}`).toHaveLength(1);
      expect(readFileSync(away).equals(older), `attempt ${attempt}`).toBe(true);
      expect(readFileSync(index).equals(newer), `attempt ${attempt}`).toBe(true);
    }
    expect(statSync(away).size).toBeGreaterThan(base);
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
  });
});

// ── 3. the fallback barrier: a journal goes only after the computer restarted and the bytes are read again ──────────────────────────────

/** A Fuigo log with one row to clear and one bystander, and its plan. */
function fuigoLog(): { log: string; original: Buffer; plans: Record<string, HomePlanData> } {
  const fx = buildFixture("fuigo", scratch);
  const home = fx.homes[0]!.home;
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, dump({ sid: "s-1", text: `PRIVATE ${C("fuigo")}` }) + dump({ sid: "s-other", text: B("fuigo") }));
  const pl = new Planner(realEngineFs(), new Known());
  pl.rewrite(log, { pred: { any: [{ field: "sid", op: "in", values: ["s-1"] }] }, needles: ["s-1"], format: "fuigo-unified", how: "lock" });
  return { log, original: readFileSync(log), plans: { [homeKey("fuigo", home)]: { engine: "fuigo", home, steps: pl.steps } as HomePlanData } };
}
const fallback = () => "fallback";

describe.skipIf(process.platform === "win32")("Astra r24c: after the fallback barrier the journal is never dropped before a restart of the computer and a read of the bytes", () => {
  it("second power cut: the journal survives the fallback and every run in the same boot, so the lost repair is made again after the restart", () => {
    const { log, original, plans } = fuigoLog();
    let ran!: ReturnType<typeof executeEnginePlans>;
    withSync(fallback, () => { ran = executeEnginePlans(plans); });
    expect(ran.failedHomes).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(journalFiles()).toHaveLength(1); // c8ac27c9f dropped it here
    // the same boot never drops it, whatever its barrier now
    withSync(fallback, () => { expect(recoverAll().pending).toEqual([]); });
    expect(recoverAll().pending).toEqual([]);
    expect(journalFiles()).toHaveLength(1);
    // the modeled power cut: the drive kept the journal but lost the repaired bytes (they come back as they were)
    writeFileSync(log, original);
    computerRestarted();
    withSync(fallback, () => { recoverAll(); });
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
    expect(readFileSync(log, "utf8")).toContain(B("fuigo"));
    expect(journalFiles()).toHaveLength(1); // repaired again under the fallback: kept for the start after
    computerRestarted();
    withSync(fallback, () => { recoverAll(); });
    expect(journalFiles()).toEqual([]); // that start found the repair on the drive
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
  });

  it("after a restart of the computer, a read that finds the rows cleared drops the journal with nothing written", () => {
    const { log, plans } = fuigoLog();
    withSync(fallback, () => { executeEnginePlans(plans); });
    const after = readFileSync(log);
    computerRestarted();
    fake.calls.length = 0;
    withSync(fallback, () => { expect(recoverAll().pending).toEqual([]); });
    expect(fake.calls.filter((call) => call === "pwrite")).toEqual([]);
    expect(readFileSync(log).equals(after)).toBe(true);
    expect(journalFiles()).toEqual([]);
  });

  it("a crash journal repaired at a start whose barrier falls back stays until the computer restarts, and the full barrier drops it at once", () => {
    const { log, plans } = fuigoLog();
    withSync(() => undefined, () => { executeEnginePlans(plans); }); // no barrier named: the journal stays unmarked
    expect(journalFiles()).toHaveLength(1);
    withSync(fallback, () => { recoverAll(); });
    expect(journalFiles()).toHaveLength(1);
    withSync(fallback, () => { recoverAll(); });
    expect(journalFiles()).toHaveLength(1);
    computerRestarted();
    withSync(fallback, () => { recoverAll(); });
    expect(journalFiles()).toEqual([]);
    expect(readFileSync(log, "utf8")).not.toContain(C("fuigo"));
  });

  it("a join under the fallback keeps the engine's newer file until, after a restart of the computer, a read finds its rows in the older one", () => {
    const fx = buildFixture("kimi", scratch);
    const index = join(fx.homes[0]!.home, "session_index.jsonl");
    const away = `${index}.murage-deleting`;
    writeFileSync(away, readFileSync(index));
    const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" }), dump({ sessionId: "s4", workDir: "/fourth", title: "NEWER-ROW-TWO" })];
    writeFileSync(index, newer.join(""));
    let first!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); });
    expect(first.failedHomes).toEqual([key(fx)]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(true); // the only other copy of the rows is kept
    expect(listRedo().filter((item) => item.kind === "join")).toHaveLength(1);
    computerRestarted();
    let again!: ReturnType<typeof removeEngineHistoryFiles>;
    withSync(fallback, () => { again = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery ?? {}); });
    expect(again.failedHomes).toEqual([]);
    expect(existsSync(`${index}.murage-rejoining`)).toBe(false);
    const text = readFileSync(index, "utf8");
    for (const row of newer) expect(text).toContain(row);
    expect(text).toContain(B("kimi"));
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});
