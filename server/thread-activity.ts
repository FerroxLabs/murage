// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which threads changed, and in what order, since a moment of this process.
// message-db.ts notes every message written or thread deleted; a reader that
// keeps something built from a set of threads (working-context.ts) asks which
// of them changed since it built it, and pays for the changes only, never for
// the history. The log is a fixed ring: a reader that falls further behind
// than it reaches is told it cannot know (null) and rebuilds.

const LOG_SIZE = 8192;
const threads: string[] = new Array(LOG_SIZE);
const seqs: number[] = new Array(LOG_SIZE).fill(0);
let written = 0;
let seq = 0;

/** A message of `threadId` was written, or the thread was deleted. */
export function noteThreadChanged(threadId: string): void {
  seq++;
  // a streamed reply rewrites one message many times: one entry while the same thread keeps changing
  if (written > 0) {
    const last = (written - 1) % LOG_SIZE;
    if (threads[last] === threadId) { seqs[last] = seq; return; }
  }
  threads[written % LOG_SIZE] = threadId;
  seqs[written % LOG_SIZE] = seq;
  written++;
}

/** The current position: pass it to `threadsChangedSince` later. */
export function threadActivitySeq(): number { return seq; }

/** The threads that changed after `since`, or null when the log no longer reaches back that far. */
export function threadsChangedSince(since: number): Set<string> | null {
  const changed = new Set<string>();
  if (since >= seq) return changed;
  for (let index = written - 1; index >= 0 && index >= written - LOG_SIZE; index--) {
    const at = index % LOG_SIZE;
    if (seqs[at]! <= since) return changed;
    changed.add(threads[at]!);
  }
  return written <= LOG_SIZE ? changed : null;
}
