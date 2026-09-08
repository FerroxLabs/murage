import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager, type ManagedEngineInstance } from "./engine-management.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { driver?: string; platform?: NodeJS.Platform; busy?: () => boolean; probe?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "murage-engine-manager-test-")); roots.push(root);
  const instance: ManagedEngineInstance = { instanceId: "fixture", driverKind: options.driver ?? "codex", cli: "/preserved/old-cli", snapshot: { state: "available", version: "codex-cli 1.0.0" } };
  const activate = vi.fn(async (_id: string, cli: string) => { instance.cli = cli; instance.snapshot.version = "1.2.0"; });
  const run = vi.fn(async (_command: string, args: string[]) => args[0] === "--version" ? options.probe ?? "codex-cli 1.2.0" : "installed");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ version: "1.2.0" })));
  const manager = new EngineManager({ root, getInstance: async id => id === "fixture" ? instance : undefined, isBusy: options.busy ?? (() => false), activate, platform: options.platform ?? "darwin", run, fetch: fetch as typeof globalThis.fetch });
  return { manager, run, activate, fetch, instance, root };
}
describe("managed engine install and update", () => {
  it("checks metadata without running commands or changing the current CLI", async () => {
    const f = await fixture(); expect((await f.manager.check("fixture")).updateAvailable).toBe(true);
    expect(f.run).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/preserved/old-cli");
  });
  it("uses a fixed package and isolated prefix, then verifies before activation", async () => {
    const f = await fixture(); await f.manager.install("fixture");
    expect(f.run.mock.calls[0]![0]).toBe("npm"); expect(f.run.mock.calls[0]![1]).toContain("@openai/codex@1.2.0");
    expect(f.run.mock.calls[0]![1]).toContain("--ignore-scripts"); expect(f.run.mock.calls[0]![1]).not.toContain("-g");
    expect(f.run.mock.calls[1]![1]).toEqual(["--version"]); expect(f.activate).toHaveBeenCalledOnce(); expect(f.instance.cli).toContain(f.root);
  });
  it("retains the working CLI on verification failure and permits retry", async () => {
    const f = await fixture({ probe: "wrong 0.0.1" }); await expect(f.manager.install("fixture")).rejects.toThrow("previous engine is unchanged");
    expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/preserved/old-cli"); expect((await f.manager.status("fixture")).busy).toBe(false);
  });
  it("refuses active tasks before downloading", async () => {
    const f = await fixture({ busy: () => true }); await expect(f.manager.install("fixture")).rejects.toThrow("running tasks"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rechecks active tasks before switching", async () => {
    let calls = 0; const f = await fixture({ busy: () => ++calls > 1 }); await expect(f.manager.install("fixture")).rejects.toThrow("unchanged"); expect(f.activate).not.toHaveBeenCalled();
  });
  it("does not accept an arbitrary engine ID or unsupported platform", async () => {
    const f = await fixture({ platform: "win32" }); await expect(f.manager.install("fixture")).rejects.toThrow("not supported"); await expect(f.manager.install(";bad")).rejects.toThrow("not found"); expect(f.run).not.toHaveBeenCalled();
  });
  it("routes bundled Fuigo updates through Murage without running npm", async () => {
    const f = await fixture({ driver: "fuigo" }); const status = await f.manager.check("fixture"); expect(status.updateAvailable).toBe(true); expect(status.supported).toBe(false); expect(status.message).toContain("Update Murage"); expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects malformed registry versions before install", async () => {
    const f = await fixture(); f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ version: "1.0.0; bad" })));
    await expect(f.manager.install("fixture")).rejects.toThrow("unsupported version"); expect(f.run).not.toHaveBeenCalled();
  });
});
