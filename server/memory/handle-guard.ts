// SPDX-License-Identifier: AGPL-3.0-or-later
// Work that reads one connection across turns of the event loop (the reflection pass: its pending check and its thread choice hand the loop back
// between pages) can meet the connection closed or replaced part-way (a restore, a data-folder switch, shutdown). Whatever a closed handle
// throws then is not a failure of the work: the pass ends quietly and the next one starts on the connection that is current (stall r3: a close
// mid-walk threw out of runPipReflect and was recorded as a continuity failure).
import type { DatabaseSync } from "node:sqlite";

/** Runs `work`; an error it throws once `handle` is closed, or no longer the current connection (`replaced`), ends it with `undefined`. Any
 * other error is the work's own and is thrown as before. */
export async function endsWithHandle<T>(handle: DatabaseSync, replaced: () => boolean, work: () => Promise<T>): Promise<T | undefined> {
  try { return await work(); }
  catch (error) {
    let gone = false;
    try { gone = !handle.isOpen || replaced(); } catch { gone = true; }
    if (gone) return undefined;
    throw error;
  }
}
