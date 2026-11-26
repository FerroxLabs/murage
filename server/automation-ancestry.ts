// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Automation ancestry (PHONEAUD 1.0.21): whether any hop of a turn's chain was a routine, a wake of one, or an
// unattended turn. The owner-only mounts that exclude the owner's automation (the phone tools above all) ask this,
// never the recipient thread's live routine alone: a hand-off, ask, room request, wake or retry started by a routine
// runs in a thread with no routine of its own, and it must not pass as the owner's own turn.
//
// The record is per turn, not per thread: each admitted turn appends {at, automation} to its thread's ledger, and the
// ledger is kept on disk (configureAutomationAncestryFile), so a restart forgets nothing. A continuation of a card is
// judged by the turn that was running when the card was posted (a later owner turn does not clear it). Room requests
// carry their own mark, set when queued.
//
// Fail closed: a chained turn whose root has no record, or a re-run or continuation with no record at its time (a
// ledger written before this field, an evicted thread, a damaged file), counts as automation.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";

/** What one turn carries from the hop that started it; every field is server-owned. */
export interface AncestryInput {
  /** The turn's own thread runs a routine or is unattended now (isAutomationThread), read after this turn's own mark is applied. */
  automationThread: boolean;
  automationSource?: unknown;
  routineRunId?: unknown;
  routineAuthority?: unknown;
  decisionRoutineSource?: unknown;
  routineWake?: unknown;
  askerWakeCeiling?: unknown;
  unattended?: unknown;
  /** The hop is set explicitly by the dispatcher (a durable delegation, room request or held work that recorded it). */
  carried?: boolean;
  chainRootThreadId?: string;
  /** This turn continues one already on this thread (card continuation, held continuation, asker wake): its own options do not carry
   *  the chain, so a missing record fails closed. */
  rerun?: boolean;
  /** This turn retries the same start (memory redispatch, setup retry, rebuild) with its original options, which carry the chain; the
   *  thread's newest record adds an automation mark, and a missing one adds nothing (the start may have been refused before recording). */
  retry?: boolean;
  /** For a re-run: when the row it continues was written (the answered card); absent: the thread's newest record. */
  rerunAt?: number;
  threadId: string;
}

interface Entry { at: number; automation: boolean }
/** Per thread, a few of the newest admitted turns, oldest first. */
const MAX_PER_THREAD = 8;
const MAX_THREADS = 1024;
const MAX_REQUESTS = 2048;
let byThread = new Map<string, Entry[]>();
let byRequest = new Map<string, boolean>();
let file: string | undefined;

/** Whether the turn descends from automation. Pure apart from the records it reads. */
export function automationAncestry(input: AncestryInput): boolean {
  if (input.automationThread || input.carried === true || input.unattended === true) return true;
  if (input.automationSource !== undefined || input.routineRunId !== undefined || input.routineAuthority !== undefined) return true;
  if (input.decisionRoutineSource !== undefined) return true;
  if (input.routineWake !== undefined && input.routineWake !== false || input.askerWakeCeiling !== undefined) return true;
  if (input.chainRootThreadId !== undefined && threadAutomationAncestry(input.chainRootThreadId) !== false) return true;
  if (input.rerun === true && automationAncestryAt(input.threadId, input.rerunAt) !== false) return true;
  if (input.retry === true && threadAutomationAncestry(input.threadId) === true) return true;
  return false;
}

/** The phone's stricter reading (arbiter3 Astra 2): a continuation with no card to anchor it (Continue after Your turn, a held item or a
 *  wake without a card) has no proof tied to its original work, and the thread's newest record may be a newer owner turn's. It never gets
 *  the owner's phone; every other mount keeps reading automationAncestry. */
export function phoneAncestry(automation: boolean, input: Pick<AncestryInput, "rerun" | "rerunAt">): boolean {
  return automation || input.rerun === true && input.rerunAt === undefined;
}

/** Records an admitted turn's ancestry on its thread, so a later hop rooted here, or a continuation of it, inherits it. The file is written
 *  first: a write that throws publishes nothing (Astra 1: a start given back after a failed write leaves no record readers can see). */
export function recordAutomationAncestry(threadId: string, automation: boolean, at = Date.now()): void {
  const entries = [...byThread.get(threadId) ?? [], { at, automation }].slice(-MAX_PER_THREAD);
  const threads = new Map(byThread);
  threads.delete(threadId);
  threads.set(threadId, entries);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  persist(threads, byRequest);
  byThread = threads;
}

/** The recorded ancestry of the newest turn on a thread (undefined: none recorded). */
export function threadAutomationAncestry(threadId: string): boolean | undefined {
  return byThread.get(threadId)?.at(-1)?.automation;
}

/** The ancestry of the turn that was running on the thread at `at` (the newest one admitted at or before it); undefined when the
 *  ledger does not reach back that far. Without `at`: the newest. */
export function automationAncestryAt(threadId: string, at?: number): boolean | undefined {
  const entries = byThread.get(threadId);
  if (!entries?.length) return undefined;
  if (at === undefined) return entries.at(-1)!.automation;
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index].at <= at) return entries[index].automation;
  return undefined;
}

/** A room request's own mark, set once when it is queued; never lowered. Written to the file before it is published, as above. */
export function recordRequestAncestry(requestId: string, automation: boolean): void {
  const requests = new Map(byRequest);
  const value = requests.get(requestId) === true || automation;
  requests.delete(requestId);
  requests.set(requestId, value);
  if (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value!);
  persist(byThread, requests);
  byRequest = requests;
}

export function requestAutomationAncestry(requestId: string): boolean | undefined {
  return byRequest.get(requestId);
}

/** Loads the ledger from `path` and keeps it there. A missing or damaged file starts empty, which every reader treats as automation. */
export function configureAutomationAncestryFile(path: string | undefined): void {
  file = path;
  byThread.clear();
  byRequest.clear();
  if (!path || !existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; threads?: unknown; requests?: unknown };
    if (raw.v !== 1) return;
    for (const [threadId, list] of Object.entries((raw.threads ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const entries = list.filter((entry): entry is Entry => typeof entry?.at === "number" && typeof entry?.automation === "boolean").slice(-MAX_PER_THREAD);
      if (entries.length) byThread.set(threadId, entries);
    }
    for (const [requestId, value] of Object.entries((raw.requests ?? {}) as Record<string, unknown>)) if (typeof value === "boolean") byRequest.set(requestId, value);
  } catch {
    byThread.clear();
    byRequest.clear();
  }
}

function persist(threads: Map<string, Entry[]>, requests: Map<string, boolean>): void {
  if (!file) return;
  writeFileAtomic(file, JSON.stringify({ v: 1, threads: Object.fromEntries(threads), requests: Object.fromEntries(requests) }), { mode: 0o600 });
}

/** Test seam: forget the in-memory ledger without touching the file (what a restart does before configure reloads it). */
export function _resetAutomationAncestryForTest(): void {
  byThread.clear();
  byRequest.clear();
  file = undefined;
}
