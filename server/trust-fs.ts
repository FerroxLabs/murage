// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The file calls behind a turn's folder-trust answer, answerable from a snapshot read OFF the serving thread.
//
// 1.0.22 real logs (N3): `turn.folder-trust` held the loop 65 s in one call; the folder -> git root chain, the desk checks and the engine's
// trust file are all synchronous file calls, and one blocked call (a consent prompt, a sleeping volume) froze the whole app. The answer
// itself stays ONE synchronous computation (folderTrustForTurn: the primer and the driver read the same answer, and the frozen
// FolderTrustIndex.sourceNow contract is untouched), but the file calls it makes are served from a snapshot taken a moment before:
//   1. `snapshotTrustFs(probe)` runs the same synchronous code with a collecting snapshot. A call it has no answer for returns a placeholder
//      ("absent") and is noted; the noted calls are then made with fs.promises (the libuv pool, never the serving thread) and the probe runs
//      again, until a run notes nothing new. The last run saw only real answers, so it is exactly what the live code will compute.
//   2. `answerFromTrustFs(snapshot, fn)` runs the real computation the same way, starting from that snapshot. A call the snapshot lacks
//      (the computation reached a file the probe did not, or the disk or a cache moved on in between) is answered with fs.promises too and
//      the computation runs again: its result is that of a run that saw only real answers. No call is ever made live, and none is guessed.
// The turn waits for both (fail closed: nothing dispatches on a placeholder); a chain that never settles is refused, never made live.
// Nothing is kept across turns: a snapshot serves one turn.
import * as fs from "node:fs";
import { DatabaseSync } from "./sqlite-open.ts";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

type Op = "stat" | "lstat" | "readdir" | "readFile" | "realpath" | "exists" | "worktree";
/** The engine's worktree registry, one lookup: the recorded source repo of `path`, null when it has none, or the error that stopped the read. */
export type WorktreeLookup = { source: string | null } | { error: string };
type Answer = { value: unknown } | { code: string };
// When the off-thread call behind each answer started (nextFsTicket), so a later reader can tell which of two answers is newer.
const answerTickets = new WeakMap<Answer, number>();
export type TrustFsSnapshot = Map<string, Answer>;
interface Scope { snapshot: TrustFsSnapshot; collect: Map<string, { op: Op; path: string }> }

let scope: Scope | null = null;
let tickets = 0;
/** A number taken as a file call starts, increasing across every caller: of two answers, the one with the larger ticket started later. */
export const nextFsTicket = (): number => ++tickets;
/** The ticket of the stat `trustFs.statSync(path)` answers: inside a trust scope the snapshot answer's (when that off-thread stat started,
 * 0 for a placeholder), outside one a fresh ticket (the live call starts now). */
export function trustFsStatTicket(path: string): number {
  if (!scope) return nextFsTicket();
  const answer = scope.snapshot.get(keyOf("stat", path));
  return answer ? answerTickets.get(answer) ?? 0 : 0;
}
const keyOf = (op: Op, path: string) => `${op}\0${path}`;
const codeError = (code: string, op: Op, path: string) => Object.assign(new Error(`${code}: ${op} '${path}'`), { code });

function served<T>(op: Op, path: string, live: () => T, placeholder: () => T): T {
  if (!scope) return live();
  const key = keyOf(op, path), answer = scope.snapshot.get(key);
  if (answer) {
    if ("code" in answer) throw codeError(answer.code, op, path);
    return answer.value as T;
  }
  scope.collect.set(key, { op, path });
  return placeholder();
}
const absent = (op: Op, path: string) => (): never => { throw codeError("ENOENT", op, path); };

/** Inside a trust scope: true while the current run has made no call its snapshot lacked (every answer it saw so far is real).
 * Outside any scope: null. Lets a caller keep a result only from a run that saw real answers. */
export function trustFsRunClean(): boolean | null { return scope ? scope.collect.size === 0 : null; }

export const trustFs = {
  existsSync: (path: string): boolean => served("exists", path, () => fs.existsSync(path), () => false),
  statSync: (path: string): fs.Stats => served("stat", path, () => fs.statSync(path), absent("stat", path)),
  lstatSync: (path: string): fs.Stats => served("lstat", path, () => fs.lstatSync(path), absent("lstat", path)),
  readdirSync: (path: string): string[] => served("readdir", path, () => fs.readdirSync(path), absent("readdir", path)),
  readFileSync: (path: string): string => served("readFile", path, () => fs.readFileSync(path, "utf8"), absent("readFile", path)),
  realpathNative: (path: string): string => served("realpath", path, () => fs.realpathSync.native(path), () => path),
  /** One read-only lookup in the engine's worktree registry (a sqlite file: opening it is a file call too). */
  worktreeSource: (file: string, path: string): WorktreeLookup => served("worktree", `${file}\0${path}`, () => worktreeLookupSync(file, path), () => ({ source: null })),
};

const LOOKUP = "SELECT source_repo FROM worktrees WHERE path = ?";
const sourceOf = (row: { source_repo?: unknown } | undefined): string | null => row && typeof row.source_repo === "string" && row.source_repo ? row.source_repo : null;
function worktreeLookupSync(file: string, path: string): WorktreeLookup {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return { source: sourceOf(db.prepare(LOOKUP).get(path) as { source_repo?: unknown } | undefined) };
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
// The same lookup in a one-shot worker thread (evaluated source: nothing to package), so the open and the query never run on the serving thread.
const LOOKUP_WORKER = `const { parentPort, workerData } = require("node:worker_threads"); const { DatabaseSync } = require("node:sqlite");
try { const db = new DatabaseSync(workerData.file, { readOnly: true }); try { const row = db.prepare(${JSON.stringify(LOOKUP)}).get(workerData.path); parentPort.postMessage({ source: row && typeof row.source_repo === "string" && row.source_repo ? row.source_repo : null }); } finally { try { db.close(); } catch {} } }
catch (error) { parentPort.postMessage({ error: String(error && error.message || error) }); }`;
function worktreeLookupOffThread(file: string, path: string): Promise<WorktreeLookup> {
  return new Promise(resolve => {
    const worker = new Worker(LOOKUP_WORKER, { eval: true, workerData: { file, path } });
    worker.once("message", (message: WorktreeLookup) => resolve(message));
    worker.once("error", (error: Error) => resolve({ error: error.message }));
    worker.once("exit", () => resolve({ error: "the registry reader ended without an answer" }));
  });
}

const realpathNative = promisify(fs.realpath.native);
async function answerLive(op: Op, path: string): Promise<Answer> {
  const ticket = nextFsTicket();
  const answer = await answerCall(op, path);
  answerTickets.set(answer, ticket);
  return answer;
}
async function answerCall(op: Op, path: string): Promise<Answer> {
  try {
    switch (op) {
      case "stat": return { value: await fs.promises.stat(path) };
      case "lstat": return { value: await fs.promises.lstat(path) };
      case "readdir": return { value: await fs.promises.readdir(path) };
      case "readFile": return { value: await fs.promises.readFile(path, "utf8") };
      case "realpath": return { value: await realpathNative(path) };
      case "exists": return { value: await fs.promises.access(path).then(() => true, () => false) };
      case "worktree": { const [file, row] = path.split("\0") as [string, string]; return { value: await worktreeLookupOffThread(file, row) }; }
    }
  } catch (error) {
    return { code: (error as NodeJS.ErrnoException).code ?? "EIO" };
  }
}

/** The folder-trust file calls did not settle: the turn is refused rather than answered from a guess or from a call on the serving thread. */
export class TrustFsUnsettled extends Error {}

type Run<T> = { value: T } | { error: unknown };
// Runs `fn` with every file call answered from `snapshot`; the calls it lacks are answered off the serving thread and `fn` runs again,
// until a run notes nothing new. That run saw only real answers, so its result is what the live code would compute.
async function settled<T>(snapshot: TrustFsSnapshot, fn: () => T, maxRounds: number): Promise<Run<T>> {
  for (let round = 0; round < maxRounds; round++) {
    const collect = new Map<string, { op: Op; path: string }>();
    const outer = scope;
    scope = { snapshot, collect };
    let run: Run<T>;
    try {
      run = { value: fn() };
    } catch (error) {
      run = { error }; // a placeholder answer can send `fn` down a path that throws; the next round sees the real answers
    } finally {
      scope = outer;
    }
    if (!collect.size) return run;
    const answered = await Promise.all([...collect].map(async ([key, { op, path }]) => [key, await answerLive(op, path)] as const));
    for (const [key, answer] of answered) snapshot.set(key, answer);
  }
  throw new TrustFsUnsettled(`the folder's trust checks did not settle after ${maxRounds} rounds of file reads`);
}

/** Every file call `probe` (the synchronous trust computation, run for its calls only) makes, answered off the serving thread. */
export async function snapshotTrustFs(probe: () => unknown, maxRounds = 64): Promise<TrustFsSnapshot> {
  const snapshot: TrustFsSnapshot = new Map();
  await settled(snapshot, probe, maxRounds);
  return snapshot;
}

/** The result of `fn` (synchronous) with every file call it makes answered from `snapshot`, or off the serving thread when the snapshot
 * lacks it (then `fn` runs again). Never makes a call live; throws TrustFsUnsettled when the calls do not settle in `maxRounds`. */
export async function answerFromTrustFs<T>(snapshot: TrustFsSnapshot | undefined, fn: () => T, maxRounds = 64): Promise<T> {
  if (!snapshot) return fn();
  const run = await settled(snapshot, fn, maxRounds);
  if ("error" in run) throw run.error;
  return run.value;
}
