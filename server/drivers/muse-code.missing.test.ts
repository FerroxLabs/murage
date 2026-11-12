import { chmodSync, copyFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn as nativeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import * as envPath from "../env-path.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as procs from "../procs.ts";
import { hostPowerDeps, hostPowerProbeDeps, HOST_POWER_TEST_UNWRAPPED } from "../host-power.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MuseCodeDriver, MUSE_NOT_INSTALLED_NOTE } from "./muse-code.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";

vi.mock("node:child_process", { spy: true });

const dirs: string[] = [];
const instances: ProviderInstance[] = [];
const deps = { ...hostPowerDeps };
const probes = { ...hostPowerProbeDeps };
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "muse-missing-")); dirs.push(dir); return dir; };
const fake = fileURLToPath(new URL("../testing/fake-muse-cli.ts", import.meta.url));
const make = async (cli: string) => {
  const instance = await MuseCodeDriver.create({ instanceId: cli, displayName: "Muse", enabled: true,
    config: MuseCodeDriver.decodeConfig({ cli }), environment: { META_API_KEY: "fake-fixture-key" } });
  instances.push(instance); return instance;
};
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  Object.assign(hostPowerDeps, deps);
  Object.assign(hostPowerProbeDeps, probes);
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  envPath.restrictInstallScanDirsForTests(null);
  envPath.resetPathCacheForTests();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("missing Muse admission (isolated, no inference)", () => {
  it("one hour: concurrent status, catalog and session requests never spawn or warn while not installed", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawn = vi.spyOn(procs, "spawnCli");
    const checks = vi.spyOn(procs.engineExecutableDeps, "executable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = await make(join(scratch(), "absent-muse"));
    const events: RuntimeEvent[] = []; instance.adapter.onEvent(event => events.push(event));
    for (let tick = 0; tick <= 120; tick++) {
      const [snapshot] = await Promise.all([
        instance.snapshot(), instance.refreshModels!({ manual: false }),
        expect(instance.adapter.sendTurn({ threadId: `missing-${tick}`, text: "FAKE-ONLY", stopLine: true, cwd: fixtureBotFolder() })).rejects.toThrow(MUSE_NOT_INSTALLED_NOTE),
      ]);
      expect(snapshot).toMatchObject({ state: "unavailable", reason: MUSE_NOT_INSTALLED_NOTE });
      await new Promise<void>(done => setImmediate(done));
      expect(spawn).toHaveBeenCalledTimes(0);
      now += 30_000;
    }
    expect(checks).toHaveBeenCalledTimes(7); // at boot and once per ten minutes, through one hour
    expect(warn).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "item.completed" || event.type === "runtime.error")).toBe(false);
  });

  it("BLOCK 2: background registry routes share missing presence for one hour, then discover installation", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const root = scratch(), cli = `fixture-muse-${basename(root)}.ts`;
    vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH}`);
    envPath.restrictInstallScanDirsForTests([]);
    const driver = { ...MuseCodeDriver, defaultConfig: () => MuseCodeDriver.decodeConfig({ cli }) };
    const registry = new ProviderRegistry([driver], () => now);
    const spawn = vi.spyOn(procs, "spawnCli");
    const checks = vi.spyOn(procs.engineExecutableDeps, "executable");
    const discovery = vi.spyOn(envPath, "findCliCandidates");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registry.load({ muse: { driver: "museCode", environment: { META_API_KEY: "fake-fixture-key" } } });
      const checksPerScan = checks.mock.calls.length;
      expect(checksPerScan).toBeGreaterThan(0);
      for (let tick = 0; tick <= 120; tick++) {
        const [rows] = await Promise.all([
          registry.describe({ catalogs: "due" }), registry.describe({ catalogs: "due" }),
          registry.refreshModelCatalogs(), registry.describeOne("muse"),
        ]);
        expect(rows[0]).toMatchObject({ snapshot: { state: "unavailable", reason: MUSE_NOT_INSTALLED_NOTE }, cliCandidates: [] });
        now += 30_000;
      }
      // Missing discovery must use the driver's shared negative result, never scan PATH again.
      expect(discovery).not.toHaveBeenCalled();
      expect(checks).toHaveBeenCalledTimes(7 * checksPerScan);
      expect(spawn).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      symlinkSync(fake, join(root, cli)); chmodSync(fake, 0o755);
      now += 600_000;
      const [installed] = await registry.describe({ catalogs: "due" });
      expect(installed.snapshot.state).toBe("available");
      expect(installed.cliCandidates).toContain(join(root, cli));
      expect(registry.get("muse")!.models.source).toBe("live");
    } finally { await registry.disposeAll(); }
  });

  it.each([false, true, null])("discovers installation in one re-check (explicit=%s), with no restart", async manual => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const cli = join(scratch(), "muse.ts");
    const spawn = vi.spyOn(procs, "spawnCli");
    const instance = await make(cli);
    expect(await instance.snapshot()).toMatchObject({ reason: MUSE_NOT_INSTALLED_NOTE });
    expect(spawn).not.toHaveBeenCalled();
    copyFileSync(fake, cli); chmodSync(cli, 0o755);
    await instance.refreshModels!({ manual: false });
    expect(spawn).not.toHaveBeenCalled();
    if (!manual) now += 600_000;
    if (manual === null) await instance.snapshot();
    else await instance.refreshModels!({ manual });
    expect(instance.models.source).toBe("live");
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    expect(spawn).toHaveBeenCalled();
  });

  it("E2 No limits recovers a Muse turn after the background power block failed", async () => {
    const root = scratch(), wrapper = join(root, "sandbox"), cli = join(root, "muse");
    symlinkSync(fake, cli); chmodSync(fake, 0o755);
    writeFileSync(wrapper, '#!/bin/sh\necho "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 71\n');
    chmodSync(wrapper, 0o755);
    Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = await make(cli);
    await instance.refreshModels!();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent(event => events.push(event));
    const sent = await instance.adapter.sendTurn({ threadId: "recovered", text: "FAKE-ONLY", cwd: fixtureBotFolder(), stopLine: true, noLimits: true });
    await vi.waitFor(() => expect(events.find(event => event.type === "turn.completed" && event.turnId === sent.turnId)).toMatchObject({ ok: true }), { timeout: 15000 });
    expect(events.some(event => event.type === "item.completed")).toBe(true);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("No limits session"))).toHaveLength(1);
  }, 30000);

  it.each(["catalog", "session"])("N6 No limits retries Muse %s unwrapped when the real wrapper refuses after a passing probe", async stage => {
    const root = scratch(), wrapper = join(root, "sandbox"), cli = join(root, "muse");
    symlinkSync(fake, cli); chmodSync(fake, 0o755);
    const acceptCatalog = stage === "session" ? 'if [ "$4" = serve ] && [ "$5" = --disable-shell ]; then shift 2; exec "$@"; fi\n' : "";
    writeFileSync(wrapper, `#!/bin/sh\n${acceptCatalog}echo "sandbox-exec: sandbox_apply: Operation not permitted" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
    Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
    hostPowerProbeDeps.runSync = () => ({ code: 0, stderr: "" });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = await make(cli);
    const events: RuntimeEvent[] = []; instance.adapter.onEvent(event => events.push(event));
    for (const threadId of ["actual-wrapper-first", "actual-wrapper-next"]) {
      const sent = await instance.adapter.sendTurn({ threadId, text: "FAKE-ONLY", cwd: fixtureBotFolder(), stopLine: true, noLimits: true });
      await vi.waitFor(() => expect(events.some(e => e.type === "turn.completed" && e.turnId === sent.turnId)).toBe(true), { timeout: 15000 });
      expect(events.find(e => e.type === "turn.completed" && e.turnId === sent.turnId), JSON.stringify(events.filter(e => e.type === "runtime.error" || e.type === "turn.completed"))).toMatchObject({ ok: true });
    }
    expect(warn.mock.calls.filter(([line]) => String(line).includes("No limits session"))).toHaveLength(1);
  }, 40000);

  it.each(["execvp", "profile"])("fake sandbox %s failure is classified by stage and never delivers a turn or falls back", async stage => {
    const root = scratch(); const wrapper = join(root, "sandbox");
    const cli = join(root, "muse"); symlinkSync(fake, cli);
    chmodSync(fake, 0o755);
    const detail = stage === "execvp" ? "execvp() of 'muse' failed: No such file or directory" : "sandbox_apply: Operation not permitted";
    writeFileSync(wrapper, `#!/bin/sh\necho "sandbox-exec: ${detail}" >&2\nexit 71\n`); chmodSync(wrapper, 0o755);
    Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(nativeSpawn).mockClear();
    const instance = await make(cli);
    await instance.refreshModels!();
    const events: RuntimeEvent[] = []; instance.adapter.onEvent(event => events.push(event));
    const spawn = vi.spyOn(procs, "spawnCli");
    const snapshot = await instance.snapshot();
    expect(snapshot.reason).toEqual(stage === "execvp" ? MUSE_NOT_INSTALLED_NOTE : expect.stringContaining("power protection"));
    const send = instance.adapter.sendTurn({ threadId: "failure", text: "FAKE-ONLY", stopLine: true, cwd: fixtureBotFolder() });
    if (stage === "execvp") {
      await expect(send).rejects.toThrow(MUSE_NOT_INSTALLED_NOTE);
      expect(events.some(event => event.type === "runtime.error")).toBe(false);
    } else {
      await send;
      await vi.waitFor(() => expect(events.some(event => event.type === "turn.completed")).toBe(true));
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(nativeSpawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(nativeSpawn).mock.calls[0]?.[0]).toBe(wrapper);
    expect(events.some(event => event.type === "item.completed")).toBe(false);
    if (stage === "execvp") expect(warn).not.toHaveBeenCalled();
    else expect(warn.mock.calls.filter(([line]) => String(line).includes("power block"))).toHaveLength(1);
  });
});
