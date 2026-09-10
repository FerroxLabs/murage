import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { EngineManager, type ManagedEngineInstance } from "./engine-management.ts";
import { nativeFixtureAsset } from "./testing/fuigo-native-fixture.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(custom = false, platform: NodeJS.Platform = "darwin", arch = "arm64") {
  const root = await mkdtemp(join(tmpdir(), "murage-fuigo-manager-")); roots.push(root);
  let version = "1.0.9", busy = false;
  const target = arch === "x64" ? `${platform}-x64` : "darwin-arm64";
  const bundledCli = join(root, "bundled-fuigo"); await writeFile(bundledCli, nativeFixtureAsset("1.0.9", target).binary);
  const instance: ManagedEngineInstance = { instanceId: "fuigo", driverKind: "fuigo", ...(custom ? { cli: "/preserved/custom-cli" } : {}), bundledCli, defaultSource: "bundled", snapshot: { state: "available", version: "fuigo 1.0.9" } };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const asset = nativeFixtureAsset(version, target);
    return String(url).endsWith("/fuigo/latest") ? Response.json({ name: "fuigo", version }) : String(url).endsWith(".tgz") ? new Response(new Uint8Array(asset.archive)) : Response.json(asset.metadata);
  });
  const run = vi.fn(async () => { throw new Error("npm/Node must never run for Fuigo"); });
  const probe = vi.fn(async (_cli: string, wanted: string | undefined) => ({ version: wanted ?? "1.0.9", protocolVersion: 1 as const, loadSession: true as const, sessionCreated: true as const }));
  const activate = vi.fn(async (_id: string, cli: string, expectedCli?: string | null) => { if (expectedCli !== undefined && (instance.cli ?? null) !== expectedCli) throw new Error("selection changed"); instance.cli = cli; instance.snapshot.version = cli === bundledCli ? "1.0.9" : basename(dirname(cli)).split("-")[0]!; });
  const manager = new EngineManager({ root, getInstance: async id => id === "fuigo" ? instance : undefined, isBusy: () => busy, activate, platform, arch, fetch: fetcher as typeof fetch, run, fuigoProbe: probe });
  return { root, instance, manager, fetcher, run, probe, activate, setVersion: (next: string) => { version = next; }, setBusy: (next: boolean) => { busy = next; } };
}
it("activates an independent native update, keeps old versions and explicitly rolls back/use-bundled", async () => {
  const f = await fixture(); await f.manager.install("fuigo"); const first = f.instance.cli!;
  expect((await f.manager.status("fuigo")).source).toBe("managed"); expect(f.run).not.toHaveBeenCalled();
  f.setVersion("1.0.10"); await f.manager.install("fuigo"); const second = f.instance.cli!;
  expect(second).not.toBe(first); expect((await f.manager.status("fuigo")).rollbackAvailable).toBe(true);
  await f.manager.rollback("fuigo"); expect(f.instance.cli).toBe(first);
  await f.manager.useBundled("fuigo"); expect(f.instance.cli).toBe(f.instance.bundledCli);
  expect((await f.manager.status("fuigo")).source).toBe("bundled");
  expect(await readFile(first)).toEqual(nativeFixtureAsset().binary); expect(await readFile(second)).toEqual(nativeFixtureAsset().binary);
});
it("requires deliberate opt-in before replacing a custom CLI", async () => {
  const f = await fixture(true); await expect(f.manager.install("fuigo")).rejects.toThrow(/explicitly/);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/preserved/custom-cli");
  await f.manager.install("fuigo", { allowCustom: true }); expect((await f.manager.status("fuigo")).source).toBe("managed");
});
it("declines latest releases outside Murage's compatibility range", async () => {
  const f = await fixture(); f.setVersion("2.0.0"); expect((await f.manager.check("fuigo")).releaseSupported).toBe(false);
  await expect(f.manager.install("fuigo")).rejects.toThrow(/not supported/); expect(f.probe).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
});
it("checks both the initial busy state and the post-probe activation race", async () => {
  const f = await fixture(); f.setBusy(true); await expect(f.manager.install("fuigo")).rejects.toThrow(/running tasks/); expect(f.fetcher).not.toHaveBeenCalled();
  f.setBusy(false); f.probe.mockImplementation(async (_cli, version) => { f.setBusy(true); return { version: version!, protocolVersion: 1, loadSession: true, sessionCreated: true }; });
  await expect(f.manager.install("fuigo")).rejects.toThrow(/Tasks started/); expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBeUndefined();
});
it("retains a candidate after uncertain activation and never claims the prior engine was restored", async () => {
  const f = await fixture(); f.activate.mockImplementation(async (_id, cli) => { f.instance.cli = cli; throw new Error("rollback failed"); });
  await expect(f.manager.install("fuigo")).rejects.toThrow(/activation did not complete/);
  expect(await readFile(f.instance.cli!)).toEqual(nativeFixtureAsset().binary); expect((await f.manager.status("fuigo")).busy).toBe(false);
});
it("refuses corrupt rollback bytes without changing the active version", async () => {
  const f = await fixture(); await f.manager.install("fuigo"); const first = f.instance.cli!;
  f.setVersion("1.0.10"); await f.manager.install("fuigo"); const current = f.instance.cli;
  await writeFile(first, "corrupt"); await expect(f.manager.rollback("fuigo")).rejects.toThrow(/changed/); expect(f.instance.cli).toBe(current);
});
it("refuses a selection changed during verification before activation", async () => {
  const f = await fixture();
  f.probe.mockImplementation(async (_cli, version) => { f.instance.cli = "/new-user-selection"; return { version: version!, protocolVersion: 1, loadSession: true, sessionCreated: true }; });
  await expect(f.manager.install("fuigo")).rejects.toThrow(/selected Fuigo engine changed/);
  expect(f.activate).not.toHaveBeenCalled(); expect(f.instance.cli).toBe("/new-user-selection");
});
it("passes the exact pre-probe selection to the atomic activation callback", async () => {
  const f = await fixture(true);
  await f.manager.install("fuigo", { allowCustom: true });
  expect(f.activate).toHaveBeenLastCalledWith("fuigo", f.instance.cli, "/preserved/custom-cli");
  const selected = f.instance.cli;
  await f.manager.useBundled("fuigo");
  expect(f.activate).toHaveBeenLastCalledWith("fuigo", f.instance.bundledCli, selected);
});
it.each(["linux", "win32"] as const)("keeps %s arm64 unqualified and refuses all selection actions", async platform => {
  const f = await fixture(false, platform);
  expect(await f.manager.status("fuigo")).toMatchObject({ supported: false, message: expect.stringContaining("not qualified") });
  await expect(f.manager.install("fuigo")).rejects.toThrow(/not supported/);
  await expect(f.manager.rollback("fuigo")).rejects.toThrow(/not qualified/);
  await expect(f.manager.useBundled("fuigo")).rejects.toThrow(/not qualified/);
  expect(f.probe).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["linux", "win32"] as const)("admits %s x64 through the complete managed selection path", async platform => {
  // Target-header/probe doubles cover manager routing only; native protocol
  // and isolation qualification remain separate real-platform gates.
  const f = await fixture(false, platform, "x64");
  expect(await f.manager.status("fuigo")).toMatchObject({ supported: true, source: "bundled" });
  await f.manager.install("fuigo"); const first = f.instance.cli!;
  expect(await f.manager.status("fuigo")).toMatchObject({ source: "managed", installedVersion: "1.0.9" });
  f.setVersion("1.0.10"); await f.manager.install("fuigo");
  expect(f.instance.cli).not.toBe(first);
  expect(await f.manager.status("fuigo")).toMatchObject({ rollbackAvailable: true, installedVersion: "1.0.10" });
  await f.manager.rollback("fuigo"); expect(f.instance.cli).toBe(first);
  await f.manager.useBundled("fuigo"); expect(f.instance.cli).toBe(f.instance.bundledCli);
  expect(await f.manager.status("fuigo")).toMatchObject({ supported: true, source: "bundled" });
  expect(f.probe).toHaveBeenCalledTimes(4); expect(f.activate).toHaveBeenCalledTimes(4); expect(f.run).not.toHaveBeenCalled();
});
