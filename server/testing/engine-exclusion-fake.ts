// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The exclusion layer (engine-fs.ts `exclOps`) for tests that need an engine to hold something. By default every test runs with the
// stand-in addon (engine-exclusion-stub.cjs: no engine holds a lock or has a file open). A test that wants an engine to keep the
// lock, hold a file open, or try to write while Murage holds the file calls useFakeExclusion(); a test that wants the REAL addon
// (Linux, built by scripts/build-engine-exclusion.mjs) calls useRealExclusion(builtAddonPath()).
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { forgetExclusionAddon, loadExclusionAddon, type FileWriters, type NativeProcess } from "../engine-exclusion.ts";
import { exclOps, mutOps } from "../engine-fs.ts";
import { ASIDE_SUFFIX, type FileRef, type HeldFile } from "../engine-plan-core.ts";

const idKey = (id: { dev: bigint; ino: bigint }): string => `${id.dev}:${id.ino}`;

export interface FakeExclusion {
  /** another process keeps the engine's lock on the file at `path` (until the returned function is called) */
  keepLock(path: string): () => void;
  /** An engine that respects the lock tries to take it on `path` (as Fuigo does before it trims): null while Murage holds it. */
  tryEngineLock(path: string): (() => void) | null;
  /** Calls made, in order: lock, processes, renameNoReplace <from>, pread, pwrite, fsync, close, openFile <kind> <path>. */
  calls: string[];
  /** Windows: every markDelete says it could not mark the file */
  markDeleteFails: boolean;
  /** a hook run as Murage takes the lock (the engine tries to write here, and loses) */
  onLock?: (id: { dev: bigint; ino: bigint }, fd: FileRef) => void;
  /** The processes the machine is running (processes()). Empty: no engine is open. Tests put an engine here, or take it away, to model
   * an engine that is open before, open after, or launched between two checks. */
  processes: NativeProcess[];
  /** An engine (by name: claude, codex, fuigo, ...) starts running; the returned function ends it. */
  /** An engine program on the list; `ppid` this process when it is Murage's own child (a turn, a one-shot, a warm session). */
  openEngine(name: string, ppid?: number): () => void;
  /** a hook run on each processes() call (1, 2, ...): it may change `processes` or return a list to answer with instead */
  onProcesses?: (call: number) => NativeProcess[] | void;
  /** The environment of a listed process, by pid (environment()): a process not here has one that cannot be read. */
  environments: Map<number, Record<string, string>>;
  /** how many times processes() was asked */
  processCalls: number;
  /** processes() fails (the list could not be read) */
  processesFail: boolean;
  /** Windows: files that openFile finds in use */
  refuse: Set<string>;
  /** a hook run just before a no-replace rename answers (an engine makes a new file at `to` here) */
  beforeRename?: (from: string, to: string) => void;
  /** Another process opens `path` for writing and keeps it open (as a writer that opened a file before Murage renamed it does): the
   * returned descriptor writes to that file wherever it is renamed to, and writers() names it until `close` is called. */
  openForWriting(path: string): { fd: number; close: () => void };
  /** a hook run on each writers() call: it may run a writer, or return what to answer instead */
  onWriters?: (paths: string[]) => FileWriters | void;
  /** how many times writers() was asked */
  writerCalls: number;
  /** puts the layer back as it was before the fake */
  restore(): void;
}

/** A file held by the model of the addon on Windows: a real descriptor behind the same HeldFile interface the addon's wrapper gives
 * (no C runtime descriptor crosses; the handle object carries its own operations and closes on its own). */
function heldFileOver(path: string, writes: boolean, fake: FakeExclusion, kept: Set<string>, mine: Map<FileRef, string>): HeldFile {
  const fd = openSync(path, writes ? "r+" : "r");
  let marked = false, closed = false;
  const idOf = () => { const stat = fstatSync(fd, { bigint: true }); return { dev: stat.dev, ino: stat.ino }; };
  const self: HeldFile = {
    read: (length, position) => { const buffer = Buffer.alloc(length); const got = readSync(fd, buffer, 0, length, position); return buffer.subarray(0, got); },
    write: (bytes, position) => { let done = 0; while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done, position + done); },
    sync: () => fsyncSync(fd),
    lock: () => {
      fake.calls.push("lock");
      const id = idKey(idOf());
      if (kept.has(id)) return false;
      mine.set(self, id);
      fake.onLock?.(idOf(), self);
      return true;
    },
    markDelete: () => { if (fake.markDeleteFails) return false; marked = true; return true; },
    id: idOf,
    size: () => fstatSync(fd).size,
    close: () => { if (closed) return; closed = true; fake.calls.push(`close ${path}`); mine.delete(self); closeSync(fd); if (marked) { fake.calls.push(`delete ${path}`); unlinkSync(path); } },
  };
  return self;
}

/** Installs the fake over exclOps and the tracing over mutOps. `restore()` undoes both. */
/** A process of this user, for FakeExclusion.processes. */
export function proc(exe: string, argv: string[] = [exe], pid = 4000 + Math.floor(Math.random() * 1000)): NativeProcess {
  return { pid, ppid: 1, mine: true, uid: 1000, start: 1, comm: exe.split(/[\\/]/).pop()!.slice(0, 15), exe, argv };
}

/** This process and its parent: any complete list of the machine holds both (engine-closed.ts refuses a list without them). */
const selfProcesses = (): NativeProcess[] => [
  { pid: process.pid, ppid: process.ppid, mine: true, uid: 1000, start: 1, comm: "node", exe: process.execPath, argv: [process.execPath, "test"] },
  { pid: process.ppid, ppid: 1, mine: true, uid: 1000, start: 1, comm: "test-parent", exe: "/usr/bin/test-parent", argv: ["test-parent"] },
];

export function useFakeExclusion(mode: "posix" | "win32" = "posix"): FakeExclusion {
  const before = { ...exclOps };
  const beforeMut = { pread: mutOps.pread, pwrite: mutOps.pwrite, fsync: mutOps.fsync, close: mutOps.close };
  const kept = new Set<string>();
  const mine = new Map<FileRef, string>();
  /** descriptors "another process" has open for writing (openForWriting) */
  const foreign = new Set<number>();
  const fake: FakeExclusion = {
    calls: [],
    processes: [],
    environments: new Map(),
    processCalls: 0,
    processesFail: false,
    markDeleteFails: false,
    refuse: new Set(),
    openEngine(name, ppid) {
      const running = { ...proc(`/usr/local/bin/${name}`), ...(ppid === undefined ? {} : { ppid }) };
      fake.processes.push(running);
      return () => { const at = fake.processes.indexOf(running); if (at >= 0) fake.processes.splice(at, 1); };
    },
    keepLock(path) { const key = idKey(mutOps.idOf(path)); kept.add(key); return () => { kept.delete(key); }; },
    tryEngineLock(path) {
      const key = idKey(mutOps.idOf(path));
      if (kept.has(key) || [...mine.values()].includes(key)) return null;
      kept.add(key);
      return () => { kept.delete(key); };
    },
    restore() { Object.assign(exclOps, before); Object.assign(mutOps, beforeMut); },
    writerCalls: 0,
    openForWriting(path) {
      const fd = openSync(path, "a");
      foreign.add(fd);
      return { fd, close: () => { if (foreign.delete(fd)) closeSync(fd); } };
    },
  };
  Object.assign(exclOps, {
    mode,
    available: () => true,
    ownUid: () => 1000,
    lock: (fd: number) => {
      const id = mutOps.idOfFd(fd);
      fake.calls.push("lock");
      if (kept.has(idKey(id))) return false;
      mine.set(fd, idKey(id));
      fake.onLock?.(id, fd);
      return true;
    },
    processes: () => {
      fake.calls.push("processes");
      fake.processCalls++;
      if (fake.processesFail) throw new Error("the process list could not be read");
      const answer = fake.onProcesses?.(fake.processCalls);
      return [...selfProcesses(), ...(answer ?? fake.processes)];
    },
    // The model of an atomic rename that never replaces: a taken name answers "exists" and nothing moves. The rename itself goes
    // through mutOps.rename, which tests hook to model what an engine does around it.
    renameNoReplace: (from: string, to: string) => {
      fake.calls.push(`renameNoReplace ${from}`);
      fake.beforeRename?.(from, to);
      try { lstatSync(to); return "exists" as const; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      mutOps.rename(from, to);
      return "ok" as const;
    },
    // only the asked-for names, as the addon gives them
    environment: (pid: number, names: readonly string[]) => {
      const all = fake.environments.get(pid);
      return all ? Object.fromEntries(names.filter((name) => name in all).map((name) => [name, all[name]!])) : null;
    },
    // the files another process has open for writing, by their identity now (wherever they were renamed to)
    writers: (paths: string[]) => {
      fake.calls.push("writers");
      fake.writerCalls++;
      const answer = fake.onWriters?.(paths);
      if (answer) return answer;
      const writers: FileWriters["writers"] = [];
      paths.forEach((path, index) => {
        let id: string;
        try { id = idKey(mutOps.idOf(path)); } catch { return; }
        for (const fd of foreign) { const stat = fstatSync(fd, { bigint: true }); if (idKey({ dev: stat.dev, ino: stat.ino }) === id) writers.push({ pid: 4242, index }); }
      });
      return { writers, unreadable: [] };
    },
    // a path is refused by the name it has when nothing is aside (the folder or file may be moved aside before it is opened)
    openFile: (path: string, kind: "exclusive" | "delete" | "shared" | "probe") => {
      fake.calls.push(`openFile ${kind} ${path}`);
      if (kind !== "shared" && kind !== "probe" && fake.refuse.has(path.split(ASIDE_SUFFIX).join(""))) return null;
      return heldFileOver(path, kind !== "probe", fake, kept, mine);
    },
  });
  mutOps.pread = ((fd: FileRef, length: number, position: number) => { fake.calls.push("pread"); return beforeMut.pread(fd, length, position); }) as typeof mutOps.pread;
  mutOps.pwrite = ((fd: FileRef, bytes: Buffer, position: number) => { fake.calls.push("pwrite"); beforeMut.pwrite(fd, bytes, position); }) as typeof mutOps.pwrite;
  mutOps.fsync = ((fd: FileRef) => { fake.calls.push("fsync"); beforeMut.fsync(fd); }) as typeof mutOps.fsync;
  mutOps.close = ((fd: FileRef) => { fake.calls.push("close"); mine.delete(fd); beforeMut.close(fd); }) as typeof mutOps.close;
  return fake;
}

/** The path of the addon built for this machine (scripts/build-engine-exclusion.mjs), or null when there is none (the caller skips). */
export function builtAddonPath(): string | null {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node");
  return existsSync(file) ? file : null;
}

/** Makes the layer call the REAL addon (the build at `file`) until the returned function is called. */
export function useRealExclusion(file: string): () => void {
  const before = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
  const members = { ...exclOps };
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = file;
  forgetExclusionAddon();
  if (!loadExclusionAddon()) throw new Error(`the addon at ${file} did not load`);
  return () => {
    Object.assign(exclOps, members);
    if (before === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = before;
    forgetExclusionAddon();
  };
}
