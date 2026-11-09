import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), tree: vi.fn(), force: vi.fn(), root: vi.fn(), job: vi.fn() }));
vi.mock("./procs.ts", () => ({ spawnCli: mocks.spawn, engineJob: mocks.job, awaitCliTreeStopped: mocks.tree, forceCliTreeStopped: mocks.force, awaitCliRootClose: mocks.root }));
import { probeOpenCodeDestination } from "./opencode-destination.ts";
import { ProviderStopUnconfirmedError } from "./drivers/child-teardown.ts";
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
beforeEach(() => {
  vi.clearAllMocks(); child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  mocks.spawn.mockReturnValue(child); mocks.tree.mockResolvedValue(true); mocks.root.mockResolvedValue(true); mocks.force.mockResolvedValue(true);
});
function start(signal = new AbortController().signal) { return probeOpenCodeDestination({ cli: "/fixture/pinned", cwd: "/fixture", env: { HOME: "/fixture" }, signal, memoryOff: true }); }
it("uses the pinned executable and a fresh owned job with the final env", async () => {
  const job = {}; mocks.job.mockReturnValue(job); const pending = start();
  child.stdout.write('{"provider":{}}'); child.emit("close", 0);
  await expect(pending).resolves.toEqual({ provider: {} });
  expect(mocks.spawn).toHaveBeenCalledWith("/fixture/pinned", ["debug", "config"], { cwd: "/fixture", env: { HOME: "/fixture" }, stdio: ["pipe", "pipe", "pipe"] }, job);
  expect(mocks.job).toHaveBeenCalledWith({ posixHostPower: true });
});
it.each(["rc", "json", "size", "spawn"])("refuses %s without exposing output", async failure => {
  const pending = start(); const rejected = expect(pending).rejects.toThrow();
  if (failure === "spawn") child.emit("error", new Error("private"));
  else if (failure === "size") child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
  else { child.stdout.write(failure === "json" ? "private" : "{}"); child.emit("close", failure === "rc" ? 1 : 0); }
  await rejected;
});
it("a false root-close result is an unconfirmed stop", async () => {
  mocks.tree.mockResolvedValue(false); mocks.root.mockResolvedValue(false);
  const controller = new AbortController(), pending = start(controller.signal);
  const rejected = expect(pending).rejects.toBeInstanceOf(ProviderStopUnconfirmedError);
  controller.abort(); await rejected;
  expect(mocks.force).toHaveBeenCalledWith(child); expect(mocks.root).toHaveBeenCalledWith(child);
});
it("waits for root close after the owned tree stops", async () => {
  let release!: (confirmed: boolean) => void;
  mocks.root.mockImplementation(() => new Promise<boolean>(r => { release = r; }));
  const controller = new AbortController(); let finished = false;
  const pending = start(controller.signal).catch(() => { finished = true; });
  controller.abort(); await vi.waitFor(() => expect(mocks.root).toHaveBeenCalled());
  expect(finished).toBe(false); release(true); await pending; expect(finished).toBe(true);
});
it("times out and confirms the stop", async () => {
  vi.useFakeTimers();
  try { const pending = start(); const rejected = expect(pending).rejects.toThrow("stopped"); await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(mocks.root).toHaveBeenCalled(); }
  finally { vi.useRealTimers(); }
});
