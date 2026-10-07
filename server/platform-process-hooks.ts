// Process hooks a hosting platform (Murage Cloud) can install to answer, for
// the engine processes Murage spawns, what Murage otherwise learns from the
// local OS: whether a process tree has stopped, which processes are in it, and
// how much memory it holds. With no hooks installed every caller behaves
// exactly as it does without this module.
import type { ChildProcess } from "node:child_process";

export interface ProcessHandleInfo { pid: number; spawnedAt: number; command: string; tag?: string }

export interface PlatformProcessHooks {
  /** ANDed with Murage's own stop checks; false or a throw means unconfirmed. */
  confirmStopped?(child: ProcessHandleInfo): Promise<boolean>;
  /** REPLACES the process-table walk for that child; undefined means unknown, so don't park. */
  listTree?(child: ProcessHandleInfo): Promise<number[] | undefined>;
  /** Resident bytes for the warm-pool budget; undefined means unknown (600 MB is assumed). */
  rssBytes?(child: ProcessHandleInfo): Promise<number | undefined>;
}

let installed: PlatformProcessHooks = {};

export function setPlatformProcessHooks(hooks: PlatformProcessHooks): void {
  installed = { ...hooks };
}

/** The hooks in force now (an empty object when none were set). */
export function platformProcessHooks(): Readonly<PlatformProcessHooks> {
  return installed;
}

const byChild = new WeakMap<ChildProcess, ProcessHandleInfo>();
const byPid = new Map<number, ProcessHandleInfo>();

/** Record what Murage knows about a process it just spawned. `tag` comes from
 * the spawn env's MURAGE_PROCESS_TAG when it is set. */
export function recordProcessHandle(child: ChildProcess, command: string, env: NodeJS.ProcessEnv | undefined): ProcessHandleInfo | undefined {
  if (typeof child.pid !== "number") return undefined;
  const tag = (env ?? process.env).MURAGE_PROCESS_TAG;
  const info: ProcessHandleInfo = { pid: child.pid, spawnedAt: Date.now(), command, ...(tag ? { tag } : {}) };
  byChild.set(child, info);
  byPid.set(info.pid, info);
  child.once("close", () => { if (byPid.get(info.pid) === info) byPid.delete(info.pid); });
  return info;
}

/** The recorded handle of a spawned process, if Murage spawned it. */
export function processHandleInfo(child: ChildProcess): ProcessHandleInfo | undefined {
  return byChild.get(child);
}

/** The handle of a live process by pid; a minimal one when it was not recorded. */
export function processHandleInfoForPid(pid: number): ProcessHandleInfo {
  return byPid.get(pid) ?? { pid, spawnedAt: 0, command: "" };
}

function infoForChild(child: ChildProcess): ProcessHandleInfo | null {
  const known = byChild.get(child);
  if (known) return known;
  if (typeof child.pid !== "number") return null;
  return { pid: child.pid, spawnedAt: 0, command: (child.spawnargs ?? []).join(" ") };
}

/** The platform's stop confirmation: true when no hook is set; false when the
 * hook answers anything but true, or throws. */
export async function platformConfirmStopped(child: ChildProcess): Promise<boolean> {
  const hook = installed.confirmStopped;
  if (!hook) return true;
  const info = infoForChild(child);
  if (!info) return true; // never spawned: nothing for the platform to confirm
  try {
    return (await hook.call(installed, info)) === true;
  } catch {
    return false;
  }
}

/** The platform's descendants of `root` (root itself left out): undefined when
 * no hook is set (walk the process table), null when the platform does not
 * know or the hook threw. */
export async function platformListTree(root: number): Promise<Set<number> | null | undefined> {
  const hook = installed.listTree;
  if (!hook) return undefined;
  try {
    const pids = await hook.call(installed, processHandleInfoForPid(root));
    if (!Array.isArray(pids)) return null;
    return new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== root));
  } catch {
    return null;
  }
}

/** Whether a resident-size hook is installed. */
export const hasPlatformRss = (): boolean => typeof installed.rssBytes === "function";

/** The platform's resident bytes per pid; a pid it does not know is left out. */
export async function platformRss(pids: number[]): Promise<Map<number, number>> {
  const hook = installed.rssBytes;
  const out = new Map<number, number>();
  if (!hook) return out;
  await Promise.all(pids.map(async (pid) => {
    try {
      const bytes = await hook.call(installed, processHandleInfoForPid(pid));
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) out.set(pid, bytes);
    } catch { /* unknown: the pool assumes 600 MB */ }
  }));
  return out;
}
