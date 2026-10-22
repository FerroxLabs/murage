// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows job object a memory-maintenance (PIP) CLI runs in, through the engine-exclusion addon (no PowerShell: murage-releases #1).
// The server creates the named job (Local\murage-pip-<id>, KILL_ON_JOB_CLOSE) and holds its only handle, starts the CLI directly and
// puts it in the job at once. So the CLI and everything it starts end when the job is stopped by name, when the server closes its
// handle after the CLI exits, and when the server itself ends however it ends (Windows closes the handle).
//
// THE WINDOW. Node cannot start a process suspended, so the CLI runs for the moment between CreateProcess and AssignProcessToJobObject
// (the assignment is the next synchronous call after spawn() returns, well under a millisecond). A process the CLI starts inside that
// moment is not in the job. Every engine CLI takes far longer than that to load before it starts anything (MurageMain accepted this
// window; no suspended start), the assignment completes before the CLI's stdin receives any byte (spawnCli returns only after it, and
// only its caller writes the prompt), and a CLI whose assignment fails (the process cannot be opened or assigned) is ended at once
// with PIP_JOB_REFUSAL, its stdin closed unwritten, so it never runs on, or reads a prompt, outside its job.
import { requireWindowsAddon, type NativeHandle } from "../engine-exclusion.ts";

export const PIP_JOB_REFUSAL = 220;
const JOB_NAME = /^Local\\murage-pip-[a-zA-Z0-9-]+$/;

/** A job could not be created for a PIP run: the run is refused for isolation and no CLI is started. */
export class PipJobRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(`memory maintenance was not started: ${reason}`); this.reason = reason; }
}

/** Creates the named job, or throws PipJobRefusedError (a taken name, no addon, any failure). */
export function createPipJob(name: string): NativeHandle {
  if (!JOB_NAME.test(name)) throw new PipJobRefusedError("job name");
  try { return requireWindowsAddon().jobCreate!(name); }
  catch (error) { throw new PipJobRefusedError((error as NodeJS.ErrnoException)?.code ?? "job"); }
}

/** Puts `pid` in the job. False when it could not: the addon has then already ended that process with PIP_JOB_REFUSAL. */
export function assignPipJob(job: NativeHandle, pid: number): boolean {
  try { return requireWindowsAddon().jobAssign!(job, pid, PIP_JOB_REFUSAL); } catch { return false; }
}

/** Closes the server's handle: Windows ends every process still in the job. Safe to call twice. */
export function closePipJob(job: NativeHandle): void {
  try { requireWindowsAddon().jobClose!(job); } catch { /* the handle closes with the process at the latest */ }
}

export interface JobHelperResult { ok: boolean; out: string }
/** Terminates the named job and reports what is left, as JSON in `out` ({"state":"absent"} or {"state":"present","activeProcesses":n}).
 *  `signal` (when given) ends the wait at once and the answer is `ok: false`. Tests pass their own. */
export type JobHelperRunner = (jobName: string, waitMs: number, signal?: AbortSignal) => Promise<JobHelperResult>;
const runNative: JobHelperRunner = async (jobName, waitMs, signal) => {
  if (signal?.aborted) return { ok: false, out: "" };
  try { return { ok: true, out: JSON.stringify(await requireWindowsAddon().jobStop!(jobName, waitMs)) }; }
  catch { return { ok: false, out: "" }; }
};

/** The addon holds the opened job while terminating and polling its member count. A stop (`signal`) ends the wait at once and answers
 *  false: an interrupted look never says the job is gone, so the attempt keeps its transport record and the next pass owns the cleanup.
 *  The native wait is bounded by waitMs, and a runner that ignores the signal is raced against it. */
export async function stopWindowsJob(jobName: string, waitMs = 4_000, runner: JobHelperRunner = runNative, signal?: AbortSignal): Promise<boolean> {
  if (!JOB_NAME.test(jobName)) return false;
  if (signal?.aborted) return false;
  try {
    const helper = signal ? runner(jobName, waitMs, signal) : runner(jobName, waitMs);
    let onAbort: (() => void) | undefined;
    const stopped = signal ? new Promise<JobHelperResult>(resolve => { onAbort = () => resolve({ ok: false, out: "" }); signal.addEventListener("abort", onAbort, { once: true }); }) : undefined;
    let result: JobHelperResult;
    try { result = stopped ? await Promise.race([helper, stopped]) : await helper; }
    finally { if (onAbort) signal!.removeEventListener("abort", onAbort); }
    if (!result.ok || signal?.aborted) return false;
    const observation = JSON.parse(result.out.trim());
    return observation.state === "absent" || (observation.state === "present" && observation.activeProcesses === 0);
  } catch { return false; }
}
