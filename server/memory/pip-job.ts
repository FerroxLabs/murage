// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { join } from "node:path";
import { SERVER_ROOT } from "../proxy-paths.ts";

export const PIP_JOB_REFUSAL = 220;
export const PIP_JOB_SUPERVISOR = join(SERVER_ROOT, "memory", "pip-job-supervisor.ps1");
export const powershellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PIP_JOB_SUPERVISOR];
export interface JobHelperResult { ok: boolean; out: string }
export type JobHelperRunner = (command: string, args: string[], timeoutMs: number) => Promise<JobHelperResult>;
const runHelper: JobHelperRunner = (command, args, timeout) => new Promise(resolve => {
  execFile(command, args, { timeout, encoding: "utf8", windowsHide: true }, (error, out) => resolve({ ok: !error, out: String(out ?? "") }));
});

/** The helper holds the opened job while terminating and polling its member count. */
export async function stopWindowsJob(jobName: string, waitMs = 4_000, runner: JobHelperRunner = runHelper): Promise<boolean> {
  if (!/^Local\\murage-pip-[a-zA-Z0-9-]+$/.test(jobName)) return false;
  try {
    const result = await runner("powershell.exe", [...powershellArgs, "-JobName", jobName, "-Stop", "-WaitMs", String(waitMs)], waitMs + 10_000);
    if (!result.ok) return false;
    const observation = JSON.parse(result.out.trim());
    return observation.state === "absent" || (observation.state === "present" && observation.activeProcesses === 0);
  } catch { return false; }
}
