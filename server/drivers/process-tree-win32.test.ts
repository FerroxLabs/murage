// The process-tree probes under a mocked win32: the process table comes from the
// app's native process list (stubbed here; no PowerShell starts), so warm Claude and
// Codex engines get a baseline on Windows, and a listing that fails or is cut
// off still means "never reuse". Working sets come from tasklist.exe /FO CSV /NH.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface Native { pid: number; ppid: number; start: number; exe: string | null; argv: string[] | null; mine: boolean | null }
const exec = vi.hoisted(() => ({
  native: null as null | Native[],           // null: the native list fails
  tasklist: null as null | { error: unknown; stdout: string },
  calls: [] as Array<{ file: string; args: string[]; timeout?: number }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: (file: string, args: string[], opts: { timeout?: number }, cb: (error: unknown, stdout: string, stderr: string) => void) => {
      exec.calls.push({ file, args, timeout: opts?.timeout });
      const answer = exec.tasklist ?? { error: new Error("no stub"), stdout: "" };
      queueMicrotask(() => cb(answer.error, answer.stdout, ""));
      return {} as never;
    },
  };
});

vi.mock("../engine-exclusion.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../engine-exclusion.ts")>();
  return { ...real, loadExclusionAddon: () => ({ processes: () => { if (!exec.native) throw new Error("the process list could not be read"); return exec.native; } }) };
});

const { windowsMeasure } = await import("./warm-pool.ts");
const { descendantBaseline, descendantIdentities, descendantPids, untrackedDescendants, untrackedIdentified } = await import("./process-tree.ts");
const { rowsFromNative, parseTasklistMemory } = await import("./win-process-table.ts");

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => { Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" }); });
afterAll(() => { Object.defineProperty(process, "platform", realPlatform); });
afterEach(() => { exec.native = null; exec.tasklist = null; exec.calls = []; });

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const ft = (ms: number) => String((ms + FILETIME_EPOCH_OFFSET_MS) * 10_000);
const MB = 1024 * 1024;
type Row = [number, number, number | null];
const native = (rows: Row[]): Native[] => rows.map(([pid, ppid, ms]) => ({ pid, ppid, start: ms === null ? 0 : (ms + FILETIME_EPOCH_OFFSET_MS) / 1000, exe: "C:\\x\\p.exe", argv: [], mine: true }));
const tasklistOf = (rows: Row[]) => rows.map(([pid, , ms]) => `"p${pid}.exe","${pid}","Console","1","${ms === null ? "N/A" : `${(100 * 1024).toLocaleString("en-US")} K`}"`).join("\r\n") + "\r\n";
/** What the two sources answer for a set of rows. */
const listing = (rows: Row[], complete = true) => ({ rows, complete });
const answer = (l: { rows: Row[]; complete: boolean }, error: unknown = null) => {
  exec.native = l.complete && !error ? native(l.rows) : null;
  exec.tasklist = { error, stdout: tasklistOf(l.rows) };
};

const INIT = 1_800_000_000_000;
const ROOT = 100;
// the engine (100) with an MCP server (200) and its own child (201), all
// started before init; 300 is an unrelated process
const BEFORE: Array<[number, number, number | null]> = [
  [4, 0, null],
  [ROOT, 1, INIT - 10_000],
  [200, ROOT, INIT - 9_000],
  [201, 200, INIT - 8_500],
  [300, 1, INIT - 60_000],
];

describe("Windows process listing (mocked win32)", () => {
  it("starts no process at all for the tree probes (the native list is read in-process)", async () => {
    answer(listing(BEFORE));
    await descendantPids(ROOT);
    expect(exec.calls).toHaveLength(0);
  });

  it("the working-set read is tasklist.exe by absolute path with CSV and no header, never PowerShell", async () => {
    answer(listing(BEFORE));
    await windowsMeasure([ROOT]);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.file).toMatch(/System32.tasklist\.exe$/);
    expect(exec.calls[0]!.args).toEqual(["/FO", "CSV", "/NH"]);
  });

  it("a listing yields a baseline for the warm engine (Claude: descendantBaseline)", async () => {
    answer(listing(BEFORE));
    expect(await descendantBaseline(ROOT, INIT)).toEqual(new Set([200, 201]));
  });

  it("a listing yields a baseline for the warm engine (Codex: descendantPids)", async () => {
    answer(listing(BEFORE));
    expect(await descendantPids(ROOT)).toEqual(new Set([200, 201]));
  });

  it("a process started after init is never part of the baseline", async () => {
    answer(listing([...BEFORE, [400, ROOT, INIT + 2_000]]));
    expect(await descendantBaseline(ROOT, INIT)).toEqual(new Set([200, 201]));
  });

  it("a new descendant after the baseline blocks reuse; the baseline alone does not", async () => {
    answer(listing(BEFORE));
    const baseline = (await descendantBaseline(ROOT, INIT))!;
    answer(listing(BEFORE));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
    // a tool's background job (400) and its child (401), plus a worker an
    // MCP server left behind (202)
    answer(listing([...BEFORE, [400, ROOT, INIT + 5_000], [401, 400, INIT + 5_100], [202, 200, INIT + 6_000]]));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([400, 401, 202]));
  });

  it("listing failure, timeout or a cut-off answer means no baseline and no probe (never reuse)", async () => {
    answer(listing(BEFORE), Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(await descendantBaseline(ROOT, INIT)).toBeNull();
    answer(listing(BEFORE), Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL" }));
    expect(await descendantPids(ROOT)).toBeNull();
    answer(listing(BEFORE, false));
    expect(await untrackedDescendants(ROOT, new Set([200, 201]))).toBeNull();
    answer(listing(BEFORE, false));
    expect(await descendantIdentities(ROOT)).toBeNull();
  });

  it("identity probes (ACP) carry the creation time, so a recycled pid is new work", async () => {
    answer(listing(BEFORE));
    const ids = (await descendantIdentities(ROOT))!;
    expect(ids).toEqual(new Map([[200, ft(INIT - 9_000)], [201, ft(INIT - 8_500)]]));
    // pid 201 exited and Windows handed it to a new process
    answer(listing([...BEFORE.filter(([pid]) => pid !== 201), [201, 200, INIT + 7_000]]));
    const tree = (await untrackedIdentified(ROOT, ids))!;
    expect([...tree.fresh.keys()]).toEqual([201]);
    expect([...tree.alive.keys()]).toEqual([200]);
  });

  it("a stale parent link (the parent pid now belongs to a younger process) is not parentage", () => {
    // 500 was started by a long-gone process whose pid 200 now names the MCP
    // server, which started after 500 did
    const rows = rowsFromNative(native([[200, ROOT, INIT - 9_000], [500, 200, INIT - 30_000]]), null);
    expect(rows.find((row) => row.pid === 500)!.ppid).toBe(0);
    expect(rows.find((row) => row.pid === 200)!.ppid).toBe(ROOT);
  });
});

// The exact probe sequences the drivers run at a turn boundary on win32.
describe("warm reuse decision on mocked win32, per driver", () => {
  const settle = async (baseline: Set<number> | null, untracked: () => Promise<Set<number> | null>) => {
    if (!baseline) return "process probe has no baseline";
    const fresh = await untracked();
    if (!fresh) return "process probe unavailable";
    return fresh.size ? `child processes alive at settle (${fresh.size})` : "kept warm";
  };

  it("Claude (claude.ts: descendantBaseline at init, untrackedDescendants at settle)", async () => {
    answer(listing(BEFORE));
    const baseline = await descendantBaseline(ROOT, INIT);
    answer(listing(BEFORE));
    expect(await settle(baseline, () => untrackedDescendants(ROOT, baseline!))).toBe("kept warm");
    answer(listing([...BEFORE, [400, ROOT, INIT + 5_000]]));
    expect(await settle(baseline, () => untrackedDescendants(ROOT, baseline!))).toBe("child processes alive at settle (1)");
    answer(listing(BEFORE), new Error("the list is unavailable"));
    expect(await settle(await descendantBaseline(ROOT, INIT), async () => new Set())).toBe("process probe has no baseline");
  });

  it("Codex (codex.ts: descendantPids at spawn, untrackedDescendants at settle)", async () => {
    answer(listing(BEFORE));
    const baseline = await descendantPids(ROOT);
    answer(listing(BEFORE));
    expect(await settle(baseline, () => untrackedDescendants(ROOT, baseline!))).toBe("kept warm");
    answer(listing([...BEFORE, [400, ROOT, INIT + 5_000]]));
    expect(await settle(baseline, () => untrackedDescendants(ROOT, baseline!))).toBe("child processes alive at settle (1)");
    answer(listing(BEFORE), Object.assign(new Error("timed out"), { killed: true }));
    expect(await settle(await descendantPids(ROOT), async () => new Set())).toBe("process probe has no baseline");
  });

  it("an unrelated process tree (someone else's daemon) is never counted", async () => {
    // 300 is a foreign app-server with its own child 301: not below our engine
    answer(listing(BEFORE));
    const baseline = (await descendantBaseline(ROOT, INIT))!;
    answer(listing([...BEFORE, [301, 300, INIT + 5_000]]));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
  });
});

describe("Windows listing hardening (review round)", () => {
  it("P1-1: a damaged tasklist answer rejects the whole table, a damaged row included", async () => {
    const good = tasklistOf(BEFORE);
    expect(parseTasklistMemory(good)).not.toBeNull();
    expect(parseTasklistMemory(good + "garbage row here\r\n")).toBeNull();
    expect(parseTasklistMemory(good.replace('"200"', '"x"'))).toBeNull();
    expect(parseTasklistMemory("")).toBeNull();
    answer(listing(BEFORE));
    exec.tasklist = { error: null, stdout: good + "garbage row here\r\n" };
    expect(await windowsMeasure([ROOT])).toBeNull();
  });

  it("a process that has ended but is still held open by a handle is not in the table", () => {
    const list = native(BEFORE);
    list[2]!.exe = "";
    expect(rowsFromNative(list, null).map((row) => row.pid)).not.toContain(200);
  });

  it("P1-2: a baseline pid reused by a new background child is not exempt", async () => {
    answer(listing(BEFORE));
    const baseline = (await descendantBaseline(ROOT, INIT))!;
    // MCP server 200 (and its child 201) exited; a tool's background job got pid 200
    answer(listing([[ROOT, 1, INIT - 10_000], [200, ROOT, INIT + 5_000], [300, 1, INIT - 60_000]]));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([200]));
    // the real MCP server (same pid AND start) is still exempt
    answer(listing(BEFORE));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set());
  });

  it("P1-2: a baseline Set with no recorded identities exempts nothing on win32", async () => {
    answer(listing(BEFORE));
    expect(await untrackedDescendants(ROOT, new Set([200, 201]))).toEqual(new Set([200, 201]));
  });

  it("P1 (ACP): an unreadable creation time is no identity, so a recycled pid is never exempt", async () => {
    // baseline 200 had no readable start ("") and so does its pid's new owner
    answer(listing([[ROOT, 1, INIT - 10_000], [200, ROOT, null], [300, 1, INIT - 60_000]]));
    const tree = (await untrackedIdentified(ROOT, new Map([[200, ""]])))!;
    expect([...tree.fresh.keys()]).toEqual([200]);
    expect([...tree.alive.keys()]).toEqual([]);
  });

  it("P2-4: the working-set read is bounded below the Claude baseline wait (5 s)", async () => {
    answer(listing(BEFORE));
    await windowsMeasure([ROOT]);
    expect(exec.calls[0]!.timeout).toBeLessThan(5_000);
  });

  it("P2-5: an MCP server started 0.5 s before init is baseline even in init's own second", async () => {
    // init at x.700 s; the server started at x.200 s: same whole second
    const init = INIT + 700;
    const rows: Array<[number, number, number | null]> = [...BEFORE, [202, ROOT, init - 500], [203, ROOT, init + 100]];
    answer(listing(rows));
    const baseline = (await descendantBaseline(ROOT, init))!;
    expect(baseline).toEqual(new Set([200, 201, 202]));
    answer(listing(rows));
    expect(await untrackedDescendants(ROOT, baseline)).toEqual(new Set([203]));
  });
});

describe("warm pool resident size on mocked win32", () => {
  it("sums the working set of the engine's own tree from the same listing", async () => {
    answer(listing(BEFORE));
    expect(await windowsMeasure([ROOT])).toEqual(new Map([[ROOT, 300 * MB]]));
  });

  it("a failed listing, or a failed tasklist, leaves the size unknown", async () => {
    answer(listing(BEFORE), new Error("boom"));
    expect(await windowsMeasure([ROOT])).toBeNull();
    answer(listing(BEFORE));
    exec.tasklist = { error: new Error("tasklist failed"), stdout: "" };
    expect(await windowsMeasure([ROOT])).toBeNull();
  });
});
