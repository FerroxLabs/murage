// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostProcessIdentity, resolveBwrapProcesses } from "../bwrap-process.ts";
import { processHandleInfoForPid } from "../platform-process-hooks.ts";

/** Isolated-server fixture only. bwrap's --die-with-parent ends the namespace
 * when its supervisor dies; the engine cannot delay that with a TERM handler.
 * Deliver engine TERM and record its host PID separately from the engine's
 * TERM marker. The engine itself holds TERM until the gate opens. Also delay
 * group TERM to this tagged, still-owned handle. SIGKILL is never delayed,
 * and neither the wrapper nor its block is bypassed. */
export function installCliStopGate(tag: string, gate: string, enginePidFile: string): void {
  if (process.platform !== "linux") return;
  const kill = process.kill.bind(process);
  const pending = new Set<number>();
  const parentPid = (pid: number): number => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
  };
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid > 1 && signal === "SIGTERM") {
      // Walk engine -> namespace init -> supervisor in the host /proc, then
      // verify the tagged supervisor resolves back to this exact engine.
      let taggedEngine = false;
      try {
        const wrapperPid = parentPid(parentPid(pid));
        const wrapper = hostProcessIdentity(wrapperPid);
        taggedEngine = processHandleInfoForPid(wrapperPid).tag === tag && !!wrapper
          && resolveBwrapProcesses(wrapper).engine?.pid === pid;
      } catch { /* an unrelated or already-ended process */ }
      const sent = kill(pid, signal);
      if (taggedEngine) writeFileSync(enginePidFile, String(pid));
      return sent;
    }
    if (pid >= -1 || signal !== "SIGTERM") return kill(pid, signal);
    const handle = processHandleInfoForPid(-pid);
    if (handle.tag !== tag || existsSync(gate)) return kill(pid, signal);
    if (!pending.has(pid)) {
      pending.add(pid);
      const timer = setInterval(() => {
        // close removes the registered handle. Never signal a recycled PID.
        if (processHandleInfoForPid(-pid) !== handle) {
          clearInterval(timer); pending.delete(pid); return;
        }
        if (!existsSync(gate)) return;
        clearInterval(timer); pending.delete(pid);
        try { kill(pid, signal); } catch { /* already ended */ }
      }, 10);
      timer.unref();
    }
    return true;
  }) as typeof process.kill;
}
