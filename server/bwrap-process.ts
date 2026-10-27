// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";

/** Host PIDs from the supervisor's /proc or bwrap's private status fd, never engine output. */
export interface HostProcessIdentity { pid: number; start: string }
interface HostProcess extends HostProcessIdentity { ppid: number; state: string }
export const bwrapProcessDeps = {
  read: (path: string): string => readFileSync(path, "utf8"),
  tasks: (path: string): string[] => readdirSync(path),
};

/** null means confirmed absent; undefined means the observation was unavailable. */
function hostProcess(pid: number): HostProcess | null | undefined {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return undefined;
  try {
    const stat = bwrapProcessDeps.read(`/proc/${pid}/stat`);
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || !/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? "")) return undefined;
    return { pid, start: fields[19], ppid: Number(fields[1]), state: fields[0] };
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") ? null : undefined;
  }
}

export function hostProcessIdentity(pid: number): HostProcessIdentity | undefined {
  const current = hostProcess(pid);
  return current && !["Z", "X"].includes(current.state) ? { pid, start: current.start } : undefined;
}

/** A missing/replaced/zombie init has completed the kernel's PID-namespace teardown, including descendants with no pipes. */
export function hostProcessGone(identity: HostProcessIdentity): boolean {
  const current = hostProcess(identity.pid);
  return current === null || !!current && (current.start !== identity.start || ["Z", "X"].includes(current.state));
}

/** Recheck both identities and parentage immediately before signalling an engine. */
export function hostProcessIsChild(identity: HostProcessIdentity, parent: HostProcessIdentity): boolean {
  const currentParent = hostProcess(parent.pid);
  const current = hostProcess(identity.pid);
  return !!currentParent && currentParent.start === parent.start && !["Z", "X"].includes(currentParent.state)
    && !!current && current.start === identity.start && current.ppid === parent.pid && !["Z", "X"].includes(current.state);
}

function onlyChild(parent: HostProcessIdentity): HostProcessIdentity | undefined {
  try {
    const children = new Map<number, string | undefined>();
    let scan = false;
    for (const task of bwrapProcessDeps.tasks(`/proc/${parent.pid}/task`)) {
      if (!/^\d+$/.test(task)) continue;
      let text: string;
      try { text = bwrapProcessDeps.read(`/proc/${parent.pid}/task/${task}/children`); }
      catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) { scan = true; continue; }
        return undefined;
      }
      for (const word of text.trim().split(/\s+/).filter(Boolean)) {
        if (!/^\d+$/.test(word)) return undefined;
        children.set(Number(word), undefined);
      }
    }
    // CONFIG_PROC_CHILDREN is optional. The final parent/child checks still apply.
    if (scan) {
      children.clear();
      for (const name of bwrapProcessDeps.tasks("/proc")) {
        if (!/^\d+$/.test(name) || Number(name) <= 1 || Number(name) === process.pid) continue;
        const candidate = hostProcess(Number(name));
        if (candidate === undefined) return undefined;
        if (candidate?.ppid === parent.pid) children.set(candidate.pid, candidate.start);
      }
    }
    // The shipped bwrap has one namespace init, which in turn starts one engine.
    // Do not guess among multiple children (e.g. an engine already exited and left orphans).
    if (children.size !== 1) return undefined;
    const [pid, start] = [...children][0];
    const child = hostProcess(pid);
    const currentParent = hostProcess(parent.pid);
    if (!child || (start !== undefined && child.start !== start) || child.ppid !== parent.pid || ["Z", "X"].includes(child.state)
      || !currentParent || currentParent.start !== parent.start || ["Z", "X"].includes(currentParent.state)) return undefined;
    return { pid: child.pid, start: child.start };
  } catch { return undefined; }
}

/** Resolve bwrap -> namespace init -> engine using host parentage; a partial result can still retain the init for Stop. */
export function resolveBwrapProcesses(wrapper: HostProcessIdentity): { init?: HostProcessIdentity; engine?: HostProcessIdentity } {
  const init = onlyChild(wrapper);
  if (!init) return {};
  return { init, engine: onlyChild(init) };
}
