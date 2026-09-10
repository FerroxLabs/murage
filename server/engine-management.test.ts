import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager, type ManagedEngineInstance } from "./engine-management.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { driver?: string; platform?: NodeJS.Platform; arch?: string; busy?: () => boolean; probe?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "murage-engine-manager-test-")); roots.push(root);
  const instance: ManagedEngineInstance = { instanceId: "fixture", driverKind: options.driver ?? "codex", cli: "/preserved/old-cli", snapshot: { state: "available", version: "codex-cli 1.0.0" } };
  const activate = vi.fn(async (_id: string, cli: string) => { instance.cli = cli; instance.snapshot.version = "1.2.0"; });
  const run = vi.fn(async (_command: string, args: string[], cwd: string) => {
    if(args[0]==="--version")return options.probe??"codex-cli 1.2.0";
    if(options.platform==="win32") {
      const key="node_modules/@openai/codex-win32-x64",packageRoot=join(cwd,key);
      const native=join(packageRoot,"vendor","x86_64-pc-windows-msvc","bin");
      await mkdir(native,{recursive:true});
      await writeFile(join(cwd,"package-lock.json"),JSON.stringify({packages:{[key]:{version:"1.2.0-win32-x64",resolved:"https://registry.npmjs.org/@openai/codex/-/codex-1.2.0-win32-x64.tgz",integrity:"sha512-"+Buffer.alloc(64).toString("base64")}}}));
      await writeFile(join(packageRoot,"package.json"),JSON.stringify({name:"@openai/codex",version:"1.2.0-win32-x64",os:["win32"],cpu:["x64"]}));
      const pe=Buffer.alloc(128);pe.write("MZ");pe.writeUInt32LE(64,60);pe.write("PE\0\0",64);pe.writeUInt16LE(0x8664,68);await writeFile(join(native,"codex.exe"),pe);
    }
    return "installed";
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ name: options.driver === "fuigo" ? "fuigo" : "@openai/codex", version: "1.2.0" })));
  const manager = new EngineManager({ root, getInstance: async id => id === "fixture" ? instance : undefined, isBusy: options.busy ?? (() => false), activate, platform: options.platform ?? "darwin", arch:options.arch??"x64", run, fetch: fetch as typeof globalThis.fetch });
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

it("activates the verified Windows x64 native executable from the owned npm prefix",async()=>{
  const f=await fixture({platform:"win32"});expect((await f.manager.status("fixture")).supported).toBe(true);
  await f.manager.install("fixture");
  expect(f.run.mock.calls[0]![1]).toContain("--include=optional");
  expect(f.run.mock.calls[0]![1]).toContain("--ignore-scripts");
  expect(f.run.mock.calls[0]![1]).not.toContain("-g");
  expect(f.instance.cli).toBe(f.run.mock.calls[1]![0]);
  expect(f.instance.cli).toMatch(/vendor[/\\]x86_64-pc-windows-msvc[/\\]bin[/\\]codex\.exe$/);
  expect(f.activate).toHaveBeenCalledOnce();
});

it("retains the working Windows CLI after a native version mismatch",async()=>{
  const f=await fixture({platform:"win32",probe:"codex-cli 0.0.1"});
  await expect(f.manager.install("fixture")).rejects.toThrow("previous engine is unchanged");
  expect(f.activate).not.toHaveBeenCalled();expect(f.instance.cli).toBe("/preserved/old-cli");
});
