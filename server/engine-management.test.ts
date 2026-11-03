import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager, LATEST_VERSION_TTL_MS, type ManagedEngineInstance } from "./engine-management.js";
import { removeTempDir } from "./testing/cleanup.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeTempDir(root))); });
async function fixture(options: { driver?: string; platform?: NodeJS.Platform; arch?: string; busy?: () => boolean; probe?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "murage-engine-manager-test-")); roots.push(root);
  const instance: ManagedEngineInstance = { instanceId: "fixture", driverKind: options.driver ?? "codex", cli: "/preserved/old-cli", snapshot: { state: "available", version: "codex-cli 1.0.0" } };
  const activate = vi.fn(async (_id: string, cli: string) => { instance.cli = cli; instance.snapshot.version = "1.2.0"; });
  const run = vi.fn(async (_command: string, args: string[], _cwd: string) => args[0] === "--version" ? options.probe ?? "codex-cli 1.2.0" : "installed");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ name: options.driver === "fuigo" ? "fuigo" : "@openai/codex", version: "1.2.0" })));
  const manager = new EngineManager({ root, getInstance: async id => id === "fixture" ? instance : undefined, isBusy: options.busy ?? (() => false), activate, platform: options.platform ?? "darwin", arch:options.arch??"x64", run, fetch: fetch as typeof globalThis.fetch });
  return { manager, run, activate, fetch, instance, root };
}
describe("managed engine install and update", () => {
  it("checks metadata without running commands or changing the current CLI", async () => {
    const f = await fixture(); expect((await f.manager.check("fixture")).updateAvailable).toBe(true);
    expect(f.run).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/preserved/old-cli");
  });
  it("stops at a release it cannot verify: no command runs and the current CLI stays", async () => {
    const f = await fixture({ probe: "wrong 0.0.1" }); await expect(f.manager.install("fixture")).rejects.toThrow("previous engine is unchanged");
    expect(f.run).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/preserved/old-cli"); expect((await f.manager.status("fixture")).busy).toBe(false);
  });
  it("refuses active tasks before downloading", async () => {
    const f = await fixture({ busy: () => true }); await expect(f.manager.install("fixture")).rejects.toThrow("running tasks"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not accept an arbitrary engine ID or unsupported platform", async () => {
    const f = await fixture({ platform: "win32",arch:"arm64" }); await expect(f.manager.install("fixture")).rejects.toThrow("not supported"); await expect(f.manager.install(";bad")).rejects.toThrow("not found"); expect(f.run).not.toHaveBeenCalled();
  });
  it("checks independent native Fuigo updates without running npm or replacing a custom CLI", async () => {
    const f = await fixture({ driver: "fuigo" }); const status = await f.manager.check("fixture"); expect(status.updateAvailable).toBe(true); expect(status.supported).toBe(true); expect(status.source).toBe("custom"); expect(status.message).toContain("Use managed Fuigo"); expect(f.run).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
  });
  it("rejects malformed registry versions before install", async () => {
    const f = await fixture(); f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.0.0; bad" })));
    await expect(f.manager.install("fixture")).rejects.toThrow("unsupported version"); expect(f.run).not.toHaveBeenCalled();
  });
});

describe("Settings › Engines serves the last known release", () => {
  it("answers a second visit without a network call, and refreshes after the TTL in the background", async () => {
    const f = await fixture();
    let clock = 1_000_000;
    const manager = new EngineManager({ root: f.root, getInstance: async id => id === "fixture" ? f.instance : undefined, isBusy: () => false, activate: f.activate, platform: "darwin", arch: "x64", run: f.run, fetch: f.fetch as typeof globalThis.fetch, now: () => clock });
    expect((await manager.check("fixture")).latestVersion).toBe("1.2.0");
    expect(f.fetch).toHaveBeenCalledOnce();
    const started = performance.now();
    const second = await manager.check("fixture");
    expect(performance.now() - started).toBeLessThan(50);
    expect(second.latestVersion).toBe("1.2.0");
    expect(f.fetch).toHaveBeenCalledOnce();
    // past the TTL: the known answer comes back at once, and one lookup runs behind it
    clock += LATEST_VERSION_TTL_MS;
    let release!: (response: Response) => void;
    f.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    expect((await manager.check("fixture")).latestVersion).toBe("1.2.0");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect((await manager.check("fixture")).latestVersion).toBe("1.2.0");
    expect(f.fetch).toHaveBeenCalledTimes(2); // joined, not repeated
    release(new Response(JSON.stringify({ version: "1.3.0" })));
    await new Promise(resolve => setImmediate(resolve));
    expect((await manager.check("fixture")).latestVersion).toBe("1.3.0");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps the last known release when a background refresh fails", async () => {
    const f = await fixture();
    let clock = 0;
    const manager = new EngineManager({ root: f.root, getInstance: async () => f.instance, isBusy: () => false, activate: f.activate, platform: "darwin", arch: "x64", run: f.run, fetch: f.fetch as typeof globalThis.fetch, now: () => clock });
    await manager.check("fixture");
    clock += LATEST_VERSION_TTL_MS;
    f.fetch.mockRejectedValueOnce(new Error("offline"));
    expect((await manager.check("fixture")).latestVersion).toBe("1.2.0");
    await new Promise(resolve => setImmediate(resolve));
    expect((await manager.check("fixture")).latestVersion).toBe("1.2.0");
  });
  it("an install always looks the release up again", async () => {
    const f = await fixture();
    await f.manager.check("fixture");
    await f.manager.install("fixture").catch(() => {});
    expect(f.fetch.mock.calls.filter(call => String((call as unknown[])[0]).includes("registry.npmjs.org"))).toHaveLength(2);
  });
});
