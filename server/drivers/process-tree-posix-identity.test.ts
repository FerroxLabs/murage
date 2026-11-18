import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The native POSIX path (no platform listTree hook) on Linux. ps is mocked: every
// `ps -A` listing is built from `ps.rows` (pid -> ppid + comm), so a test can let a
// baseline process exit and hand its pid to another descendant between baseline and
// settle. /proc/<pid>/stat answers from `proc.ticks` (absent = unreadable).
const ps = vi.hoisted(() => ({ rows: new Map<number, { ppid: number; comm: string }>() }));
const proc = vi.hoisted(() => ({ ticks: new Map<number, number>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = async (path: unknown, ...rest: unknown[]) => {
    if (String(path) === "/proc/uptime") return "100000.00 0.00\n";
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(path));
    if (!match) return (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest);
    const ticks = proc.ticks.get(Number(match[1]));
    if (ticks === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return `${match[1]} (node) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks} 0 0\n`;
  };
  return { ...actual, readFile };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
    if (cmd !== "ps" || args[0] !== "-A") return cb(new Error("unexpected"), "");
    const fields = args[2]!;
    const lines = [...ps.rows].map(([pid, row]) => fields === "pid=,ppid=,etime=,comm="
      ? `${pid} ${row.ppid} 10:00 ${row.comm}`
      : fields === "pid=,ppid=,stat=,comm=" ? `${pid} ${row.ppid} S ${row.comm}` : `${pid} ${row.ppid} ${row.comm}`);
    cb(null, lines.join("\n") + "\n");
  };
  return { ...actual, execFile };
});

import { descendantBaseline, descendantPids, untrackedDescendants } from "./process-tree.ts";

const ROOT = 4242;

describe.skipIf(process.platform === "win32")("native POSIX settle: baseline identity survives pid reuse", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });
  beforeEach(() => {
    setPlatform("linux");
    ps.rows = new Map([[200, { ppid: ROOT, comm: "mcp-server" }], [201, { ppid: ROOT, comm: "relay" }]]);
    proc.ticks = new Map([[200, 5000], [201, 5001]]);
    alive(200, 201, 300);
  });
  afterEach(() => { vi.restoreAllMocks(); if (realPlatform) Object.defineProperty(process, "platform", realPlatform); });

  /** process.kill(pid, 0) answers: the listed pids are alive (or gone) as far as the OS is concerned. */
  const signal0 = (answer: (pid: number) => "alive" | "gone" | "real") => {
    const real = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      const verdict = answer(Number(pid));
      if (verdict === "real" || sig !== 0) return real(pid, sig);
      if (verdict === "alive") return true;
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
  };
  const alive = (...pids: number[]) => signal0((pid) => (pids.includes(pid) ? "alive" : "real"));
  const gone = (...pids: number[]) => signal0((pid) => (pids.includes(pid) ? "gone" : "real"));

  /** Baseline server 200 exits; a later descendant (a tool's worker under the relay)
   * is handed pid 200 and starts a child of its own. */
  const reuse200 = () => {
    ps.rows.set(200, { ppid: 201, comm: "worker" });
    ps.rows.set(300, { ppid: 200, comm: "sleep" });
    proc.ticks.set(200, 9000);
    proc.ticks.set(300, 9001);
  };

  it("claude path: a reused baseline pid and what runs below it are reported, the same processes stay exempt", async () => {
    const baseline = (await descendantBaseline(ROOT, Date.now()))!;
    expect(baseline).toEqual(new Set([200, 201]));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
    reuse200();
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200, 300]));
  });

  it("codex path: descendantPids records identities; a reused pid is reported", async () => {
    const baseline = (await descendantPids(ROOT))!;
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
    reuse200();
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200, 300]));
  });

  it("a baseline pid whose start is unreadable at settle, or was unreadable at baseline, is not exempt", async () => {
    alive(200);
    const baseline = (await descendantPids(ROOT))!;
    proc.ticks.delete(200);
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    const blind = (await descendantPids(ROOT))!;
    proc.ticks.set(200, 5000);
    expect(await untrackedDescendants(ROOT, blind)).toEqual(new Set([200]));
  });

  it("a baseline process that exits between the settle listing and its identity read is gone, not work", async () => {
    const baseline = (await descendantBaseline(ROOT, Date.now()))!;
    // ordering gate: ps listed 200 (with a child of its own), then 200 exited before /proc was read
    ps.rows.set(300, { ppid: 200, comm: "sleep" });
    proc.ticks.set(300, 9001);
    proc.ticks.delete(200);
    gone(200);
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([300]));
  });

  it("a set with no recorded identities exempts nothing", async () => {
    alive(200, 201);
    expect(await untrackedDescendants(ROOT, new Set([200, 201]))).toEqual(new Set([200, 201]));
  });
});
