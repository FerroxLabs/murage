// Platform process hooks (Murage Cloud): each hook overrides or vetoes exactly
// as specified, a throw counts as unconfirmed/unknown, and with no hooks set
// every caller behaves as it did before.
import { afterEach, describe, expect, it, vi } from "vitest";
import { descendantBaseline, descendantPids, untrackedDescendants } from "./drivers/process-tree.ts";
import { createWarmPool } from "./drivers/warm-pool.ts";
import {
  hasPlatformRss,
  platformConfirmStopped,
  platformListTree,
  processHandleInfo,
  setPlatformProcessHooks,
  type ProcessHandleInfo,
} from "./platform-process-hooks.ts";
import { awaitCliTreeStopped, killCliTree, spawnCli } from "./procs.ts";

const MB = 1024 * 1024;
const posix = process.platform !== "win32";

afterEach(() => setPlatformProcessHooks({}));

const sleeper = (env: NodeJS.ProcessEnv = process.env) => spawnCli("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"], env });

describe("platform process hooks", () => {
  it("with no hooks set, nothing changes: stop is confirmed by Murage alone and the process table is walked", async () => {
    expect(hasPlatformRss()).toBe(false);
    expect(await platformListTree(process.pid)).toBeUndefined();
    if (!posix) return;
    const child = sleeper();
    await new Promise((resolve) => child.once("spawn", resolve));
    expect(await platformConfirmStopped(child)).toBe(true);
    // the real walk sees the child under this process
    expect((await descendantPids(process.pid))?.has(child.pid!)).toBe(true);
    killCliTree(child);
    expect(await awaitCliTreeStopped(child, 1_000)).toBe(true);
  });

  it.runIf(posix)("records the spawn: pid, time, command, and MURAGE_PROCESS_TAG from the spawn env", async () => {
    const before = Date.now();
    const child = sleeper({ ...process.env, MURAGE_PROCESS_TAG: "box-7" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const info = processHandleInfo(child)!;
    expect(info.pid).toBe(child.pid);
    expect(info.spawnedAt).toBeGreaterThanOrEqual(before);
    expect(info.command).toMatch(/sleep 30$/);
    expect(info.tag).toBe("box-7");
    const untagged = sleeper({ ...process.env, MURAGE_PROCESS_TAG: undefined });
    await new Promise((resolve) => untagged.once("spawn", resolve));
    expect(processHandleInfo(untagged)!.tag).toBeUndefined();
    for (const c of [child, untagged]) { killCliTree(c); await awaitCliTreeStopped(c, 1_000); }
  });

  it.runIf(posix)("confirmStopped is ANDed with Murage's checks: false or a throw means unconfirmed", async () => {
    const seen: ProcessHandleInfo[] = [];
    let answer: () => Promise<boolean> = async () => false;
    setPlatformProcessHooks({ confirmStopped: async (info) => { seen.push(info); return answer(); } });
    const child = sleeper({ ...process.env, MURAGE_PROCESS_TAG: "cloud-1" });
    await new Promise((resolve) => child.once("spawn", resolve));
    killCliTree(child);
    expect(await awaitCliTreeStopped(child, 1_000)).toBe(false);
    expect(seen[0]).toMatchObject({ pid: child.pid, tag: "cloud-1" });
    answer = async () => { throw new Error("platform down"); };
    expect(await awaitCliTreeStopped(child, 1_000)).toBe(false);
    answer = async () => true;
    expect(await awaitCliTreeStopped(child, 1_000)).toBe(true);
  });

  it("confirmStopped cannot confirm what Murage itself could not", async () => {
    const hook = vi.fn(async () => true);
    setPlatformProcessHooks({ confirmStopped: hook });
    // a handle Murage never spawned has no owned lifecycle: unconfirmed, hook or not
    const stranger = { pid: 999_999 } as unknown as Parameters<typeof awaitCliTreeStopped>[0];
    expect(await awaitCliTreeStopped(stranger)).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  it("listTree replaces the walk for descendants, the turn baseline and the untracked check", async () => {
    const root = 4242;
    setPlatformProcessHooks({ listTree: async (info) => (info.pid === root ? [root, 5001, 5002] : undefined) });
    expect(await descendantPids(root)).toEqual(new Set([5001, 5002]));
    // a baseline without recorded creation identities exempts nothing (fail closed;
    // process-tree-hook-identity.test.ts covers the identity match). Windows has
    // no hook start identity: the settle check is unknown (null), so the turn
    // recycles (documented fail-closed behaviour in process-tree.ts).
    if (!posix) {
      expect(await untrackedDescendants(root, new Set([5001]))).toBeNull();
      return;
    }
    expect(await untrackedDescendants(root, new Set([5001]))).toEqual(new Set([5001, 5002]));
    expect(await untrackedDescendants(root, new Set([5001, 5002]))).toEqual(new Set([5001, 5002]));
    // the baseline reads each listed pid's start time (process-tree.test.ts
    // covers the started-after-init rule): a pid with none is never baseline
    if (!posix) return;
    setPlatformProcessHooks({ listTree: async (info) => (info.pid === root ? [root, 999_998, 999_999] : undefined) });
    expect(await descendantBaseline(root, Date.now())).toEqual(new Set());
  });

  it("listTree answering undefined, or throwing, means unknown: no tree, so nothing parks", async () => {
    setPlatformProcessHooks({ listTree: async () => undefined });
    expect(await descendantPids(4242)).toBeNull();
    expect(await untrackedDescendants(4242, new Set())).toBeNull();
    expect(await descendantBaseline(4242, Date.now())).toBeNull();
    setPlatformProcessHooks({ listTree: async () => { throw new Error("no answer"); } });
    expect(await descendantPids(4242)).toBeNull();
    expect(await untrackedDescendants(4242, new Set())).toBeNull();
  });

  it("rssBytes replaces the warm pool's measurement; undefined or a throw counts as 600 MB", async () => {
    setPlatformProcessHooks({
      rssBytes: async (info) => {
        if (info.pid === 2) return undefined;
        if (info.pid === 3) throw new Error("no answer");
        return 100 * MB;
      },
    });
    const measure = vi.fn(async () => new Map<number, number>());
    const pool = createWarmPool({ now: () => 1, totalmem: () => 64 * 1024 * MB, freemem: () => 64 * 1024 * MB, sampleFree: async () => {}, measure, env: { MURAGE_WARM_POOL_BUDGET_MB: "8000" }, log: () => {}, timer: false });
    pool.noteUserActivity();
    for (const [pid, engine] of [[1, "claude"], [2, "codex"], [3, "acp"]] as const) {
      await pool.markIdle({}, { engine, threadId: `t${pid}`, pid: () => pid, close: () => {} });
    }
    expect(measure).not.toHaveBeenCalled();
    expect(pool.poolBytes()).toBe(100 * MB + 600 * MB + 600 * MB);
  });
});
