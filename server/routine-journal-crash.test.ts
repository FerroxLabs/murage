// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";


const fault = vi.hoisted(() => ({ stage: "", atName: "", once: false, fdNames: new Map<number, string>(), events: [] as string[], io: { open: 0, close: 0, fsync: 0, rename: 0, bytes: 0, writeCalls: 0 }, observeTag: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const hit = (stage: string, path = "") => { if (fault.stage === stage && (!fault.atName || path.endsWith(fault.atName))) { fault.once = true; fault.stage = ""; throw new Error(`fault:${stage}`); } };
  return { ...fs,
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => { hit("mkdir"); return fs.mkdirSync(...args); },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      hit(path.endsWith(".jsonl") ? "open" : path.includes("routines.json.") ? "pin-open" : path.endsWith(".compact") ? "temp-open" : "directory-open", path);
      const fd = fs.openSync(...args); fault.fdNames.set(fd, path); fault.io.open++; return fd;
    },
    fsyncSync: (fd: number) => {
      const path = fault.fdNames.get(fd) ?? "";
      fault.events.push(`fsync:${path}`); fault.io.fsync++;
      hit(path.endsWith(".jsonl") ? "fsync" : path.endsWith(".compact") ? "temp-fsync" : path.includes("routines.json.") ? "pin-fsync" : "directory-fsync", path);
      return fs.fsyncSync(fd);
    },
    closeSync: (fd: number) => { fault.io.close++; fault.fdNames.delete(fd); return fs.closeSync(fd); },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { fault.io.rename++; hit(String(args[0]).endsWith(".compact") ? "temp-rename" : "pin-rename"); return fs.renameSync(...args); },
  };
});
// Inject at the counted writer used by the journal, preserving real writes and accounting.
vi.mock("./counted-fs.ts", async original => {
  const fs = await original<typeof import("./counted-fs.ts")>();
  const { writeJournalPrefix } = await import("./testing/journal-write-fixture.ts");
  return { ...fs,
    writeSync: (...args: unknown[]) => {
      fault.io.writeCalls++;
      const fd = args[0] as number, data = args[1] as Buffer, offset = args[2] as number, length = args[3] as number;
      const text = Buffer.isBuffer(data) ? data.subarray(offset, offset + length).toString("utf8") : String(data);
      if (text.includes('"$c":')) fault.observeTag?.();
      fault.events.push(`write:${fault.fdNames.get(fd)}`);
      if (fault.stage === "zero") { fault.once = true; fault.stage = ""; return 0; }
      if (fault.stage === "invalid") { fault.once = true; fault.stage = ""; return length + 1; }
      if (fault.stage === "torn") {
        fault.once = true; fault.stage = ""; writeJournalPrefix(fs.writeSync, args, data.indexOf(10, offset) - offset + 1 + 17); throw new Error("torn");
      }
      const progress = (fs.writeSync as (...values: unknown[]) => number)(...args); fault.io.bytes += progress; return progress;
    },
  };
});
vi.resetModules();
const { collectionWorkProbe } = await import("./testing/collection-work-probe.ts");
const { RoutineRunsJournal, JournalWriteError, readRoutineRuns, readRoutineStates, readRoutinesWithRuns, routineRunsDir, routineRunsFileName } = await import("./routine-runs-journal.ts");
const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "murage-journal-crash-")); dirs.push(dir); return dir; }
const run = (id = "a", routineId = "r", output = "before") => ({ id, routineId, status: "completed", output });
const append = (journal: InstanceType<typeof RoutineRunsJournal>, runs: ReturnType<typeof run>[], removed: ReturnType<typeof run>[] = []) => journal.append({ runs, routines: [], removed });
const resetIO = () => { fault.io = { open: 0, close: 0, fsync: 0, rename: 0, bytes: 0, writeCalls: 0 }; };
afterEach(() => { fault.stage = ""; fault.atName = ""; fault.observeTag = undefined; fault.fdNames.clear(); fault.events.length = 0; resetIO(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

for (const stage of ["mkdir", "open", "torn", "fsync", "zero", "invalid"]) for (const writer of ["append", "sync"] as const) it(`P18/P30 C3-C5/C13-C15 ${writer} ${stage}: uncertain baselines force repair, attempted new IDs get durable deletes`, () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g"); append(journal, [run()]);
  const before = journal.persistedCount;
  fault.once = false; fault.stage = stage;
  let thrown: unknown;
  try { if (writer === "sync") journal.sync([run("a", "r", "after"), run("new", "r", "queued")], 1); else append(journal, [run("a", "r", "after"), run("new", "r", "queued")]); }
  catch (error) { thrown = error; }
  expect(fault.once, "fault reached the physical journal boundary").toBe(true);
  expect(thrown, "named write-progress/file error").toBeInstanceOf(JournalWriteError);
  expect(journal.durabilityKnown).toBe(false);
  expect(journal.persistedCount, "uncertain new membership").toBe(before + 1);
  expect(journal.verifyFileIndexes()).toEqual([]);
  if (writer === "sync") {
    expect(journal.highestTag).toBe(1); expect(journal.pendingCommit).toBe(1);
    journal.sync([run()], 1); // Retry same pending transaction; new ID must be deleted, not forgotten.
    writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 1, stateGeneration: "g" })); journal.markCommitted(1);
  } else append(journal, [run()], [run("new")]);
  expect(journal.persistedCount).toBe(1);
  expect(readRoutineRuns(dir, writer === "sync" ? 1 : 0), "raw replay after bounded reconciliation").toEqual([run()]);
  expect(journal.verifyFileIndexes()).toEqual([]);
});

it("P18 C7/C12 accepts pre-reconcile uncertainty; failed tombstone keeps ID until durable retry", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  fault.stage = "fsync"; expect(() => append(journal, [run("new")])).toThrow();
  expect(readRoutineRuns(dir, 0)).toEqual([run("new")]); // complete bytes can survive the reported failure
  fault.stage = "fsync"; expect(() => append(journal, [], [run("new")])).toThrow();
  expect(journal.persistedCount).toBe(1); expect(journal.durabilityKnown).toBe(false);
  append(journal, [], [run("new")]);
  expect(journal.persistedCount).toBe(0); expect(readRoutineRuns(dir, 0)).toEqual([]);
});

it("P18 C8 one state line carries both run and routine, generation gates only routine", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  const routine = { id: "r", nextRunAt: 50 };
  journal.append({ runs: [run()], routines: [routine], removed: [] });
  expect(readRoutineStates(dir, 0, "g").get("r")).toEqual(routine);
  expect(readRoutineStates(dir, 0, "other").size).toBe(0);
  expect(readRoutineRuns(dir, 0)).toEqual([run()]);
});

it("P36 C9a established commit rejects pre-publication sync; accepts it after publication", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(4, "g"); append(journal, [run()]);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 4, stateGeneration: "g" }));
  journal.sync([run("a", "r", "after")], 5);
  journal.compact(); // must not strip the pending tag
  expect(readRoutineRuns(dir, 4), "established pre-publication rejection").toEqual([run()]);
  expect(readRoutineRuns(dir, 5)).toEqual([run("a", "r", "after")]);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 5, stateGeneration: "new" }));
  journal.markCommitted(5); journal.setGeneration("new"); journal.compact();
  expect(readRoutineRuns(dir, 5)).toEqual([run("a", "r", "after")]); expect(journal.verifyFileIndexes()).toEqual([]);
});

for (const marker of [undefined, "invalid"]) it(`P36 C9b legacy ${String(marker)} exact pin projection, ordering and subsequent interrupted tag`, () => {
  const dir = fixture(); mkdirSync(routineRunsDir(dir), { recursive: true });
  const original = { runsCommit: marker, stateGeneration: "g", unknown: [1, 2], routines: [{ id: "r", nextRunAt: 1 }], runs: [run("embedded", "r", "override")] };
  writeFileSync(join(dir, "routines.json"), JSON.stringify(original));
  const state = { $routine: { id: "r", nextRunAt: 9 }, $gen: "g", $runs: [run("carried")], $c: 7 };
  writeFileSync(join(routineRunsDir(dir), "r.jsonl"), [JSON.stringify(run()), JSON.stringify({ ...run("embedded"), $c: 3 }), JSON.stringify(state), JSON.stringify({ ...run("invalid"), $c: "bad" })].join("\n") + "\n");
  const before = readRoutinesWithRuns(join(dir, "routines.json"));
  const journal = new RoutineRunsJournal(dir); journal.load(undefined, "g");
  expect(journal.highestTag).toBe(7); expect(journal.baselineCommit).toBe(7);
  const pinned = JSON.parse(readFileSync(join(dir, "routines.json"), "utf8"));
  expect(pinned, "pin preserves embedded/unknown/generation").toEqual({ ...original, runsCommit: 7 });
  expect(readRoutinesWithRuns(join(dir, "routines.json"))).toEqual({ ...before, runsCommit: 7 });
  let observed = 0;
  fault.observeTag = () => {
    observed++;
    expect(JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).runsCommit, "marker before first tag").toBe(7);
    expect(fault.events.some(event => event.startsWith("fsync:") && event.includes("routines.json.")), "pin file fsync").toBe(true);
    expect(fault.events.some(event => event === `fsync:${dir}`), "pin directory fsync").toBe(true);
  };
  journal.sync([run("a", "r", "new")], 8);
  expect(observed).toBeGreaterThan(0);
  expect(readRoutineRuns(dir, 7).find(value => (value as { id: string }).id === "a")).toEqual(run());
  expect(journal.verifyFileIndexes()).toEqual([]);
});

for (const stage of ["pin-open", "pin-fsync", "pin-rename", "directory-fsync"]) it(`P36 C9b ${stage} failure leaves baseline unavailable and emits no tagged bytes`, () => {
  const dir = fixture(); writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines: [], unknown: "preserve" }));
  const journal = new RoutineRunsJournal(dir); let newTags = 0; fault.observeTag = () => newTags++;
  fault.stage = stage; expect(() => journal.load(undefined, "g")).toThrow(JournalWriteError);
  expect(journal.baselineCommit).toBeUndefined(); expect(newTags).toBe(0);
  journal.load(undefined, "g");
  expect(journal.baselineCommit).toBe(0);
});

it("P30 exact live/count on cross-file moves, deletes, state invalidation, corruption and repair", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  append(journal, [run()]); append(journal, [run("a", "z")]);
  expect(readRoutineRuns(dir, 0)).toEqual([run("a", "z")]); expect(journal.persistedCount).toBe(1);
  journal.append({ runs: [], routines: [{ id: "z" }], removed: [] }); expect(journal.verifyFileIndexes()).toEqual([]);
  journal.setGeneration("other"); expect(journal.verifyFileIndexes()).toEqual([]);
  const files = (journal as unknown as { files: Map<string, { live: number }> }).files;
  files.get("z.jsonl")!.live++;
  expect(journal.verifyFileIndexes()).toContain("files.live:z.jsonl"); journal.rebuildFileIndexes();
  expect(journal.verifyFileIndexes()).toEqual([]);
  append(journal, [], [run("a", "z")]); append(journal, [], [run("a", "z")]);
  expect(journal.persistedCount).toBe(0); expect(journal.verifyFileIndexes()).toEqual([]);
});

it("P3 each of 200 appends uses only per-file buckets; small 256 copy and large 2000 copy slices obey individual IO ceilings", () => {
  const measurements: Array<Record<string, number>> = [];
  for (const size of [256, 257, 2000]) {
    const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
    const runs = Array.from({ length: size }, (_, i) => run(`id-${i}`)); append(journal, runs);
    let phases = 0, completed = false;
    for (let i = 0; i < size + 200; i++) {
      journal.resetWork(); resetIO();
      const changed = run("id-0", "r", String(i)); append(journal, [changed]);
      expect(journal.work.fullTraversals, "no full journal walk").toBe(0);
      expect(journal.work.compactCopied).toBeLessThanOrEqual(size <= 256 ? 256 : 64);
      expect(journal.work.journalLines + journal.work.compactCopied).toBeLessThanOrEqual(2 + 256);
      const maxLineBytes = Buffer.byteLength(JSON.stringify(run("id-1999")) + "\n");
      expect(fault.io.bytes).toBeLessThanOrEqual((2 + 256) * maxLineBytes);
      expect(fault.io.writeCalls).toBeLessThanOrEqual(3);
      expect(fault.io.fsync).toBeLessThanOrEqual(2); expect(fault.io.rename).toBeLessThanOrEqual(1); expect(fault.io.open).toBeLessThanOrEqual(3); expect(fault.io.close).toBeLessThanOrEqual(3);
      measurements.push({ live: size, operation: i, journalLines: journal.work.journalLines, compactCopied: journal.work.compactCopied, ...fault.io });
      if (journal.work.compactCopied) phases++;
      if (fault.io.rename) completed = true;
      if (size > 256 && phases && !completed) expect(readdirSync(routineRunsDir(dir))).toContain("r.jsonl.compact");
    }
    expect(phases).toBeGreaterThan(0); expect(completed).toBe(true);
    expect(readRoutineRuns(dir, 0)).toHaveLength(size); expect(journal.verifyFileIndexes()).toEqual([]);
  }
  writeFileSync(join(process.env.RHIST_EVIDENCE_DIR ?? tmpdir(), "s4-B-journal-measurements.json"), JSON.stringify(measurements, null, 2));
});

it("P3/P32 ongoing compaction cursor created before probe is charged to its file, global history visits zero", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  append(journal, Array.from({ length: 2000 }, (_, i) => run(`id-${i}`)));
  for (let i = 0; i < 2052; i++) append(journal, [run("id-0", "r", String(i))]);
  const probe = collectionWorkProbe(); journal.resetWork();
  probe.measure(() => append(journal, [run("id-1", "r", "changed")]));
  expect(journal.work.journalLines, "live plus mirrored line count").toBe(2);
  expect(journal.work.compactCopied).toBeLessThanOrEqual(64);
  expect(probe.counts["journal.runs:r.jsonl"].next).toBeLessThanOrEqual(65);
  expect(probe.counts["journal.runs:r.jsonl"].next).toBeGreaterThan(0);
  for (const name of ["journal.persisted", "journal.routineLines", "journal.files"]) {
    expect(probe.counts[name]?.next ?? 0).toBe(0); expect(probe.counts[name]?.forEachVisit ?? 0).toBe(0);
  }
  journal.setGeneration("g"); // Lifecycle teardown closes the unfinished cursor after its measured slice.
});

for (const stage of ["temp-fsync", "temp-rename"]) it(`P18 C10/C11 ${stage}: live file remains authoritative and temp is discarded`, () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  append(journal, Array.from({ length: 257 }, (_, i) => run(`id-${i}`)));
  let faulted = false;
  for (let i = 0; i < 320; i++) {
    fault.stage = stage; append(journal, [run("id-0", "r", String(i))]);
    if (journal.work.compactFaults) { faulted = true; break; }
  }
  fault.stage = ""; expect(faulted).toBe(true); expect(readRoutineRuns(dir, 0)).toHaveLength(257);
  expect(readdirSync(routineRunsDir(dir)).filter(name => name.endsWith(".compact"))).toEqual([]);
  const fresh = new RoutineRunsJournal(dir); expect(fresh.load(0, "g")).toHaveLength(257);
});

it("P36 first-new-tag observer sees an already published and fsynced legacy marker", () => {
  const dir = fixture(); mkdirSync(routineRunsDir(dir), { recursive: true });
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ stateGeneration: "g", routines: [], runs: [run("embedded")] }));
  writeFileSync(join(routineRunsDir(dir), "r.jsonl"), JSON.stringify({ ...run(), $c: 7 }) + "\n");
  const journal = new RoutineRunsJournal(dir);
  const observations: Array<{ marker: unknown; file: boolean; directory: boolean }> = [];
  fault.observeTag = () => observations.push({
    marker: JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).runsCommit,
    file: fault.events.some(event => event.startsWith("fsync:") && event.includes("routines.json.")),
    directory: fault.events.includes(`fsync:${dir}`),
  });
  journal.load(undefined, "g"); journal.sync([run("a", "r", "after")], 8);
  expect(observations, "first-tag durable marker barrier").toEqual([{ marker: 7, file: true, directory: true }]);
  expect(readRoutineRuns(dir, 7)).toEqual([run()]);
});

for (const runCount of [254, 255]) it(`P3/P30 colliding state IDs count toward ${runCount + 2} live records and the compaction boundary`, () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  const first = "unsafe/routine", second = routineRunsFileName(first).slice(0, -6), name = routineRunsFileName(first);
  expect(routineRunsFileName(second)).toBe(name);
  const states = [{ id: first }, { id: second }];
  const runs = Array.from({ length: runCount }, (_, i) => run(`id-${i}`, first));
  journal.append({ runs, routines: states, removed: [] });
  let maximumCopy = 0;
  for (let n = 0; n < 2 * (runCount + 2) + 60; n++) {
    journal.resetWork(); resetIO(); journal.append({ runs: [], routines: [{ id: first, nextRunAt: n } as { id: string }], removed: [] });
    maximumCopy = Math.max(maximumCopy, journal.work.compactCopied);
    expect(fault.io.fsync).toBeLessThanOrEqual(2); expect(fault.io.rename).toBeLessThanOrEqual(1);
    expect(fault.io.open).toBeLessThanOrEqual(3); expect(fault.io.close).toBeLessThanOrEqual(3);
    expect(fault.io.writeCalls).toBeLessThanOrEqual(3);
    expect(journal.work.compactCopied).toBeLessThanOrEqual(runCount === 254 ? 256 : 64);
  }
  expect(maximumCopy, "collision compaction actually exercised").toBe(runCount === 254 ? 256 : 64);
  journal.resetWork(); resetIO();
  // The next append is at/just after the trigger and cannot synchronously copy a 257-live file.
  for (let n = 0; n < 8; n++) {
    journal.resetWork(); journal.append({ runs: [], routines: [{ id: first, nextRunAt: 10_000 + n } as { id: string }], removed: [] });
    expect(journal.work.compactCopied).toBeLessThanOrEqual(runCount === 254 ? 256 : 64);
    expect(journal.verifyFileIndexes()).toEqual([]);
  }
  expect(journal.persistedCount).toBe(runCount); expect(readRoutineStates(dir, 0, "g").size).toBe(2);
  journal.setGeneration("new"); expect(journal.verifyFileIndexes()).toEqual([]);
});

for (const stage of ["fsync", "torn"]) it(`P18 ${stage} reconciliation raw replay restores the existing run and deletes the attempted append`, () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g"); append(journal, [run()]);
  fault.stage = stage; expect(() => append(journal, [run("a", "r", "after"), run("new", "r", "queued")])).toThrow();
  append(journal, [run()], [run("new")]);
  expect(readRoutineRuns(dir, 0), "raw reconciliation pre-state/no resurrection").toEqual([run()]);
});

it("P36 pin preserves every legacy-accepted old tagged value", () => {
  const dir = fixture(); mkdirSync(routineRunsDir(dir), { recursive: true });
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines: [] }));
  writeFileSync(join(routineRunsDir(dir), "r.jsonl"), JSON.stringify({ ...run(), $c: 9 }) + "\n");
  const before = readRoutineRuns(dir), journal = new RoutineRunsJournal(dir); journal.load(undefined, "g");
  expect(readRoutineRuns(dir, journal.baselineCommit), "accepted legacy tags survive pin").toEqual(before);
});

it("P18 C15 later-file sync failure keeps all attempted targets and the old published commit", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  const before = [run("a", "a"), run("b", "b")]; append(journal, before);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 0, stateGeneration: "g" }));
  fault.stage = "fsync"; fault.atName = "b.jsonl";
  expect(() => journal.sync([run("a", "a", "after"), run("b", "b", "after")], 1)).toThrow(JournalWriteError);
  expect(readRoutineRuns(dir, 0), "old publication remains authoritative").toEqual(before);
  expect(journal.pendingCommit).toBe(1); expect(journal.highestTag).toBe(1); expect(journal.verifyFileIndexes()).toEqual([]);
  fault.atName = ""; journal.sync(before, 1);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 1, stateGeneration: "new" }));
  journal.markCommitted(1); journal.setGeneration("new"); journal.compact();
  expect(readRoutineRuns(dir, 1)).toEqual(before); expect(journal.verifyFileIndexes()).toEqual([]);
});

it("P36 exhausted legacy tag range holds startup without publishing a marker", () => {
  const dir = fixture(); mkdirSync(routineRunsDir(dir), { recursive: true });
  const before = { routines: [], unknown: "preserve" };
  writeFileSync(join(dir, "routines.json"), JSON.stringify(before));
  writeFileSync(join(routineRunsDir(dir), "r.jsonl"), JSON.stringify({ ...run(), $c: Number.MAX_SAFE_INTEGER }) + "\n");
  const journal = new RoutineRunsJournal(dir);
  expect(() => journal.load(undefined, "g")).toThrow("tag-exhausted");
  expect(JSON.parse(readFileSync(join(dir, "routines.json"), "utf8"))).toEqual(before);
  expect(journal.baselineCommit).toBeUndefined();
});

it("P36 failed directory barrier is re-established before a direct tagged retry", () => {
  const dir = fixture(); writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines: [] }));
  const journal = new RoutineRunsJournal(dir);
  fault.stage = "directory-fsync"; expect(() => journal.load(undefined, "g")).toThrow(JournalWriteError);
  fault.events.length = 0;
  const observed: boolean[] = [];
  fault.observeTag = () => observed.push(fault.events.some(event => event.includes("fsync:") && event.includes("routines.json.")) && fault.events.includes(`fsync:${dir}`));
  journal.sync([run()], 1);
  expect(observed, "retry requires fresh marker file and directory barriers").toEqual([true]);
});

it("P18 C10 a crash during an unfinished copy leaves the live journal authoritative and load cleans the stray temp", () => {
  const dir = fixture(), journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  append(journal, Array.from({ length: 2000 }, (_, n) => run(`id-${n}`)));
  for (let n = 0; n < 2051; n++) append(journal, [run("id-0", "r", String(n))]);
  const before = readRoutineRuns(dir, 0);
  const cursors = (journal as unknown as { cursors: Map<string, { fd: number }> }).cursors;
  expect(cursors.size).toBe(1);
  // Process death closes descriptors without finishing or removing the temp. No live/user process is involved.
  for (const cursor of cursors.values()) closeSync(cursor.fd);
  cursors.clear();
  expect(readdirSync(routineRunsDir(dir))).toContain("r.jsonl.compact");
  const fresh = new RoutineRunsJournal(dir);
  expect(fresh.load(0, "g")).toEqual(before);
  expect(readdirSync(routineRunsDir(dir)).filter(name => name.endsWith(".compact"))).toEqual([]);
  expect(fresh.verifyFileIndexes()).toEqual([]);
});

it("P36 a new process revalidates file and directory durability after an ambiguous legacy pin", () => {
  const dir = fixture(); writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines: [] }));
  const first = new RoutineRunsJournal(dir);
  fault.stage = "directory-fsync"; expect(() => first.load(undefined, "g")).toThrow(JournalWriteError);
  expect(JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).runsCommit).toBe(0);
  fault.events.length = 0;
  const fresh = new RoutineRunsJournal(dir), observed: boolean[] = [];
  fresh.load(0, "g");
  fault.observeTag = () => observed.push(fault.events.includes(`fsync:${join(dir, "routines.json")}`) && fault.events.includes(`fsync:${dir}`));
  fresh.sync([run()], 1);
  expect(observed, "fresh process baseline durability barrier before new tag").toEqual([true]);
  expect(readRoutineRuns(dir, 0)).toEqual([]);
});

it("P18 uncertain state lines force generation publication even when the comparison baseline was invalidated", () => {
  const dir = fixture(), original = { id: "r", nextRunAt: 0 };
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 0, stateGeneration: "g", routines: [original] }));
  const journal = new RoutineRunsJournal(dir); journal.load(0, "g");
  fault.stage = "fsync";
  expect(() => journal.append({ runs: [], routines: [{ id: "r", nextRunAt: 99 } as { id: string }], removed: [] })).toThrow(JournalWriteError);
  expect(journal.hasRoutineLines(), "uncertain state must prevent unchanged-document fast path").toBe(true);
  journal.sync([], 1);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 1, stateGeneration: "new", routines: [original] }));
  journal.markCommitted(1); journal.setGeneration("new"); journal.compact();
  expect(journal.durabilityKnown).toBe(true); expect(journal.hasRoutineLines()).toBe(false);
  expect(readRoutinesWithRuns(join(dir, "routines.json")).routines).toEqual([original]);
  expect(journal.verifyFileIndexes()).toEqual([]);
});

it("P36 exhaustion is checked before cleanup so a second startup cannot silently recycle the rejected maximum tag", () => {
  const dir = fixture(); mkdirSync(routineRunsDir(dir), { recursive: true });
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ runsCommit: 0, routines: [] }));
  const path = join(routineRunsDir(dir), "r.jsonl"), body = JSON.stringify({ ...run(), $c: Number.MAX_SAFE_INTEGER }) + "\n";
  writeFileSync(path, body);
  expect(() => new RoutineRunsJournal(dir).load(0, "g")).toThrow("tag-exhausted");
  expect(readFileSync(path, "utf8"), "exhausted tag remains visible for lifecycle repair").toBe(body);
  expect(() => new RoutineRunsJournal(dir).load(0, "g")).toThrow("tag-exhausted");
});
