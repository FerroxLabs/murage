// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The OS write floor on macOS (IO-IDLE-DRAIN-1018 r3.6). getrusage's block-output count, which Node returns as
// process.resourceUsage().fsWrite, reads 0 on macOS, so the io watchdog saw only WAL frames and the outputs noted in io-written.ts
// there, and 10 MB of fsynced other writes went unseen (M2 failed on the Mac). The shipped engine-exclusion addon answers instead with
// proc_pid_rusage(getpid(), RUSAGE_INFO_V2).ri_diskio_byteswritten: this process and all its threads, the same set getrusage(RUSAGE_SELF)
// counts on Linux (child processes are on neither: their database writes reach the watchdog as WAL frames of their files).
// Fail closed: no addon, an addon without diskWritten, a null, a throw, a non-finite value or a count that went DOWN is null, which the
// caller treats as UNKNOWN, never as 0 (io-budget.ts tick; revoke-budget.ts paces at the strict bound).
import { loadExclusionAddon } from "./engine-exclusion.ts";

let highest = 0;
/** macOS: this process's cumulative bytes written to storage, or null when they cannot be read (see the header). `read` is for tests. */
export function darwinWrittenBytes(read: () => unknown = () => loadExclusionAddon()?.diskWritten?.()): number | null {
  let value: unknown;
  try { value = read(); } catch { return null; }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value < highest) return null;
  highest = value;
  return value;
}
/** Test only: forget the highest count seen (a fresh fake counter). */
export function resetDarwinWrittenForTest(): void { highest = 0; }
