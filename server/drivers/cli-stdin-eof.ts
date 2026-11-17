// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChildProcess } from "node:child_process";

/** The sole CLI EOF primitive. EOF carries no frame and must remain usable
 * while a failed S2 barrier is open. Mount-child EOF is a separate lifetime.
 * The relay's default preserves S1 EOF for callers without a driver callback. */
export function cliStdinEnd(s: { child: Pick<ChildProcess, "stdin"> }): void {
  s.child.stdin?.end();
}
