// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the chat MCP descendant stop (chat-mcp-client.ts ChatMcpDescendants) and the mount relay hold that reads it
// (cli-mount-relay.ts). Off Linux the stop's descendant snapshot is a full `ps` listing. On a loaded machine that listing takes
// longer than a second. The stop used to give up on it after one second, end the server anyway and mark itself unable to confirm
// for good: the run stayed owned until Murage was restarted, and a descendant that had left the process group was never found.
// The process table here is a fixture; the `ps` child is replaced, nothing else is.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

type PsCallback = (error: Error | null, stdout: string, stderr: string) => void;
const ps = vi.hoisted(() => ({
  /** every `ps` call: its arguments and the time it was started */
  calls: [] as Array<{ args: string[]; at: number }>,
  /** how the fixture answers a call: delay, then an error or the rows */
  listing: { delayMs: 0, fail: false, rows: [] as string[] },
  /** rows by pid for the `-p` probe of remembered descendants */
  alive: new Map<number, string>(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (args[0] !== "ps") return Reflect.apply(actual.execFile, actual, args);
      const argv = args[1] as string[];
      const callback = args[args.length - 1] as PsCallback;
      ps.calls.push({ args: argv, at: Date.now() });
      if (argv.includes("-A")) {
        const { delayMs, fail, rows } = ps.listing;
        setTimeout(() => (fail ? callback(new Error("ps was killed"), "", "") : callback(null, rows.join("\n") + "\n", "")), delayMs).unref();
      } else {
        const asked = argv[argv.indexOf("-p") + 1]!.split(",").map(Number);
        const rows = asked.map((pid) => ps.alive.get(pid)).filter((row): row is string => row !== undefined);
        setTimeout(() => callback(null, rows.join("\n") + "\n", ""), 0);
      }
      return {};
    },
  };
});
import { ChatMcpDescendants } from "./chat-mcp-client.ts";

const ROOT = 4_100_001;
const ESCAPED = 4_100_002;
const START = "Sat Nov 21 11:00:00 2026";
const fullListings = () => ps.calls.filter((call) => call.args.includes("-A"));
let killed: Array<{ pid: number; signal: string | number | undefined }> = [];

beforeEach(() => {
  ps.calls.length = 0;
  ps.alive.clear();
  ps.listing = { delayMs: 0, fail: false, rows: [`${ROOT} 1 ${START} mcp-server`] };
  killed = [];
  // the fixture pids are not real: a signal to one is recorded and ends it, existence follows the fixture table
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      if (ps.alive.has(pid)) return true;
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    killed.push({ pid, signal });
    ps.alive.delete(pid);
    return true;
  }) as typeof process.kill);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const descendantsOf = () => new ChatMcpDescendants({ pid: ROOT } as ChildProcess, "darwin");
const settled = async (work: Promise<unknown>, withinMs: number): Promise<boolean> => {
  let done = false;
  void work.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, withinMs));
  return done;
};

it("a process list that answers after more than a second still confirms the stop (the run is not held until a restart)", async () => {
  ps.listing.delayMs = 1_400;
  const descendants = descendantsOf();
  expect(await descendants.stop()).toBe(true);
  expect(await settled(descendants.goneSignal(), 20)).toBe(true);
  expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("the process list gave no answer"));
}, 15_000);

it("the server is not ended before a slow process list answered, so a descendant that left the group is found and ended", async () => {
  ps.listing.delayMs = 1_400;
  ps.listing.rows.push(`${ESCAPED} ${ROOT} ${START} escaped-daemon`);
  ps.alive.set(ESCAPED, `${ESCAPED} ${ROOT} ${START} escaped-daemon --serve`);
  const descendants = descendantsOf();
  const began = Date.now();
  let serverEndedAfterMs = -1;
  // what ChatMcpConnection and the relay do: stdin ends and the group is signalled only once ready() resolved
  void descendants.ready().then(() => { serverEndedAfterMs = Date.now() - began; });
  expect(await descendants.stop()).toBe(true);
  expect(serverEndedAfterMs).toBeGreaterThanOrEqual(1_350);
  expect(killed).toEqual([{ pid: ESCAPED, signal: "SIGTERM" }]);
}, 15_000);

it("a process list that never answers keeps the run owned: the stop is bounded and reports unconfirmed, never a success", async () => {
  ps.listing.fail = true;
  ps.listing.delayMs = 50;
  const descendants = descendantsOf();
  const began = Date.now();
  expect(await descendants.stop()).toBe(false);
  expect(Date.now() - began).toBeLessThan(8_000);
  // every attempt is a fresh listing started before the server is ended; a failed one is asked again while the bound allows
  expect(fullListings().length).toBeGreaterThan(1);
  expect(await settled(descendants.goneSignal(), 50)).toBe(false);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("the process list gave no answer"));
}, 20_000);

it("a process list still outstanding at the bound keeps the run owned too: the server is ended without it and nothing confirms", async () => {
  ps.listing.delayMs = 60_000;
  const descendants = descendantsOf();
  const began = Date.now();
  expect(await descendants.stop()).toBe(false);
  // fixed bounds, never read from the constant: the base 1 s cap (the 1.0.21 loaded-Mac failure) must fail this floor
  expect(Date.now() - began).toBeGreaterThanOrEqual(5_900);
  expect(Date.now() - began).toBeLessThan(8_000);
  expect(fullListings()).toHaveLength(1);
  expect(await settled(descendants.goneSignal(), 50)).toBe(false);
}, 20_000);

it("eight servers stopped together share one process listing instead of starting eight", async () => {
  ps.listing.delayMs = 200;
  const all = Array.from({ length: 8 }, descendantsOf);
  expect(await Promise.all(all.map((descendants) => descendants.stop()))).toEqual(Array(8).fill(true));
  expect(fullListings()).toHaveLength(1);
});

it("a listing already running is never reused for a later stop: its rows may be older than that stop", async () => {
  ps.listing.delayMs = 200;
  const first = descendantsOf().stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = descendantsOf().stop();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(fullListings()).toHaveLength(2);
});
