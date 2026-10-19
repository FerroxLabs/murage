// Cloud implementation of the platform process hooks. A home mounts /proc with hidepid=2, so the server
// (user murage) cannot see sudo, the root launcher or the engine (murage-turn); anything that walks /proc
// would read "nothing left" and fail OPEN. These hooks never touch /proc: each turn runs in a scope unit
// whose name the server chose before spawning (turn-process.ts newTurnUnit, validated by the launcher),
// and the scope's cgroup (/sys/fs/cgroup/murage.slice/murage-turns.slice/<unit>) is world-readable.
//   listTree      cgroup.procs of the scope and every child cgroup (pids minus the root, which is sudo)
//   rssBytes      memory.current of the scope
//   confirmStopped  systemd says the unit is inactive/not-found AND the cgroup is gone or empty AND the
//                 root pid is gone (kill(pid,0) works across users and sees through hidepid)
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { cloudHomeCopy } from "./copy.ts";
import { TURN_SLICE, TURN_UNIT_PATTERN } from "./turn-process.ts";
import { setPlatformProcessHooks, type PlatformProcessHooks, type ProcessHandleInfo } from "./process-hooks.ts";

export const CGROUP_ROOT = "/sys/fs/cgroup";
/** systemd nests a slice by its dashes: murage-turns.slice lives at murage.slice/murage-turns.slice (seen on a real home). */
export function sliceCgroupPath(slice: string): string {
  const parts = slice.replace(/\.slice$/u, "").split("-");
  return parts.map((_, index) => `${parts.slice(0, index + 1).join("-")}.slice`).join("/");
}
const TURN_SLICE_PATH = sliceCgroupPath(TURN_SLICE);
export const SYSTEMCTL = "/usr/bin/systemctl";
/** TimeoutStopSec=5 in the launcher's scope properties, plus a margin. */
export const STOP_WAIT_MS = 5_000 + 3_000;
const POLL_MS = 100, MAX_DEPTH = 8, MAX_DIRS = 256, MAX_REGISTRY = 512;

export interface HookEnvironment {
  cgroupRoot: string;
  readText(path: string): Promise<string>;
  listDirs(path: string): Promise<string[]>;
  /** true = process exists (alive or zombie; EPERM counts), false = ESRCH. Throws on anything else. */
  processExists(pid: number): boolean;
  /** Output of `systemctl show -p ActiveState -p LoadState <unit>`; throws if it cannot be run. */
  systemctlShow(unit: string): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realEnvironment: HookEnvironment = {
  cgroupRoot: CGROUP_ROOT,
  readText: path => readFile(path, "utf8"),
  listDirs: async path => (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name),
  processExists(pid) {
    try { process.kill(pid, 0); return true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  },
  systemctlShow: unit => new Promise((resolve, reject) => execFile(SYSTEMCTL, ["show", "--no-pager", "-p", "ActiveState", "-p", "LoadState", unit],
    { timeout: 3_000, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout))),
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** pid (the direct child, sudo) -> scope unit. Overwritten when a pid is reused; bounded. */
const registry = new Map<number, { unit: string; scopeSeen: boolean }>();
export function registerCloudTurnUnit(pid: number | undefined, unit: string): void {
  if (pid === undefined || !TURN_UNIT_PATTERN.test(unit)) return;
  registry.delete(pid);
  registry.set(pid, { unit, scopeSeen: false });
  while (registry.size > MAX_REGISTRY) registry.delete(registry.keys().next().value as number);
}
export function forgetCloudTurnUnitsForTests(): void { registry.clear(); }

/** Registry first; else a tag that is itself a valid unit name (MURAGE_PROCESS_TAG). */
export function unitFor(child: ProcessHandleInfo): string | undefined {
  const known = registry.get(child.pid);
  if (known) return known.unit;
  return child.tag !== undefined && TURN_UNIT_PATTERN.test(child.tag) ? child.tag : undefined;
}

type Cgroup = { state: "gone" } | { state: "present"; pids: number[] };
/** Pids of the scope's cgroup and all descendants. "gone" only when the scope directory itself is absent. */
async function readCgroup(env: HookEnvironment, unit: string): Promise<Cgroup> {
  const base = `${env.cgroupRoot}/${TURN_SLICE_PATH}/${unit}`;
  const pids = new Set<number>();
  let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (++dirs > MAX_DIRS || depth > MAX_DEPTH) throw new Error(cloudHomeCopy.processGroupTooLarge);
    let text: string;
    try { text = await env.readText(`${dir}/cgroup.procs`); } catch (error) {
      if (errorCode(error) === "ENOENT") return false; // this cgroup was removed between listing and reading
      throw error;
    }
    for (const token of text.split("\n")) {
      if (token === "") continue;
      if (!/^[1-9][0-9]{0,9}$/u.test(token)) throw new Error(cloudHomeCopy.processGroupMalformed);
      pids.add(Number(token));
    }
    let children: string[];
    try { children = await env.listDirs(dir); } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    for (const child of children.sort()) await walk(`${dir}/${child}`, depth + 1);
    return true;
  };
  if (!(await walk(base, 0))) return { state: "gone" };
  return { state: "present", pids: [...pids].sort((a, b) => a - b) };
}

export function cloudProcessHooks(env: HookEnvironment = realEnvironment): PlatformProcessHooks {
  const rootGone = (pid: number) => { try { return !env.processExists(pid); } catch { return false; } };
  return {
    async listTree(child) {
      const unit = unitFor(child);
      if (!unit) return undefined;
      try {
        const group = await readCgroup(env, unit);
        const entry = registry.get(child.pid);
        if (group.state === "present") {
          if (entry) entry.scopeSeen = true;
          return group.pids.filter(pid => pid !== child.pid);
        }
        // Scope directory absent. Gone after it started (seen earlier, or the root already exited) = nothing left.
        // Absent while the root is still running and was never seen = not started yet = unknown.
        return entry?.scopeSeen || rootGone(child.pid) ? [] : undefined;
      } catch { return undefined; }
    },
    async rssBytes(child) {
      const unit = unitFor(child);
      if (!unit) return undefined;
      try {
        const text = (await env.readText(`${env.cgroupRoot}/${TURN_SLICE_PATH}/${unit}/memory.current`)).trim();
        return /^[0-9]{1,15}$/u.test(text) ? Number(text) : undefined;
      } catch { return undefined; }
    },
    async confirmStopped(child) {
      const unit = unitFor(child);
      const deadline = env.now() + STOP_WAIT_MS;
      for (;;) {
        let stopped = false;
        try {
          if (rootGone(child.pid)) {
            if (!unit) stopped = true; // not a launcher turn: nothing but the direct pid to confirm
            else {
              const shown = new Map((await env.systemctlShow(unit)).split("\n").map(line => line.split(/=(.*)/su).slice(0, 2) as [string, string]));
              // A scope systemd killed (RuntimeMaxSec, the memory cap) stays loaded as "failed" until reset; its
              // processes are gone, and the cgroup check below still has to agree.
              const inactive = ["inactive", "failed"].includes(shown.get("ActiveState") ?? "") || shown.get("LoadState") === "not-found";
              const group = await readCgroup(env, unit);
              stopped = inactive && (group.state === "gone" || group.pids.length === 0);
            }
          }
        } catch { stopped = false; }
        if (stopped) return true;
        if (env.now() >= deadline) return false;
        await env.sleep(POLL_MS);
      }
    },
  };
}

/** Called once at server start, and only on a Cloud home; the desktop never installs these. */
export function installCloudProcessHooks(role: string | undefined = process.env.MURAGE_CLOUD_ROLE): boolean {
  if (role !== "home") return false;
  setPlatformProcessHooks(cloudProcessHooks());
  return true;
}
