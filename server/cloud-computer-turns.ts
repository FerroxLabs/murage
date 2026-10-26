// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 (lanes/release105/designs/CLOUD-COMPUTER-BOOT-105.md, sections 1, 2 and 6): every prompt Murage hands to a bot's
// cloud computer (drivers/boxagent.ts) is on disk from BEFORE it is sent until the box is known to be done with it. A local engine's turn is
// a child of the process and ends with it; a box keeps running. So a restart finds here every prompt a dead process left on a box and
// confirms, by that prompt's own status, that nothing of it still runs (stopping it first when it does), or fences it: nothing reads its
// work, and nothing new is sent to that box until it is confirmed. The owner gets one line per cut-off prompt, in the conversation it ran
// in, saying only what is established.
//
// One entry per prompt: sending (L1) -> running (L2) -> gone; running -> stopping (L3) -> gone or fenced (L4); fenced -> stopped (L5, its
// line still owed) -> gone. Every step that talks to one box (a send, a Stop's confirmation, a recovery) runs under that box's lock, shared
// by every driver instance of this process. Every change of the list is synchronous (no await inside it), so no change can lose another's.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const BOX_AGENT_API = "https://ascii.dev/api/box/v1";
/** The ledger's name in the data folder, and the name an unreadable one is set aside under (data-dir-inventory.ts: both excluded). */
export const CLOUD_COMPUTER_TURNS_FILE = "cloud-computer-turns.json";
export const CLOUD_COMPUTER_TURNS_UNREADABLE = "cloud-computer-turns.json.unreadable";
const ledgerPath = (): string => join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE);

/** The driver's own terminal readings of a prompt's status (boxagent.ts), shared so a prompt is confirmed by the same words a turn ends on. */
export const BOX_RUN_DONE = /completed|succeeded|done|finished/i;
export const BOX_RUN_ENDED = /failed|error|cancelled|interrupted/i;
/** Section 6 item 3: the answers that show the box did not accept the prompt as sent. Every other outcome may have reached it. */
const PROVEN_REFUSAL = new Set([400, 401, 403, 404, 422]);
/** Section 6 items 1-2, the one stated provider assumption: a prompt request the box has not taken within the sender's 30 s is never taken
 * later, so a prompt with no id is confirmed by an acknowledged box-wide interrupt sent no earlier than this after it was recorded. */
export const NO_ID_WAIT_MS = 60_000;

const STATES = ["sending", "running", "stopping", "fenced", "stopped"] as const;
export type CloudTurnState = (typeof STATES)[number];
/** The line an entry is owed (C7). */
export type CloudTurnLine = "restart-stopped" | "restart-unconfirmed" | "unconfirmed";
const LINES: readonly CloudTurnLine[] = ["restart-stopped", "restart-unconfirmed", "unconfirmed"];
export interface CloudTurnEntry {
  turnId: string; boxId: string; threadId: string; promptId: string | null; owner: string; state: CloudTurnState; at: number;
  /** a fingerprint of the token the prompt was sent with: only that account can confirm it (section 6 item 9) */
  account: string;
  lineOwed?: CloudTurnLine;
  lineWritten?: boolean;
}
/** `quarantine` (section 7.2 E3): boxes where earlier work was cleared, each with the time it was set. Until a turn sent after that time ends
 * by its own prompt's terminal status, a turn on that box reads only events that name its prompt. */
interface LedgerFile { version: 1; entries: CloudTurnEntry[]; unknown?: { since: number; cleared: string[] }; quarantine?: Record<string, number> }
type LedgerPatch = { entries?: CloudTurnEntry[]; unknown?: LedgerFile["unknown"]; quarantine?: LedgerFile["quarantine"] };

/** This process. An entry with another owner was left by a process that died (a provider reload keeps the owner). */
const PROCESS_OWNER = randomUUID();
/** This process's prompts a poller is watching (C6): an entry of this process with no watcher is lost, and blocking. */
const monitored = new Set<string>();
/** Prompts this process saw end whose removal could not be written (section 6 item 11): not blocking, no line. */
const endedHere = new Set<string>();
/** Turns that have read as strict once (section 7.2 E3): they stay strict to their end. */
const strictTurns = new Set<string>();
export const accountOf = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 16);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function validEntry(e: unknown): e is CloudTurnEntry {
  const o = e as Record<string, unknown> | null;
  return Boolean(o) && typeof o === "object" && nonEmpty(o!.turnId) && nonEmpty(o!.boxId) && nonEmpty(o!.threadId) && nonEmpty(o!.owner) && nonEmpty(o!.account)
    && (o!.promptId === null || nonEmpty(o!.promptId)) && (STATES as readonly unknown[]).includes(o!.state) && typeof o!.at === "number" && Number.isFinite(o!.at)
    && (o!.lineOwed === undefined || (LINES as readonly unknown[]).includes(o!.lineOwed)) && (o!.lineWritten === undefined || typeof o!.lineWritten === "boolean");
}
function validFile(v: unknown): v is LedgerFile {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.version !== 1 || !Array.isArray(o.entries) || !o.entries.every(validEntry)) return false;
  if (o.quarantine !== undefined) {
    const q = o.quarantine as Record<string, unknown> | null;
    if (!q || typeof q !== "object" || Array.isArray(q) || !Object.entries(q).every(([k, t]) => nonEmpty(k) && typeof t === "number" && Number.isFinite(t))) return false;
  }
  if (o.unknown === undefined) return true;
  const u = o.unknown as Record<string, unknown> | null;
  return Boolean(u) && typeof u === "object" && typeof u!.since === "number" && Number.isFinite(u!.since) && Array.isArray(u!.cleared) && u!.cleared.every(nonEmpty);
}
/** Section 7.1 rule 7: only ENOENT proves a file is absent; any other lookup error is not absence. */
function probe(path: string): "absent" | "present" | "error" {
  try { statSync(path); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "error"; }
}

let ledger: LedgerFile | null = null;
let ledgerFile: string | null = null;
/** The file could not be set aside: nothing is known and nothing can be written; every send is refused. */
let stuck = false;
function load(): LedgerFile {
  const path = ledgerPath();
  if (ledger && ledgerFile === path) return ledger;
  ledgerFile = path;
  stuck = false;
  const asideAt = join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE);
  const found = probe(path);
  if (found === "absent") {
    if (probe(asideAt) === "absent") return (ledger = { version: 1, entries: [] });
    // R4 (section 7.1): an unreadable record was set aside and the record itself is gone: still unknown, never empty
    let since = now();
    try { since = statSync(asideAt).mtimeMs; } catch { /* the time it was found */ }
    return startUnknown(path, since, false);
  }
  let parsed: unknown;
  // a lookup error (not ENOENT) is read as an unreadable record: the copy aside then fails too, and nothing is sent (stuck)
  if (found === "present") { try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { parsed = undefined; } }
  if (validFile(parsed)) return (ledger = parsed);
  // C0 (section 6 item 9, section 7.1): unknown, never empty. The bad file is copied aside (kept), then replaced in one atomic step by a
  // record that says "unknown"; it is never renamed away first, so at every instant the record is either the bad bytes or the new one.
  let since = now();
  try { since = statSync(path).mtimeMs; } catch { /* the time it was found */ }
  console.error("cloud computer: the record of prompts on cloud computers could not be read; each cloud computer is checked before its next prompt");
  return startUnknown(path, since, true);
}
/** R2/R4 -> R3: copy the bad record aside (when there is one), then write the "unknown" record over it. Any failure: stuck for this run; the
 * disk then holds the bad record (R2) or, when only the directory sync after the rename failed, the new one (R3): both read as unknown. */
function startUnknown(path: string, since: number, copyAside: boolean): LedgerFile {
  ledger = { version: 1, entries: [], unknown: { since, cleared: [] } };
  try {
    if (copyAside) {
      const aside = join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE);
      copyFileSync(path, aside);
      const fd = openSync(aside, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    writeFileAtomic(path, JSON.stringify(ledger), { mode: 0o600, syncDir: true });
  } catch (error) {
    console.error("cloud computer: could not start a new record of prompts on cloud computers", error);
    stuck = true;
  }
  return ledger;
}
const entries = (): CloudTurnEntry[] => load().entries;
/** Throws when the write fails: a prompt that cannot be recorded is not sent (F8). */
function save(patch: LedgerPatch): void {
  if (stuck) throw new Error("the record of prompts on cloud computers is unreadable");
  const current = load();
  const unknown = "unknown" in patch ? patch.unknown : current.unknown;
  const quarantine = "quarantine" in patch ? patch.quarantine : current.quarantine;
  const file: LedgerFile = {
    version: 1, entries: (patch.entries ?? current.entries).filter((e) => !endedHere.has(e.turnId)),
    ...(unknown ? { unknown } : {}), ...(quarantine && Object.keys(quarantine).length ? { quarantine } : {}),
  };
  // section 7 item 4: the directory entry is synced too, so a record written before a POST survives a power loss
  writeFileAtomic(ledgerPath(), JSON.stringify(file), { mode: 0o600, syncDir: true });
  ledger = file;
  endedHere.clear();
}
/** The one way an entry changes: written first, then kept in memory. False when the write failed (the old state stays everywhere). */
function change(turnId: string, next: (entry: CloudTurnEntry) => CloudTurnEntry | null): boolean {
  const current = load();
  const at = current.entries.findIndex((e) => e.turnId === turnId);
  if (at < 0) return true;
  const changed = next(current.entries[at]!);
  const copy = current.entries.slice();
  if (changed) copy[at] = changed; else copy.splice(at, 1);
  try { save({ entries: copy }); return true; }
  catch (error) { console.error("cloud computer: the record of a prompt could not be updated", error); return false; }
}

let now = (): number => Date.now();
const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
let sleep = realSleep;
let pauseMs = 1_000;
let statusReads = 5;
/** Tests: an injected clock and wait, no real pauses between the status reads. */
export function _cloudComputerTiming(timing: { now?: () => number; sleep?: (ms: number) => Promise<void>; pauseMs?: number; statusReads?: number }): void {
  now = timing.now ?? now; sleep = timing.sleep ?? sleep; pauseMs = timing.pauseMs ?? pauseMs; statusReads = timing.statusReads ?? statusReads;
}

// ── the box lock ─────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
/** Runs `job` after every earlier job of the same box (C3, F14). */
function withBoxLock<T>(boxId: string, job: () => Promise<T>): Promise<T> {
  const before = locks.get(boxId) ?? Promise.resolve();
  const run = before.catch(() => {}).then(job);
  const tail = run.catch(() => {});
  locks.set(boxId, tail);
  void tail.then(() => { if (locks.get(boxId) === tail) locks.delete(boxId); });
  return run;
}
/** Tests: resolves when no box job is left. */
export async function _cloudComputerIdle(): Promise<void> { while (locks.size) await Promise.all([...locks.values()]); await linesReady.catch(() => {}); }
export function _resetCloudComputerTurns(): void {
  ledger = null; ledgerFile = null; stuck = false; locks.clear(); monitored.clear(); endedHere.clear(); strictTurns.clear(); stopsOwed.clear(); owedClearing.clear(); owedTries.clear(); lineWriter = undefined; linesReady = Promise.resolve();
  now = () => Date.now(); sleep = realSleep; pauseMs = 1_000; statusReads = 5;
}

// ── the owner's lines (C7) ───────────────────────────────────────────────────────

/** True when the line is there, or nobody is left to tell (the thread is gone). */
export type CloudTurnLineWriter = (entry: CloudTurnEntry, text: string, stableId: string) => boolean;
let lineWriter: CloudTurnLineWriter | undefined;
let linesReady: Promise<void> = Promise.resolve();
/** The server's line writer; lines are written after `ready` (the server's first health answer), every owed one at once. */
export function configureCloudComputerLines(writer: CloudTurnLineWriter | undefined, ready?: Promise<void>): void {
  lineWriter = writer;
  linesReady = ready ?? Promise.resolve();
  void linesReady.then(flushLines, () => {});
}
export const cloudComputerLineId = (turnId: string, line: CloudTurnLine): string => `${line === "unconfirmed" ? "cloud-computer-unconfirmed" : "cloud-computer-restart"}:${turnId}`;
export function cloudComputerLineText(line: CloudTurnLine): string {
  if (line === "restart-stopped") return "Murage restarted during this turn. The cloud computer has no work from it still running, so nothing from before the restart carries on.";
  if (line === "restart-unconfirmed") return "Murage restarted during this turn and could not confirm that its work on the cloud computer stopped. Nothing it does now is read as a reply, and Murage stops it before the next turn on that computer.";
  return "Murage could not confirm that this turn's work on the cloud computer stopped. Nothing it does now is read as a reply, and Murage stops it before the next turn on that computer.";
}
export const CLOUD_COMPUTER_UNKNOWN_REFUSAL = "Murage cannot yet tell whether this bot's cloud computer is still running work from before the restart, so nothing new is sent to it yet. Try again in a minute.";
export const CLOUD_COMPUTER_FENCED_REFUSAL = "Murage could not confirm that work from before is stopped on this bot's cloud computer, so nothing new is sent to it yet. Try again once the computer is reachable.";
export const CLOUD_COMPUTER_BUSY_REFUSAL = "This bot's cloud computer still has work from before that is stopped only when no other turn is running there. Try again when the current turn ends.";
export const CLOUD_COMPUTER_UNNAMED_TURN = "This bot's cloud computer took the turn without naming it, so Murage cannot follow it. Nothing it does is read as a reply, and Murage stops it before the next turn on that computer.";
export const CLOUD_COMPUTER_SNAPSHOT_REFUSAL = "Murage could not read what this bot's cloud computer is doing, so nothing was sent to it. Try again once the computer is reachable.";

function flushLines(): void {
  if (!lineWriter) return;
  for (const entry of entries().filter((e) => e.lineOwed && !e.lineWritten)) {
    const line = entry.lineOwed!;
    let written = false;
    try { written = lineWriter(entry, cloudComputerLineText(line), cloudComputerLineId(entry.turnId, line)); } catch (error) { console.error("cloud computer: could not write the owner's line", error); }
    if (written) change(entry.turnId, (e) => e.state === "stopped" ? null : { ...e, lineOwed: undefined, lineWritten: true });
  }
}
async function linesAfterReady(): Promise<void> { await linesReady.catch(() => {}); flushLines(); }

// ── talking to the box (C2, section 6 items 1, 2, 9) ─────────────────────────────

type BoxAnswer = { status: number; body: any } | null;
async function boxCall(token: string, path: string, method: "GET" | "POST"): Promise<BoxAnswer> {
  try {
    const res = await fetch(`${BOX_AGENT_API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch { return null; }
}
/** A 2xx with a JSON object that does not say `ok:false`. */
const acknowledged = (a: BoxAnswer): a is { status: number; body: any } => a !== null && a.status >= 200 && a.status < 300 && a.body !== null && typeof a.body === "object" && a.body.ok !== false;
/** F6/F7: a 404 means gone only when the same account's list answers and does not hold the box. */
async function boxGone(token: string, boxId: string): Promise<boolean> {
  const got = await boxCall(token, "/boxes", "GET");
  if (!acknowledged(got) || !Array.isArray(got.body.boxes)) return false;
  return !got.body.boxes.some((b: any) => String(b?.id ?? "") === boxId);
}
type Reading = "terminal" | "running" | "gone" | "unknown";
async function readPrompt(token: string, boxId: string, promptId: string): Promise<Reading> {
  const got = await boxCall(token, `/boxes/${encodeURIComponent(boxId)}/prompts/${encodeURIComponent(promptId)}`, "GET");
  if (got?.status === 404) return (await boxGone(token, boxId)) ? "gone" : "unknown";
  if (!acknowledged(got)) return "unknown";
  const run = got.body.promptRun ?? got.body.prompt ?? got.body;
  const state = String(run?.status ?? "");
  if (BOX_RUN_DONE.test(state) || BOX_RUN_ENDED.test(state)) return "terminal";
  return state ? "running" : "unknown";
}
/** C2: true only when nothing of these prompts can still run. A prompt with an id is confirmed by its own status (read first: already
 * terminal needs no interrupt); one without an id by an acknowledged box-wide interrupt sent NO_ID_WAIT_MS after it was recorded. Another
 * account's prompt is never confirmed with this token. `interrupt: false` (another turn is live on the box): only status readings. */
export async function stopAndConfirm(boxId: string, prompts: ReadonlyArray<Pick<CloudTurnEntry, "promptId" | "at" | "account">>, token: string | undefined, options: { interrupt?: boolean } = {}): Promise<boolean> {
  if (!token || prompts.some((p) => p.account !== accountOf(token))) return false;
  const named = [...new Set(prompts.flatMap((p) => p.promptId ? [p.promptId] : []))];
  const unnamed = prompts.filter((p) => !p.promptId);
  const open = new Set<string>();
  for (const promptId of named) {
    const reading = await readPrompt(token, boxId, promptId);
    if (reading === "gone") return true;
    if (reading !== "terminal") open.add(promptId);
  }
  if (!open.size && !unnamed.length) return true;
  // section 8 (Low): with no interrupt nothing can end an open prompt, so one reading is all there is: no further reads holding the box lock
  if (options.interrupt === false) return false;
  {
    if (unnamed.length) { const ready = Math.max(...unnamed.map((p) => p.at)) + NO_ID_WAIT_MS; if (now() < ready) await sleep(ready - now()); }
    const stop = await boxCall(token, `/boxes/${encodeURIComponent(boxId)}/interrupt`, "POST");
    if (stop?.status === 404) return boxGone(token, boxId);
    if (!acknowledged(stop)) return false;
  }
  for (const promptId of open) {
    let confirmed = false;
    for (let read = 0; read < statusReads && !confirmed; read++) {
      if (read > 0) await sleep(pauseMs);
      const reading = await readPrompt(token, boxId, promptId);
      if (reading === "gone") return true;
      confirmed = reading === "terminal";
    }
    if (!confirmed) return false;
  }
  return true;
}

// ── which entries hold a box ────────────────────────────────────────────────────

const isOrphan = (e: CloudTurnEntry): boolean => e.owner !== PROCESS_OWNER;
/** Not L5, not seen ending here, and another process's, or fenced, or this process's with no watcher. */
const blocking = (e: CloudTurnEntry): boolean => e.state !== "stopped" && !endedHere.has(e.turnId) && (isOrphan(e) || e.state === "fenced" || !monitored.has(e.turnId));
const live = (e: CloudTurnEntry): boolean => !isOrphan(e) && monitored.has(e.turnId) && e.state !== "fenced" && e.state !== "stopped";
const unconfirmedLine = (e: CloudTurnEntry): { lineOwed?: CloudTurnLine } => e.lineWritten || e.lineOwed ? {} : { lineOwed: isOrphan(e) ? "restart-unconfirmed" : "unconfirmed" };

/** Under the box lock: confirm the box's blocking prompts. True when none is left. Never interrupts a box another watched turn uses (item 6). */
/** `ownAccountOnly` (a Stop owed, Grok r6): only the rows of this token's account are cleared; another account's rows stay for its own token. */
async function clearBoxLocked(boxId: string, token: string | undefined, options: { ownAccountOnly?: boolean } = {}): Promise<boolean> {
  const onBox = entries().filter((e) => e.boxId === boxId);
  const targets = onBox.filter(blocking).filter((e) => !options.ownAccountOnly || (token !== undefined && e.account === accountOf(token)));
  if (!targets.length) return true;
  if (onBox.some(live)) return false;
  // E3: the box is quarantined BEFORE its old work is cleared; a quarantine that cannot be written clears nothing
  if (!quarantineBox(boxId)) return false;
  const ok = await stopAndConfirm(boxId, targets, token);
  for (const target of targets) {
    change(target.turnId, (e) => {
      if (ok) {
        const line: CloudTurnLine | undefined = e.lineWritten ? undefined : isOrphan(e) ? "restart-stopped" : undefined;
        return line ? { ...e, state: "stopped", lineOwed: line } : null;
      }
      return { ...e, state: "fenced", ...unconfirmedLine(e) };
    });
  }
  void linesAfterReady();
  return ok;
}

/** C0: before the first prompt to a box after an unreadable record, that box is cleared once by the no-id rule (from the file's time). */
async function clearUnknownLocked(boxId: string, token: string): Promise<boolean> {
  const current = load();                                       // load first: reading the record is what can set `stuck`
  if (stuck) return false;
  if (!current.unknown || current.unknown.cleared.includes(boxId)) return true;
  if (!(await stopAndConfirm(boxId, [{ promptId: null, at: current.unknown.since, account: accountOf(token) }], token))) return false;
  const after = load();
  try { save({ unknown: { since: after.unknown?.since ?? current.unknown.since, cleared: [...(after.unknown?.cleared ?? []), boxId] }, quarantine: { ...(after.quarantine ?? {}), [boxId]: now() } }); } catch { return false; }
  return true;
}
/** Sets the box's quarantine (kept when already set). False when it could not be written. */
function quarantineBox(boxId: string): boolean {
  const current = load();
  if (current.quarantine?.[boxId] !== undefined) return true;
  try { save({ quarantine: { ...(current.quarantine ?? {}), [boxId]: now() } }); return true; }
  catch (error) { console.error("cloud computer: could not record the box's quarantine", error); return false; }
}
/** Section 7.2 E3: true when this turn must read only events that name its prompt: its box is quarantined, another prompt of the box is on
 * record (not L5, not seen ending), the record is unreadable, or the turn was strict before. Sticky. */
export function cloudTurnStrict(turnId: string): boolean {
  if (strictTurns.has(turnId)) return true;
  const current = load();
  const mine = current.entries.find((e) => e.turnId === turnId);
  const strict = stuck || !mine || current.quarantine?.[mine.boxId] !== undefined
    || current.entries.some((e) => e.boxId === mine.boxId && e.turnId !== turnId && e.state !== "stopped" && !endedHere.has(e.turnId));
  if (strict) strictTurns.add(turnId);
  return strict;
}

/** C1 (boot): every box a dead process left a prompt on is confirmed, or fenced; every owed line is written (item 10). Never throws. */
export async function recoverCloudComputerTurns(options: { token: () => string | undefined }): Promise<{ confirmed: number; fenced: number }> {
  const counted = { confirmed: 0, fenced: 0 };
  try {
    const boxes = [...new Set(entries().filter(blocking).map((e) => e.boxId))];
    const results = await Promise.all(boxes.map((boxId) => withBoxLock(boxId, () => clearBoxLocked(boxId, options.token())).catch(() => false)));
    for (const ok of results) { if (ok) counted.confirmed++; else counted.fenced++; }
  } catch (error) { console.error("cloud computer: the restart check of cloud computers failed", error); }
  await linesAfterReady();
  return counted;
}

// ── the driver's side ────────────────────────────────────────────────────────────

export interface CloudSend {
  turnId: string; boxId: string; threadId: string; token: string;
  /** the submission fence: called right before the POST, nothing awaited between them */
  beforeSubmit?: () => void;
  /** GET /events: the events the box lists now (C3 step 4); a throw refuses the send */
  events: () => Promise<unknown[]>;
  /** the POST of the prompt, raw (an HTTP answer of any status), or a throw when no answer came */
  post: () => Promise<{ status: number; body: any }>;
}
/** C3: the whole send under the box lock. Resolves with the box's answer, the prompt id (a non-empty string or null, section 7.2 E1) and
 * the events listed before it (to be marked seen); the prompt is L2 and watched when this resolves. Throws a refusal (nothing sent) or the
 * send's failure (L0 or L4 by L1R). */
export function sendCloudPrompt(send: CloudSend): Promise<{ promptId: string | null; body: any; before: unknown[] }> {
  return withBoxLock(send.boxId, async () => {
    load();                                                     // the record is read before `stuck` is trusted
    if (stuck || !(await clearUnknownLocked(send.boxId, send.token))) throw new Error(CLOUD_COMPUTER_UNKNOWN_REFUSAL);
    const onBox = entries().filter((e) => e.boxId === send.boxId);
    if (onBox.some(blocking)) {
      if (onBox.some(live)) throw new Error(CLOUD_COMPUTER_BUSY_REFUSAL);
      if (!(await clearBoxLocked(send.boxId, send.token))) throw new Error(CLOUD_COMPUTER_FENCED_REFUSAL);
    }
    let before: unknown[];
    try { before = await send.events(); } catch { throw new Error(CLOUD_COMPUTER_SNAPSHOT_REFUSAL); }
    // L0 -> L1 before the fence and the POST; a record that cannot be written refuses the send (save throws)
    const current = load();
    save({ entries: [...current.entries.filter((e) => e.turnId !== send.turnId), { turnId: send.turnId, boxId: send.boxId, threadId: send.threadId, promptId: null, owner: PROCESS_OWNER, state: "sending", at: now(), account: accountOf(send.token) }] });
    monitored.add(send.turnId);
    // E3 (Astra r2 item 2): with the new prompt on record and before it is posted, every turn sharing this box is latched strict, the new
    // one included, so neither reads the other's unnamed work even after the other ends and leaves the record
    const sharing = entries().filter((e) => e.boxId === send.boxId && e.turnId !== send.turnId && e.state !== "stopped" && !endedHere.has(e.turnId));
    if (sharing.length || load().quarantine?.[send.boxId] !== undefined) strictTurns.add(send.turnId);
    for (const other of sharing) strictTurns.add(other.turnId);
    const unsent = () => { monitored.delete(send.turnId); strictTurns.delete(send.turnId); };
    try { send.beforeSubmit?.(); }
    catch (error) { change(send.turnId, () => null); unsent(); throw error; }
    let answer: { status: number; body: any };
    try { answer = await send.post(); }
    catch (error) {
      // no answer: the box may have it (L4, no id: the no-id rule clears it before the next prompt)
      change(send.turnId, (e) => ({ ...e, state: "fenced" }));
      unsent();
      throw error;
    }
    if (!acknowledged(answer as BoxAnswer)) {
      if (PROVEN_REFUSAL.has(answer.status)) change(send.turnId, () => null); else change(send.turnId, (e) => ({ ...e, state: "fenced" }));
      unsent();
      throw new Error(answer.body?.code ?? answer.body?.error ?? `box HTTP ${answer.status}`);
    }
    const body = answer.body;
    const raw: unknown = body?.promptRun?.id ?? body?.prompt?.id ?? body?.promptId ?? null;
    const promptId: string | null = typeof raw === "string" && raw ? raw : null;
    // a failed write leaves L1 on disk: a restart treats it by the no-id rule; this process's watcher still follows it to its end
    change(send.turnId, (e) => ({ ...e, promptId, state: "running" }));
    return { promptId, body, before };
  });
}

/** The watcher ended (C6, section 6 item 11, section 7.2 E1): "ended" (a terminal status of this prompt) -> L0; "unproven" (a 2xx that
 * named no prompt: not followed) -> L4 without a line; "lost" (the watcher failed) -> L4 with the in-process line. A prompt already marked stopping is
 * left to its Stop. Unwatched either way. */
export function cloudTurnFinished(turnId: string, how: "ended" | "unproven" | "lost", options: { terminal?: boolean } = {}): void {
  const boxId = entries().find((e) => e.turnId === turnId)?.boxId;            // read first: an ended turn leaves the record below
  if (how === "ended" && options.terminal === false) {
    // Grok r2: a Stop's break read no status. A prompt still `sending`/`running` here means the Stop's `stopping` mark was not written: the
    // entry is fenced (or, if that write fails too, left as it is, unwatched and so blocking), never removed and never marked as seen ending
    change(turnId, (e) => e.state === "sending" || e.state === "running" ? { ...e, state: "fenced" } : e);
  } else if (how === "ended") {
    const current = load();
    const mine = current.entries.find((e) => e.turnId === turnId);
    if (mine && (mine.state === "sending" || mine.state === "running")) {
      // E3: a turn sent after the box's quarantine was set, ended by its own prompt's terminal status, lifts it
      const since = current.quarantine?.[mine.boxId];
      const quarantine = since !== undefined && mine.at >= since && options.terminal !== false ? Object.fromEntries(Object.entries(current.quarantine!).filter(([box]) => box !== mine.boxId)) : current.quarantine;
      try { save({ entries: current.entries.filter((e) => e.turnId !== turnId), quarantine }); }
      catch (error) { console.error("cloud computer: the record of a prompt could not be updated", error); endedHere.add(turnId); }
    }
  }
  else change(turnId, (e) => e.state === "stopped" || e.state === "stopping" ? e : { ...e, state: "fenced", ...(how === "lost" ? unconfirmedLine(e) : {}) });
  monitored.delete(turnId);
  strictTurns.delete(turnId);
  if (how === "lost") void linesAfterReady();
  if (boxId) afterLeave(boxId);
}

/** Section 8: per box, the Stops that could not interrupt because another turn still needed the box, one token per account (Grok r7: a
 * second account's Stop never overwrites the first's), each cleared on its own. In memory only: a crash leaves the entries as orphans for
 * the boot recovery (C1). */
const stopsOwed = new Map<string, Map<string, string>>();
/** Keyed by box and account: a clear of that Stop owed is queued or running; its failed clears so far (backoff from OWED_RETRY_MS, at most
 * OWED_RETRY_MAX_MS). */
const owedClearing = new Set<string>();
const owedTries = new Map<string, number>();
const OWED_RETRY_MS = 1_000;
const OWED_RETRY_MAX_MS = 60_000;
/** Grok r7 Low: after this many failed clears the Stop owed is dropped. Its row stays fenced, and the next send's clear or the boot recovery
 * (C1) settles it, so that account's token is not sent again and again. */
export const OWED_MAX_FAILURES = 5;
const owedKey = (boxId: string, account: string): string => `${boxId}\n${account}`;
function oweStop(boxId: string, token: string): void {
  let owed = stopsOwed.get(boxId);
  if (!owed) stopsOwed.set(boxId, owed = new Map());
  owed.set(accountOf(token), token);
}
function dropOwed(boxId: string, account: string): void {
  const owed = stopsOwed.get(boxId);
  owed?.delete(account);
  if (owed && !owed.size) stopsOwed.delete(boxId);
  owedTries.delete(owedKey(boxId, account));
}
/** Section 8.1: another entry of the box needs it: live and not itself being stopped (an interrupt costs a `stopping` turn nothing). */
const needsBox = (boxId: string, turnId: string): boolean => entries().some((e) => e.boxId === boxId && e.turnId !== turnId && live(e) && e.state !== "stopping");
const boxBusy = (boxId: string): boolean => entries().some((e) => e.boxId === boxId && live(e));
/** Section 8.1: a turn of the box left "live". Once no live turn is left, every Stop owed on the box is carried out under the lock, one
 * account at a time (clearBoxLocked re-checks there and never interrupts a live turn). */
function afterLeave(boxId: string): void {
  const owed = stopsOwed.get(boxId);
  if (!owed || boxBusy(boxId)) return;
  for (const [account, token] of [...owed]) clearOwed(boxId, account, token);
}
function clearOwed(boxId: string, account: string, token: string): void {
  const key = owedKey(boxId, account);
  if (owedClearing.has(key)) return;
  owedClearing.add(key);
  void withBoxLock(boxId, async (): Promise<"ok" | "busy" | "failed"> => {
    // a live turn came onto the box: nothing is tried and nothing counts as a failure; its leave carries the Stop out
    if (boxBusy(boxId)) return "busy";
    return (await clearBoxLocked(boxId, token, { ownAccountOnly: true })) ? "ok" : "failed";
  })
    .catch((error): "failed" => { console.error("cloud computer: a Stop owed on the box could not be carried out", error); return "failed"; })
    .then(async (result) => {
      owedClearing.delete(key);
      if (result === "busy") { afterLeave(boxId); return; }       // re-checked here: that turn may have left while this clear was queued
      // Grok r5: the Stop stays owed until nothing of this account blocks the box (this clear, a send's clear or a restart's settled it)
      if (result === "ok" || !entries().some((e) => e.boxId === boxId && blocking(e) && e.account === account)) { dropOwed(boxId, account); return; }
      const tries = (owedTries.get(key) ?? 0) + 1;
      if (tries >= OWED_MAX_FAILURES) {
        console.error(`cloud computer: a Stop owed on the box was not confirmed after ${tries} tries; its prompt stays fenced for the next send or restart`);
        dropOwed(boxId, account);
        return;
      }
      owedTries.set(key, tries);
      await sleep(Math.min(OWED_RETRY_MAX_MS, OWED_RETRY_MS * 2 ** (tries - 1)));
      afterLeave(boxId);
    });
}

/** C5, section 8: a Stop of a watched prompt. The driver sends nothing itself. The mark (L3) is written at once, before the watcher can end;
 * the rest runs under the box lock. The box-wide interrupt is sent only when no other turn on the box needs it; otherwise only status reads,
 * and the Stop is owed to the box until its last live turn leaves. */
export function stopCloudTurn(turnId: string, token: string): Promise<boolean> {
  const entry = entries().find((e) => e.turnId === turnId);
  if (!entry) return Promise.resolve(true);
  change(turnId, (e) => e.state === "sending" || e.state === "running" ? { ...e, state: "stopping" } : e);
  return withBoxLock(entry.boxId, async () => {
    const current = entries().find((e) => e.turnId === turnId);
    // a missing row is confirmed: only a terminal status (the watcher) or a confirmed stop (C2) removes an entry, marked or not (section 8 F7)
    if (!current) return true;
    if (current.state === "stopped") return true;
    // F6: an unwritten mark leaves the entry `running` (or the watcher fenced it): this process's prompt is still this Stop's to confirm
    if (isOrphan(current)) return false;
    const others = needsBox(current.boxId, turnId);
    const ok = await stopAndConfirm(current.boxId, [current], token, others ? { interrupt: false } : {});
    change(turnId, (e) => e.state === "stopped" ? e : ok ? null : { ...e, state: "fenced", ...unconfirmedLine(e) });
    monitored.delete(turnId);
    if (!ok && others) oweStop(current.boxId, token);
    if (!ok) void linesAfterReady();
    afterLeave(current.boxId);
    return ok;
  });
}

/** Tests: an entry as another process (or this one) left it. */
export function _seedCloudComputerEntry(entry: CloudTurnEntry): void { save({ entries: [...load().entries, entry] }); }
export function cloudComputerQuarantine(): Readonly<Record<string, number>> { return { ...(load().quarantine ?? {}) }; }
/** For tests and the status of a box. */
export function cloudComputerEntries(): readonly CloudTurnEntry[] { return entries().slice(); }
export function cloudComputerUnknown(): { since: number; cleared: readonly string[] } | undefined { return load().unknown; }
