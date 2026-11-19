// FUIGOREPOINT-1020: a Fuigo path a managed install saved (fuigo/<id>/<version>-<uuid>/fuigo) follows the managed current
// version. An owner whose managed install from an older Murage saved 1.0.22 kept running 1.0.22 after Murage shipped a newer
// Fuigo, and every Fuigo turn said Murage did not confirm the approval settings (fuigo-policy needs 1.0.36+).
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BUNDLED_FUIGO_VERSION, EngineManager, FUIGO_CLI_BACKUP_KEY, FUIGO_ROLLBACK_HOLD_KEY, followManagedFuigoInstances, managedFuigoFollow, type ManagedEngineInstance } from "./engine-management.ts";
import { QUALIFIED_FUIGO_VERSION } from "./fuigo-native-update.ts";
import { nativeFixtureAsset } from "./testing/fuigo-native-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const OLD = "1.0.22", TARGET = "darwin-arm64";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeTempDir(root))); });

/** Real managed installs through EngineManager.install (staged, receipt written), with a bundled Fuigo beside them. */
async function fixture(options: { bundled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "murage-fuigo-follow-")); roots.push(root);
  let version = OLD;
  const bundledCli = join(root, "bundled-fuigo");
  if (options.bundled !== false) await writeFile(bundledCli, nativeFixtureAsset(BUNDLED_FUIGO_VERSION, TARGET).binary);
  const instance: ManagedEngineInstance = { instanceId: "fuigo", driverKind: "fuigo", ...(options.bundled !== false ? { bundledCli } : {}), defaultSource: "bundled", snapshot: { state: "available", version: `fuigo ${OLD}` } };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const asset = nativeFixtureAsset(/(\d+\.\d+\.\d+)(?:\.tgz)?$/.exec(String(url))?.[1] ?? version, TARGET);
    return String(url).endsWith("/fuigo/latest") ? Response.json({ name: "fuigo", version }) : String(url).endsWith(".tgz") ? new Response(new Uint8Array(asset.archive)) : Response.json(asset.metadata);
  });
  const probe = vi.fn(async (_cli: string, wanted: string | undefined) => ({ version: wanted ?? BUNDLED_FUIGO_VERSION, protocolVersion: 1 as const, loadSession: true as const, sessionCreated: true as const }));
  const holds: (boolean | undefined)[] = [];
  const activate = vi.fn(async (_id: string, cli: string, _expected?: string | null, hold?: boolean) => {
    holds.push(hold); instance.cli = cli; instance.snapshot.version = `fuigo ${cli === bundledCli ? BUNDLED_FUIGO_VERSION : basename(dirname(cli)).split("-")[0]}`;
  });
  const manager = new EngineManager({ root, getInstance: async id => id === "fuigo" ? instance : undefined, isBusy: () => false, activate, platform: "darwin", arch: "arm64", fetch: fetcher as typeof fetch, fuigoProbe: probe });
  const installAt = async (next: string) => { version = next; await manager.install("fuigo"); return instance.cli!; };
  const start = (cli: string, extra: Record<string, unknown> = {}) => followManagedFuigoInstances({ fuigo: { driver: "fuigoAgent", config: { cli, fullAuto: false, ...extra } } }, root, { bundledCli: options.bundled !== false ? bundledCli : undefined, target: TARGET });
  return { root, instance, manager, bundledCli, installAt, start, holds };
}

it("the bundled Fuigo is the qualified cap", () => { expect(BUNDLED_FUIGO_VERSION).toBe(QUALIFIED_FUIGO_VERSION); });

it("moves an old managed versioned path to the newest managed install on disk at start, keeping the old path once", async () => {
  const f = await fixture();
  const old = await f.installAt(OLD), current = await f.installAt(QUALIFIED_FUIGO_VERSION);
  expect(basename(dirname(old))).toMatch(/^1\.0\.22-/); expect(current).not.toBe(old);
  const followed = await f.start(old);
  expect(followed).toEqual({ fuigo: { driver: "fuigoAgent", config: { cli: current, fullAuto: false, [FUIGO_CLI_BACKUP_KEY]: old } } });
});

it("moves an old managed path to the bundled Fuigo when no newer managed install is on disk", async () => {
  const f = await fixture();
  const old = await f.installAt(OLD);
  expect((await f.start(old))?.fuigo?.config).toEqual({ cli: f.bundledCli, fullAuto: false, [FUIGO_CLI_BACKUP_KEY]: old });
});

it("migrates once: a second start changes nothing and the first backup is never overwritten", async () => {
  const f = await fixture();
  const old = await f.installAt(OLD);
  const first = (await f.start(old))!.fuigo!.config as Record<string, unknown>;
  expect(await f.start(first.cli as string, { [FUIGO_CLI_BACKUP_KEY]: old })).toBeNull();
  // A later follow from a path that already has a backup keeps the original backup.
  const later = await f.installAt(QUALIFIED_FUIGO_VERSION);
  const again = await followManagedFuigoInstances({ fuigo: { driver: "fuigoAgent", config: { cli: old, [FUIGO_CLI_BACKUP_KEY]: "/first/saved" } } }, f.root, { bundledCli: f.bundledCli, target: TARGET });
  expect(again?.fuigo?.config).toEqual({ cli: later, [FUIGO_CLI_BACKUP_KEY]: "/first/saved" });
});

it("leaves a path outside the managed store as the owner chose it, and Settings says plainly it is older than built-in", async () => {
  const f = await fixture();
  await f.installAt(QUALIFIED_FUIGO_VERSION);
  const outside = join(f.root, "elsewhere", "fuigo");
  expect(await f.start(outside)).toBeNull();
  expect(await managedFuigoFollow(f.root, "fuigo", "fuigo", { bundledCli: f.bundledCli, target: TARGET })).toBeNull();
  f.instance.cli = outside; f.instance.snapshot.version = `fuigo ${OLD}`;
  const status = await f.manager.status("fuigo");
  expect(status).toMatchObject({ source: "custom", olderThanBundled: true, bundledVersion: BUNDLED_FUIGO_VERSION, bundledAvailable: true });
  expect(status.message).toBe(`This Fuigo is version ${OLD}, older than the built-in Fuigo ${BUNDLED_FUIGO_VERSION}. With it, Murage can't confirm your approval settings.`);
  // The same outside Fuigo at the built-in version: no notice.
  f.instance.snapshot.version = `fuigo ${BUNDLED_FUIGO_VERSION}`;
  expect((await f.manager.status("fuigo")).olderThanBundled).toBe(false);
});

it("keeps a managed version the owner went back to, and frees it on the next update", async () => {
  const f = await fixture();
  const old = await f.installAt(OLD); await f.installAt(QUALIFIED_FUIGO_VERSION);
  await f.manager.rollback("fuigo");
  expect(f.instance.cli).toBe(old); expect(f.holds.at(-1)).toBe(true);
  expect(await f.start(old, { [FUIGO_ROLLBACK_HOLD_KEY]: old })).toBeNull();
  await f.manager.useBundled("fuigo"); expect(f.holds.at(-1)).toBeUndefined();
});

it("never follows to a managed install whose executable changed after it was verified", async () => {
  const f = await fixture({ bundled: false });
  const old = await f.installAt(OLD), current = await f.installAt(QUALIFIED_FUIGO_VERSION);
  const tampered = Buffer.from(await readFile(current)); tampered[100] = tampered[100]! ^ 0xff; await writeFile(current, tampered);
  // The newest is refused; the old one is the newest verified, so nothing moves and nothing is invented.
  expect(await f.start(old)).toBeNull();
});

it("start-up runs the follow before any engine is created", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const follow = source.indexOf("await followManagedFuigoInstances("), registry = source.indexOf("const registry = new ProviderRegistry(");
  expect(follow).toBeGreaterThan(0); expect(follow).toBeLessThan(registry);
  expect(source).toContain("[FUIGO_ROLLBACK_HOLD_KEY]: cli");
});
