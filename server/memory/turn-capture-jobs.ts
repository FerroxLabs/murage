// SPDX-License-Identifier: AGPL-3.0-or-later
/** The capture job written last for each thread, by id. A starting turn claims ITS capture by this primary key (jobs.ts claimMemoryJob
 * `jobId`), so the held tick never searches a scope for it. Memory only: a restart has no starting turn, and a stale id is harmless (the
 * claim re-checks the job's state). Bounded, oldest out. */
const newest = new Map<string, string>();
const LIMIT = 256;
export function noteTurnCaptureJob(threadId: string, jobId: string): void {
  newest.delete(threadId);
  newest.set(threadId, jobId);
  if (newest.size > LIMIT) newest.delete(newest.keys().next().value!);
}
export function turnCaptureJobId(threadId: string): string | undefined { return newest.get(threadId); }
/** Settled (claimed, or found not claimable): the id is not asked for again. */
export function forgetTurnCaptureJob(threadId: string, jobId: string): void { if (newest.get(threadId) === jobId) newest.delete(threadId); }
