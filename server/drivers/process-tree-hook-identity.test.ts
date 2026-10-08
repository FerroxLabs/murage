import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every case sets the platform it exercises (asLinux / asDarwin) and mocks the
// identity source that platform uses (/proc on linux), so results do not depend on the host OS.
// ps is mocked: `lstart` answers come from `starts` (pid -> text; absent = gone/unreadable),
// the etime answer from `etimes`.
const ps = vi.hoisted(() => ({
  starts: new Map<number, string>(), etimes: new Map<number, string>(), fail: false,
  calls: 0, // ps invocations so far
  laterStarts: null as Map<number, string> | null, // answers from the second ps call on (a pid replaced meanwhile)
}));
// /proc/<pid>/stat answers (Linux path): pid -> queue of starttime ticks, the last one repeats; absent = unreadable
const proc = vi.hoisted(() => ({ ticks: new Map<number, number[]>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = async (path: unknown, ...rest: unknown[]) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(path));
    if (!match) return (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest);
    const queue = proc.ticks.get(Number(match[1]));
    if (!queue?.length) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const ticks = queue.length > 1 ? queue.shift()! : queue[0]!;
    // 18 filler fields (4..21) then field 22; comm holds a space and parens
    return `${match[1]} (a b) c)) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks} 0 0\n`;
  };
  return { ...actual, readFile };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
    if (cmd !== "ps") return cb(new Error("unexpected"), "");
    if (ps.fail) return cb({ code: 2 }, "");
    const pids = args[args.length - 1]!.split(",").map(Number);
    ps.calls += 1;
    const starts = ps.calls > 1 && ps.laterStarts ? ps.laterStarts : ps.starts;
    const lines = args[0] === "-ww"
      ? pids.filter((p) => starts.has(p)).map((p) => `${p} 1 ${starts.get(p)} node server.js`)
      : args[1] === "pid=,lstart="
      ? pids.filter((p) => starts.has(p)).map((p) => `${p} ${starts.get(p)}`)
      : args[1] === "pid=,etime=,lstart="
        ? pids.filter((p) => ps.etimes.has(p) && starts.has(p)).map((p) => `${p} ${ps.etimes.get(p)} ${starts.get(p)}`)
        : pids.filter((p) => ps.etimes.has(p)).map((p) => `${p} ${ps.etimes.get(p)}`);
    cb(null, lines.join("\n") + "\n");
  };
  return { ...actual, execFile };
});

import { setPlatformProcessHooks } from "../platform-process-hooks.ts";
import { descendantBaseline, descendantIdentities, descendantPids, processParentsAndArgs, untrackedDescendants } from "./process-tree.ts";

const T1 = "Wed Oct  7 10:00:00 2026";
const ROOT = 4242;

describe.skipIf(process.platform === "win32")("listTree hook baseline identity", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });
  const asLinux = () => setPlatform("linux");
  const asDarwin = () => setPlatform("darwin");
  beforeEach(() => { ps.starts = new Map(); ps.etimes = new Map(); ps.fail = false; ps.calls = 0; ps.laterStarts = null; proc.ticks = new Map(); });
  afterEach(() => { setPlatformProcessHooks({}); if (realPlatform) Object.defineProperty(process, "platform", realPlatform); });

  const hook = (list: () => number[]) => setPlatformProcessHooks({ listTree: async () => list() });

  describe("Linux: /proc starttime identity", () => {
    beforeEach(asLinux);

    it("codex path: a baseline pid recycled to a new process is reported fresh", async () => {
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantPids(ROOT))!;
      proc.ticks.set(200, [7000]); // pid 200 exited and was reused
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("codex path: the same pid with the same identity stays exempt", async () => {
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantPids(ROOT))!;
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
    });

    it("codex path: an unreadable identity is not exempt", async () => {
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantPids(ROOT))!;
      proc.ticks.delete(200);
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
      // unreadable when the baseline was taken: never exempt later either
      const blind = (await descendantPids(ROOT))!;
      proc.ticks.set(200, [5000]);
      expect(await untrackedDescendants(ROOT, blind)).toEqual(new Set([200]));
    });

    it("a failed ps at baseline is unknown (null)", async () => {
      ps.etimes.set(200, "10:00");
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      ps.fail = true;
      expect(await descendantBaseline(ROOT, Date.now())).toBeNull();
    });

    it("claude path: descendantBaseline records identities; a recycled pid is fresh, the same one exempt", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1);
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantBaseline(ROOT, Date.now()))!;
      expect(baseline).toEqual(new Set([200]));
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
      proc.ticks.set(200, [7000]);
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("a pid that is new at settle is reported", async () => {
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantPids(ROOT))!;
      proc.ticks.set(300, [6000]);
      hook(() => [200, 300]);
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([300]));
    });

    it("claude path: age and identity come from ONE ps record (one ps call)", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1);
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantBaseline(ROOT, Date.now()))!;
      expect(baseline).toEqual(new Set([200]));
      expect(ps.calls).toBe(1);
    });

    it("two processes sharing a pid within one lstart second are told apart", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1); // lstart cannot tell them apart
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const baseline = (await descendantBaseline(ROOT, Date.now()))!;
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set()); // same process stays exempt
      proc.ticks.set(200, [5003]); // replacement, same second, 30 ms later
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("a pid replaced while the baseline probe ran is left out of the baseline", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1);
      proc.ticks.set(200, [5000, 5003]); // read before ps, then read after: different process
      hook(() => [200]);
      expect(await descendantBaseline(ROOT, Date.now())).toEqual(new Set());
    });

    it("an unreadable /proc identity is never exempt", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1);
      hook(() => [200]); // no /proc entry at baseline
      const baseline = (await descendantBaseline(ROOT, Date.now()))!;
      proc.ticks.set(200, [5000]);
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("ACP: processParentsAndArgs start equals the descendantIdentities one, so a legitimate replacement reconciles", async () => {
      ps.starts.set(200, T1);
      proc.ticks.set(200, [5000]);
      hook(() => [200]);
      const ids = (await descendantIdentities(ROOT))!;
      const seen = (await processParentsAndArgs([200]))!;
      expect(ids.get(200)).toBe("proc:5000");
      expect(seen.get(200)!.start).toBe(ids.get(200));
      expect(seen.get(200)!.args).toBe("node server.js");
    });

    it("ACP: without a hook the ps lstart is still reported", async () => {
      ps.starts.set(200, T1);
      const seen = (await processParentsAndArgs([200]))!;
      expect(seen.get(200)!.start).toBe("Wed Oct 7 10:00:00 2026");
    });
  });

  describe("macOS under a hook: identity is unavailable, so nothing is ever exempt (fail closed)", () => {
    beforeEach(asDarwin);

    it("codex path: even the same pid with the same lstart is reported", async () => {
      ps.starts.set(200, T1);
      hook(() => [200]);
      const baseline = (await descendantPids(ROOT))!;
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("claude path: baseline holds the pid but a same-second reuse (same lstart) is not exempt", async () => {
      ps.etimes.set(200, "10:00");
      ps.starts.set(200, T1);
      hook(() => [200]);
      const baseline = (await descendantBaseline(ROOT, Date.now()))!;
      expect(baseline).toEqual(new Set([200]));
      expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    });

    it("ACP: identities are empty on both sides, so reconciliation never admits", async () => {
      ps.starts.set(200, T1);
      hook(() => [200]);
      expect((await descendantIdentities(ROOT))!.get(200)).toBe("");
      expect((await processParentsAndArgs([200]))!.get(200)!.start).toBe("");
    });
  });
});
