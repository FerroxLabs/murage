// Types for child-pipe-quiet.mjs. It is authored as `.mjs` rather than `.ts`
// on purpose: the negative control in `child-pipe-quiet.test.ts` has to spawn
// a REAL node process to observe whether that process survives, and a spawned
// node cannot import TypeScript. The fixture imports this module directly, so
// what the test proves is the shipped code and not a copy of it.
import type { ChildProcess } from "node:child_process";

/**
 * Attach a no-op `'error'` listener to a spawned child's stdin, stdout and
 * stderr, so a pipe whose peer has gone cannot end this process.
 *
 * Call once, immediately after spawn. It swallows nothing a caller already
 * handles: existing listeners and write callbacks still run.
 */
export function quietChildPipes(child: ChildProcess | null | undefined): void;
