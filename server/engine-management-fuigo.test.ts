import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { EngineManager, type ManagedEngineInstance } from "./engine-management.ts";
import { QUALIFIED_FUIGO_VERSION } from "./fuigo-native-update.ts";
import { nativeFixtureAsset } from "./testing/fuigo-native-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeTempDir(root))); });
async function fixture(custom = false, platform: NodeJS.Platform = "darwin", arch = "arm64") {
  const root = await mkdtemp(join(tmpdir(), "murage-fuigo-manager-")); roots.push(root);
  let version = "1.0.9", busy = false;
  const target = arch === "x64" ? `${platform}-x64` : "darwin-arm64";
  const bundledCli = join(root, "bundled-fuigo"); await writeFile(bundledCli, nativeFixtureAsset("1.0.9", target).binary);
  const instance: ManagedEngineInstance = { instanceId: "fuigo", driverKind: "fuigo", ...(custom ? { cli: "/preserved/custom-cli" } : {}), bundledCli, defaultSource: "bundled", snapshot: { state: "available", version: "fuigo 1.0.9" } };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    // Package metadata and tarball answer for the release actually requested.
    const asset = nativeFixtureAsset(/(\d+\.\d+\.\d+)(?:\.tgz)?$/.exec(String(url))?.[1] ?? version, target);
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
  const f = await fixture(); f.setVersion("1.0.8"); expect((await f.manager.check("fuigo")).releaseSupported).toBe(false);
  await expect(f.manager.install("fuigo")).rejects.toThrow(/not supported/); expect(f.probe).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
});
const tarballs = (f: { fetcher: { mock: { calls: unknown[][] } } }) => f.fetcher.mock.calls.map(call => String(call[0])).filter(url => !url.endsWith("/fuigo/latest"));
it.each(["1.0.35", "1.1.0", "2.0.0"])("shows an owner on the qualified Fuigo as up to date when npm latest is %s, and never stages it", async latest => {
  const f = await fixture(); f.instance.snapshot.version = `fuigo ${QUALIFIED_FUIGO_VERSION}`; f.setVersion(latest);
  const status = await f.manager.check("fuigo");
  expect(status).toMatchObject({ updateAvailable: false, releaseSupported: true, latestVersion: QUALIFIED_FUIGO_VERSION, source: "bundled" });
  expect(status.message).not.toMatch(/outside|error|—/);
  await f.manager.install("fuigo");
  expect(tarballs(f).some(url => url.includes(latest))).toBe(false);
  expect(f.probe).not.toHaveBeenCalledWith(expect.anything(), latest, expect.anything());
});
it("offers the qualified release, not a newer latest, to an owner below the cap", async () => {
  const f = await fixture(); f.setVersion("1.0.35");
  expect(await f.manager.check("fuigo")).toMatchObject({ updateAvailable: true, latestVersion: QUALIFIED_FUIGO_VERSION });
  await f.manager.install("fuigo");
  expect(await f.manager.status("fuigo")).toMatchObject({ source: "managed", installedVersion: QUALIFIED_FUIGO_VERSION, updateAvailable: false });
  expect(tarballs(f).every(url => !url.includes("1.0.35"))).toBe(true);
});
it("still updates when npm latest is at or under the cap", async () => {
  const f = await fixture(); f.setVersion("1.0.10");
  expect(await f.manager.check("fuigo")).toMatchObject({ updateAvailable: true, latestVersion: "1.0.10" });
  await f.manager.install("fuigo"); expect(await f.manager.status("fuigo")).toMatchObject({ source: "managed", installedVersion: "1.0.10" });
  f.setVersion(QUALIFIED_FUIGO_VERSION); expect(await f.manager.check("fuigo", { fresh: true })).toMatchObject({ updateAvailable: true, latestVersion: QUALIFIED_FUIGO_VERSION });
  await f.manager.install("fuigo"); expect(await f.manager.status("fuigo")).toMatchObject({ installedVersion: QUALIFIED_FUIGO_VERSION, rollbackAvailable: true });
});
it("leaves an owner already on a newer custom Fuigo on it, even through Use managed Fuigo", async () => {
  const f = await fixture(true); f.instance.snapshot.version = "fuigo 1.0.35"; f.setVersion("1.0.35");
  const status = await f.manager.check("fuigo");
  expect(status).toMatchObject({ updateAvailable: false, source: "custom", message: "You have Fuigo 1.0.35, which is newer than this Murage version offers. It stays as it is." });
  await f.manager.install("fuigo", { allowCustom: true });
  expect((await f.manager.status("fuigo")).busy).toBe(false);
  expect(f.instance.cli).toBe("/preserved/custom-cli"); expect(f.activate).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled(); expect(tarballs(f)).toEqual([]);
});
it("keeps a managed Fuigo newer than the cap recognised, with no downgrade offered", async () => {
  // Real paths, as staging writes them (macOS tmpdir is a /var -> /private/var link).
  const f = await fixture(); await mkdir(join(f.root, "fuigo", "fuigo"), { recursive: true });
  const directory = join(await realpath(join(f.root, "fuigo", "fuigo")), "1.0.35-0d3c1f2e-aaaa-4bbb-8ccc-123456789abc"); await mkdir(directory);
  const cli = join(directory, "fuigo"), binary = nativeFixtureAsset("1.0.35").binary; await writeFile(cli, binary);
  const proof = { version: "1.0.35", protocolVersion: 1, loadSession: true, sessionCreated: true };
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ schema: 1, instanceId: "fuigo", version: "1.0.35", target: "darwin-arm64", package: "@fuigo/darwin-arm64", tarball: "t", integrity: "i", binarySha256: createHash("sha256").update(binary).digest("hex"), proof }));
  f.instance.cli = cli; f.instance.snapshot.version = "fuigo 1.0.35"; f.setVersion("1.0.35");
  expect(await f.manager.check("fuigo")).toMatchObject({ source: "managed", installedVersion: "1.0.35", updateAvailable: false, latestVersion: QUALIFIED_FUIGO_VERSION });
  await f.manager.install("fuigo");
  expect(f.instance.cli).toBe(cli); expect(f.activate).not.toHaveBeenCalled(); expect(tarballs(f)).toEqual([]);
  // A probe that reported no version still never downgrades: the receipt names 1.0.35.
  f.instance.snapshot.version = null; await f.manager.install("fuigo");
  expect(f.instance.cli).toBe(cli); expect(f.activate).not.toHaveBeenCalled(); expect(tarballs(f)).toEqual([]);
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
