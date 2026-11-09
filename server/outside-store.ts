// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT 1.0.20 (design r4 3.5): the durable copy of the outside marks, session state, marked turns,
// `outsideSince` and the download registry. One append-only file in the data folder (no new database table, so the
// schema and restore fences stay as they are). Every change is one appended line; load replays them in order. OUTSIDE-COMPACT
// part A (design R4): a final segment with no "\n" is a torn write (never fsync-covered, so never acknowledged): replay skips it
// and a durability barrier cuts the file back to its last "\n" and fsyncs before any line is appended, so an acknowledged line
// can never be joined onto torn bytes. Any other unreadable line throws, which leaves the store not ready, so every turn
// reads as marked (fail closed).
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, statSync } from "node:fs";
import { syncParentDirectoryStatus, writeFileAtomic } from "./atomic.ts";
import type { RegistryEntry } from "./download-registry.ts";
import { noteOutsideStoreWrite, noteStoreFailure } from "./email/external-marks.ts";
import type { MarkedTurnRow, OutsideMarkRow, OutsideSessionRow, OutsideStore, SessionBinding } from "./email/external-marks.ts";

type Line =
  | ({ k: "open"; runId: string; threadId: string; instanceId: string; at: number } & Partial<SessionBinding>)
  | { k: "seal"; runId: string }
  | { k: "mark"; row: OutsideMarkRow }
  | { k: "clear"; threadId: string }
  | { k: "session"; row: OutsideSessionRow }
  | { k: "edit"; threadId: string; instanceId: string; add: string[] }
  | { k: "turn"; row: MarkedTurnRow }
  | { k: "since"; at: number }
  | { k: "own"; key: string }
  | { k: "reg"; add: RegistryEntry[]; drop: RegistryEntry[] };

/** What the last replay saw on disk: the file's byte length, and how many trailing bytes follow its last "\n" (a torn write). */
type TailMeta = { expectedBytes: number; tornTailBytes: number };
type Replayed = ReturnType<OutsideStore["load"]> & { registry: RegistryEntry[]; meta: TailMeta };

/** Test-only seams (defaults are the real calls). */
export type OutsideStoreSeams = {
  dirSync?: (path: string) => "synced" | "unsupported";
  fsync?: (fd: number) => void;
  onReplay?: () => void;
  beforeMend?: () => void;
  // OUTSIDE-COMPACT part B
  /** the compaction write: tmp 0600, fsync, rename, tmp unlinked on a throw (default: atomic.ts writeFileAtomic, no dir sync) */
  writeAtomic?: (path: string, text: string) => void;
  /** the rename inside the default writeAtomic (renameWithRetry's Windows retry applies on top) */
  rename?: (from: string, to: string) => void;
  /** one journal line append (default appendFileSync); a test makes it write a fragment and throw */
  appendLine?: (path: string, data: string) => void;
  /** test-only fault and order seams for the compaction tmp file (open, write, fsync) */
  atomicOps?: NonNullable<Parameters<typeof writeFileAtomic>[2]>["ops"];
  stat?: (path: string) => FileFacts | undefined;
  platform?: NodeJS.Platform;
  thresholds?: Partial<CompactThresholds>;
  /** where a skipped or failed compaction is reported (default console.warn) */
  log?: (message: string) => void;
};
type FileFacts = { size: number; mtimeMs: number; ino: number };
/** Rewrite only when the file is over `floor` and the live text is at most `ratio` of it, or the file is over `big` and the live text is at most `bigRatio`. */
export type CompactThresholds = { floor: number; ratio: number; big: number; bigRatio: number };
const DEFAULT_THRESHOLDS: CompactThresholds = { floor: 4 * 1024 * 1024, ratio: 0.25, big: 128 * 1024 * 1024, bigRatio: 0.75 };

/** The live state as lines (design R2 item 2): the parsed rows as replayed, never external-marks' reconciled memory. Sessions go last. */
function serialize(state: Replayed): string {
  const lines: Line[] = [];
  if (state.outsideSince !== undefined) lines.push({ k: "since", at: state.outsideSince });
  for (const key of state.ownWrites ?? []) lines.push({ k: "own", key });
  if (state.registry.length) lines.push({ k: "reg", add: state.registry, drop: [] });
  for (const row of state.marks) lines.push({ k: "mark", row });
  for (const row of state.markedTurns) lines.push({ k: "turn", row });
  for (const open of state.opens) lines.push({ k: "open", ...open });
  for (const row of state.sessions) lines.push({ k: "session", row });
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function replay(path: string): Replayed {
  const marks = new Map<string, OutsideMarkRow>();
  const sessions = new Map<string, OutsideSessionRow>();
  // Astra L1 r7: the edited paths of a session are journaled incrementally (one `edit` line per tool-call path), so replay merges
  // them here, per session key, and writes them into the row once at the end: linear in the number of lines.
  const editSets = new Map<string, Set<string>>();
  const markedTurns: MarkedTurnRow[] = [];
  // Opens are held in one array; a seal tombstones its run's indices through `openIndex` (no per-seal rescan), one filter pass at the end.
  const openSlots: (ReturnType<OutsideStore["load"]>["opens"][number] | undefined)[] = [];
  const openIndex = new Map<string, number[]>();
  const registry = new Map<string, RegistryEntry>();
  let outsideSince: number | undefined;
  const ownWrites = new Set<string>();
  if (!existsSync(path)) return { marks: [], sessions: [], markedTurns, opens: [], registry: [], ownWrites: [], meta: { expectedBytes: 0, tornTailBytes: 0 } };
  // Offsets are on the raw bytes: a crash can split a multi-byte UTF-8 sequence, and the decoded text would not measure the same.
  const buffer = readFileSync(path);
  const complete = buffer.lastIndexOf(0x0a) + 1;
  const meta: TailMeta = { expectedBytes: buffer.length, tornTailBytes: buffer.length - complete };
  const lines = buffer.subarray(0, complete).toString("utf8").split("\n");
  lines.pop();
  lines.forEach((text) => {
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch (error) {
      // the torn (unterminated) segment is already cut off above: every unreadable line that is left is corruption and fails closed
      throw error;
    }
    switch (line.k) {
      case "open": {
        const { k: _kind, ...open } = line;
        // A fresh engine session opened after the bound session row of the same key supersedes that row: if its own rows never landed,
        // recovery must taint the new session, not resume the old clean row. A session row later in the file (replayed after this) still wins.
        const key = `${open.threadId}\u0000${open.instanceId}`;
        const row = sessions.get(key);
        if (row?.sessionKey !== undefined && open.sessionKey !== undefined && (row.sessionKey !== open.sessionKey || row.gen !== open.gen || row.birthRunId !== open.birthRunId)) { sessions.delete(key); editSets.delete(key); }
        const slots = openIndex.get(open.runId);
        if (slots) slots.push(openSlots.length); else openIndex.set(open.runId, [openSlots.length]);
        openSlots.push(open);
        break;
      }
      case "seal": {
        for (const slot of openIndex.get(line.runId) ?? []) openSlots[slot] = undefined;
        openIndex.delete(line.runId);
        break;
      }
      case "mark": marks.set(line.row.threadId, line.row); break;
      case "clear": marks.delete(line.threadId); break;
      case "session": {
        const key = `${line.row.threadId}\u0000${line.row.instanceId}`;
        sessions.set(key, line.row);
        editSets.set(key, new Set(line.row.edits));
        break;
      }
      case "edit": {
        const key = `${line.threadId}\u0000${line.instanceId}`;
        if (!sessions.has(key)) sessions.set(key, { threadId: line.threadId, instanceId: line.instanceId, tainted: false, wrote: false, edits: [] });
        let set = editSets.get(key);
        if (!set) editSets.set(key, set = new Set());
        for (const entry of line.add) set.add(entry);
        break;
      }
      case "turn": markedTurns.push(line.row); break;
      case "since": outsideSince ??= line.at; break;
      case "own": ownWrites.add(line.key); break;
      case "reg":
        for (const entry of line.drop) registry.delete(JSON.stringify(entry));
        for (const entry of line.add) registry.set(JSON.stringify(entry), entry);
        break;
      default: throw new Error("unknown outside store line");
    }
  });
  for (const [key, set] of editSets) {
    const row = sessions.get(key);
    if (row) sessions.set(key, { ...row, edits: [...set] });
  }
  const opens = openSlots.filter((open): open is NonNullable<typeof open> => open !== undefined);
  return { marks: [...marks.values()], sessions: [...sessions.values()], markedTurns, opens, registry: [...registry.values()], ownWrites: [...ownWrites], meta, ...(outsideSince !== undefined ? { outsideSince } : {}) };
}

/** The store over one file. Writes throw on a disk error; external-marks.ts keeps the in-memory state then (over-marks only). */
export function fileOutsideStore(path: string, seams: OutsideStoreSeams = {}): OutsideStore {
  const fsyncFd = seams.fsync ?? fsyncSync;
  const dirSync = seams.dirSync ?? ((target: string) => syncParentDirectoryStatus(target));
  const platform = seams.platform ?? process.platform;
  const thresholds: CompactThresholds = { ...DEFAULT_THRESHOLDS, ...seams.thresholds };
  const statOf = seams.stat ?? ((target: string): FileFacts | undefined => {
    try { const s = statSync(target); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; } catch { return undefined; }
  });
  const writeAtomic = seams.writeAtomic ?? ((target: string, text: string) => writeFileAtomic(target, text, { mode: 0o600, rename: seams.rename, platform: seams.platform, ops: seams.atomicOps }));
  const log = seams.log ?? ((message: string) => console.warn(`[outside-store] ${message}`));
  const appendLine = seams.appendLine ?? ((target: string, data: string) => appendFileSync(target, data, { mode: 0o600 }));
  let warnedUnsupported = false;
  /** a rename on POSIX has replaced the journal and no real directory sync has confirmed it yet */
  let renamePending = false;
  /** false until a barrier has made this journal's entry and tail durable; "full" only after a real directory sync (kept for the rename compaction, part B) */
  let published: false | "append" | "full" = false;
  // The tail facts of the most recent replay. A per-write barrier after a failed load barrier reuses them: nothing has been written since.
  let meta: TailMeta | undefined;
  // The registry folded from the same replay (memory only; never trusted past a throw). Undefined until a replay has run.
  let regCache: Map<string, RegistryEntry> | undefined;
  const readJournal = (): Replayed => {
    seams.onReplay?.();
    regCache = undefined; // never trusted across a throw: it is rebuilt only from a complete replay
    const replayed = replay(path);
    meta = replayed.meta;
    regCache = new Map(replayed.registry.map((entry) => [JSON.stringify(entry), entry]));
    return replayed;
  };
  const barrierOnce = () => {
    if (!meta) throw new Error("outside store tail is unknown");
    if (!existsSync(path)) {
      const created = openSync(path, "a", 0o600);
      try { fsyncFd(created); } finally { closeSync(created); }
    }
    seams.beforeMend?.();
    // Step 0: cut a torn tail back to the last "\n". "r+" (not "a"): a Windows append handle may not truncate.
    const fd = openSync(path, "r+");
    try {
      const size = fstatSync(fd).size;
      if (size !== meta.expectedBytes) throw new Error("outside store file changed since it was read");
      if (meta.tornTailBytes > 0) {
        ftruncateSync(fd, size - meta.tornTailBytes);
        // the repair is done: a retry after a failed fsync must still fsync, not reject its own truncation
        meta = { expectedBytes: size - meta.tornTailBytes, tornTailBytes: 0 };
      }
      fsyncFd(fd);
    } finally { closeSync(fd); }
    const synced = dirSync(path);
    // After a rename on POSIX the new directory entry is not durable until a REAL directory sync says so: "unsupported" here (it was "synced"
    // at the probe) must not admit writes, or a power cut brings back the old entry and drops them. Fail closed; every per-write retry re-checks.
    if (synced !== "synced" && renamePending) throw new Error("directory sync unavailable after the journal was replaced");
    if (synced === "synced") renamePending = false;
    published = synced === "synced" ? "full" : "append";
  };
  /** create-if-missing, mend, fsync the journal, sync its directory: the whole sequence retries once, a second throw propagates */
  const barrier = () => {
    try { barrierOnce(); } catch { barrierOnce(); }
  };
  /** the per-write gate: no line reaches the file until a barrier has passed (also for a store used without load) */
  const admit = () => {
    if (published) return;
    if (!meta) readJournal();
    barrier();
  };
  const append = (line: Line) => {
    noteOutsideStoreWrite(line.k === "seal");
    try {
      admit();
      // A write that throws may have left a fragment: the next append must run the barrier again (it cuts the fragment off), never join onto it.
      try { appendLine(path, `${JSON.stringify(line)}\n`); } catch (error) { published = false; meta = undefined; throw error; }
    }
    catch (error) { regCache = undefined; noteStoreFailure(); throw error; }
  };
  const flush = (write?: (fd: number) => void) => {
    try {
      admit();
      try {
        const fd = openSync(path, "a", 0o600);
        try { write?.(fd); fsyncFd(fd); } finally { closeSync(fd); }
      } catch (error) { published = false; meta = undefined; throw error; } // a partial write: see append()
    } catch (error) { regCache = undefined; noteStoreFailure(); throw error; }
  };
  const foldRegistry = (add: RegistryEntry[], drop: RegistryEntry[]) => {
    if (!regCache) return;
    for (const entry of drop) regCache.delete(JSON.stringify(entry));
    for (const entry of add) regCache.set(JSON.stringify(entry), entry);
  };
  const sameFile = (a: FileFacts, b: FileFacts | undefined) => !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && (a.ino === 0 || b.ino === 0 || a.ino === b.ino);
  /** Rewrite the journal as the live state when it is mostly dead lines (design R4 B1). Every skip or pre-publication failure keeps the old file and stays ready. */
  const compact = (state: Replayed, before: FileFacts | undefined) => {
    // The rename is only ever done on a directory whose sync was proven by barrier #1 ("full"), or on Windows (design P3).
    if (published !== "full" && platform !== "win32") {
      if (!warnedUnsupported && before && before.size > thresholds.floor) { warnedUnsupported = true; log("directory sync is unsupported here: the journal stays append-only (no compaction)"); }
      return;
    }
    if (!before || before.size <= thresholds.floor || state.meta.tornTailBytes > 0) return;
    const text = serialize(state);
    const live = Buffer.byteLength(text, "utf8");
    if (!(live <= before.size * thresholds.ratio || (before.size > thresholds.big && live <= before.size * thresholds.bigRatio))) {
      log(`journal not rewritten: ${before.size} bytes on disk, ${live} bytes live`);
      return;
    }
    if (!sameFile(before, statOf(path))) { log("journal changed while it was read: not rewritten"); return; }
    // From here the old directory entry may be replaced: no line may be written until barrier #2 has made the new one durable.
    published = false;
    try {
      writeAtomic(path, text);
      if (platform !== "win32") renamePending = true;
      meta = { expectedBytes: live, tornTailBytes: 0 }; // a compacted file ends in "\n": nothing to mend, and its size is known exactly
    } catch (error) {
      log(`journal rewrite failed, old file kept: ${error instanceof Error ? error.message : String(error)}`);
    }
    // barrier #2 (also after a failed write: it re-proves the old entry). A throw here is the disk-failure latch.
    if (!published) { try { barrier(); } catch (error) { regCache = undefined; noteStoreFailure(); throw error; } }
  };
  return {
    load: () => {
      published = false;
      const before = statOf(path);
      const replayed = readJournal();
      const { registry: _registry, meta: _meta, ...rest } = replayed;
      // barrier #1: mend the tail, fsync, and PROBE the directory sync (it decides whether a rename may ever happen)
      try { barrier(); } catch (error) { regCache = undefined; noteStoreFailure(); throw error; }
      compact(replayed, before);
      return rest;
    },
    openTurn: (threadId, instanceId, at, runId, binding) => {
      noteOutsideStoreWrite();
      flush((fd) => appendFileSync(fd, `${JSON.stringify({ k: "open", runId, threadId, instanceId, at, ...binding })}\n`));
    },
    seal: (runId) => { noteOutsideStoreWrite(true); flush(); append({ k: "seal", runId }); },
    loadRegistry: () => {
      if (!regCache) readJournal();
      return structuredClone([...regCache!.values()]);
    },
    writeRegistry: (add, drop) => {
      if (!add.length && !drop.length) return;
      append({ k: "reg", add, drop });
      foldRegistry(add, drop);
    },
    setMark: (row) => append({ k: "mark", row }),
    clearMark: (threadId) => append({ k: "clear", threadId }),
    setSession: (row) => append({ k: "session", row }),
    addSessionEdits: (threadId, instanceId, add) => { if (add.length) append({ k: "edit", threadId, instanceId, add }); },
    addMarkedTurn: (row) => append({ k: "turn", row }),
    setOutsideSince: (at) => append({ k: "since", at }),
    addOwnWrite: (key) => { append({ k: "own", key }); flush(); },
  };
}
