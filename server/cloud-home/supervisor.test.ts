import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, lstatSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_SERVER_ENV_KEYS, homeBootContract, homeServerEnvironment } from "./boot.ts";
import { CLOUD_ENGINES } from "./turn-process.ts";
import { parseHomeIdentity, assertImmutableCode, assertUnprivileged, homeReleaseRoot, homeChildExit, superviseHome } from "./supervisor.ts";
import { prepareEngineHomes, prepareBrokerDir, validateVolumeMarker, assertUnboundVolumeEmpty, bindHomeVolume } from "./home-volume-spec.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const contractEnv = { MURAGE_CLOUD_ROLE: "home", MURAGE_CLOUD_MACHINE_ID: "fixture-home", MURAGE_CLOUD_ADMIN_URL: "https://admin.example.test", MURAGE_PUBLIC_ORIGIN: "https://home.example.test", MURAGE_CLOUD_BOOTSTRAP_SECRET: "x".repeat(32) };
const repo = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const launcher = repo("deploy/cloud-home/murage-home-launch.py");
const root = process.getuid?.() === 0;

describe("home boot and supervision", () => {
  it("is inert without the flag and rejects each partial boot contract", () => {
    expect(homeBootContract({})).toBeNull();
    for (const name of Object.keys(contractEnv)) {
      const env: NodeJS.ProcessEnv = { ...contractEnv }; delete env[name];
      expect(() => homeBootContract(env)).toThrow(/contract/u);
    }
    expect(homeBootContract(contractEnv)?.machineId).toBe("fixture-home");
  });
  it("builds only the allow-list, excluding inherited secrets and runtime injection", () => {
    const env = homeServerEnvironment(homeBootContract(contractEnv)!, "America/New_York");
    expect(Object.keys(env).sort()).toEqual([...HOME_SERVER_ENV_KEYS].sort());
    expect(env).toMatchObject({ MURAGE_CLOUD_SECRETS_FD: "3", MURAGE_PORT: "8799", TZ: "America/New_York", MURAGE_TRUSTED_PROXY: "unix:/data/proxy/murage.sock", MURAGE_DATA_DIR: "/data/home", MURAGE_WARM_POOL_BUDGET_MB: "1200", MURAGE_STATIC_DIR: "/opt/murage/dist" });
    expect(env).not.toHaveProperty("MURAGE_SITE_ORIGIN");
    expect(env).not.toHaveProperty("MURAGE_CLOUD_BOOTSTRAP_SECRET");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("CI");
    expect(() => homeServerEnvironment(homeBootContract(contractEnv)!, "UTC", "8799")).toThrow(/webhook port/u);
    expect(() => homeServerEnvironment(homeBootContract(contractEnv)!, "UTC", "8800;bad")).toThrow(/webhook port/u);
  });
  it("refuses a volume marker from another machine with root ownership modeled at the fs boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "home-volume-")); dirs.push(dir);
    const file = join(dir, ".murage-home-machine");
    writeFileSync(file, "machine-a\n", { mode: 0o600 });
    const stat = lstatSync(file);
    // Qualification runs uid 2001. Only the root-owned uid is modeled;
    // file type, mode, size and content come from the real isolated fixture.
    const rootStat = { uid: 0, mode: stat.mode, size: stat.size, isFile: () => stat.isFile() };
    const content = readFileSync(file, "utf8");
    expect(() => validateVolumeMarker(rootStat, content, "machine-a")).not.toThrow();
    expect(() => validateVolumeMarker(rootStat, content, "machine-b")).toThrow(/another machine/u);
    expect(() => validateVolumeMarker({ ...rootStat, uid: 2001 }, content, "machine-a")).toThrow(/binding/u);
    expect(() => validateVolumeMarker({ ...rootStat, mode: 0o666 }, content, "machine-a")).toThrow(/binding/u);
  });
  it("refuses writable supervisor code, including writable ancestors", () => {
    const dir = mkdtempSync(join(tmpdir(), "home-code-")); dirs.push(dir);
    chmodSync(dir, 0o777);
    expect(() => assertImmutableCode(dir)).toThrow(/not writable/u);
  });
  // T-P7 (LANE-G r3 sec. 1.2): the slot supervisor refuses uid 0 and runs only from a release slot's real path.
  it("refuses to run as root and accepts only a release slot as its root (T-P7)", () => {
    expect(() => assertUnprivileged(0)).toThrow(/not run as root/u);
    // Fail closed: an unknown uid is refused whoever runs the test (root or not), since the function no longer defaults to the real uid.
    expect(() => assertUnprivileged(undefined)).toThrow(/not run as root/u);
    expect(() => assertUnprivileged(1001)).not.toThrow();
    expect(homeReleaseRoot("/opt/murage-releases/A")).toBe("/opt/murage-releases/A");
    expect(homeReleaseRoot("/opt/murage-releases/B")).toBe("/opt/murage-releases/B");
    for (const bad of ["/opt/murage", "/opt/murage-releases/C", "/opt/murage-releases/current", "/opt/murage-releases/A/", "", undefined]) expect(() => homeReleaseRoot(bad)).toThrow(/release root/u);
    const source = readFileSync(new URL("./supervisor.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setuid|setgid|initgroups|bindHomeVolume\(|prepareEngineHomes\(|prepareBrokerDir\(/u);
    const privilegeCall = source.indexOf("assertUnprivileged(process.getuid?.())");
    const immutableCall = source.indexOf("assertImmutableCode(releaseRoot)");
    expect(privilegeCall).toBeGreaterThanOrEqual(0);
    expect(immutableCall).toBeGreaterThanOrEqual(0);
    expect(privilegeCall).toBeLessThan(immutableCall);
    expect(source).toContain("serverArgs: [`${releaseRoot}/dist-server/index.js`]");
  });
  it("refuses a nonempty unbound volume before creating a marker and permits only lost+found", () => {
    const dir = mkdtempSync(join(tmpdir(), "home-unbound-")); dirs.push(dir);
    mkdirSync(join(dir, "lost+found")); expect(() => assertUnboundVolumeEmpty(dir)).not.toThrow();
    writeFileSync(join(dir, "existing-data"), "preserve");
    expect(() => bindHomeVolume(dir, "fixture-home", 2001, 2001, 2002, 2002)).toThrow("not empty");
    expect(existsSync(join(dir, ".murage-home-machine"))).toBe(false);
    expect(readFileSync(join(dir, "existing-data"), "utf8")).toBe("preserve");
  });
  it("exit 75 restarts only the server, with a fresh FD and attached private port", () => {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; stdio: (null | PassThrough)[] }> = [];
    const spawnChild = vi.fn((..._args: unknown[]) => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(), stdio: [null, null, null, new PassThrough()] });
      children.push(child); return child;
    });
    const attach = vi.fn(); const onStop = vi.fn();
    const stop = superviseHome({ env: homeServerEnvironment(homeBootContract(contractEnv)!, "UTC", "8900"), serverCommand: "node", serverArgs: ["server"], envelope: () => '{"version":1}', attach, onStop, spawnChild: spawnChild as never });
    expect(children).toHaveLength(1);
    expect(spawnChild.mock.calls[0]).toMatchObject(["node", ["server"], { env: { MURAGE_WEBHOOK_PORT: "8900" } }]);
    children[0].emit("exit", 75);
    expect(children).toHaveLength(2);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(children[1].stdio[3]?.read()?.toString()).toBe('{"version":1}');
    children[1].emit("exit", 1);
    expect(onStop).toHaveBeenCalledWith(1);
    expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");
    stop();
    expect(homeChildExit("proxy", 75)).toBe("stop");
    expect(homeChildExit("server", 1)).toBe("stop");
  });
  it("closes the lifetime once before manual termination and ignores stale child errors", () => {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; stdio: (null | PassThrough)[] }> = [];
    const order: string[] = [];
    const spawnChild = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => order.push("kill")), stdio: [null, null, null, new PassThrough()] });
      children.push(child); return child;
    });
    const onStop = vi.fn(() => order.push("close"));
    const stop = superviseHome({ env: {}, serverCommand: "fixture", serverArgs: [], envelope: () => "{}", attach: () => {}, onStop, spawnChild: spawnChild as never });
    children[0].emit("exit", 75);
    children[0].emit("error", new Error("old child"));
    expect(onStop).not.toHaveBeenCalled();
    stop(); stop(); children[1].emit("exit", 1);
    expect(onStop).toHaveBeenCalledExactlyOnceWith(0);
    expect(order).toEqual(["close", "kill"]);
  });

  describe("per-engine group isolation", () => {
    const engineGids = Object.fromEntries(CLOUD_ENGINES.map((engine, index) => [engine, 5000 + index]));
    const identity = { uid: 1001, gid: 1001, turnGid: 1002, proxyUid: 1003, proxyGid: 1004, engineGids };
    it("accepts a complete distinct engineGids map", () => { expect(parseHomeIdentity(identity)).toEqual(identity); });
    it("rejects missing, non-integer, low, duplicate and service-colliding engine gids", () => {
      const withGids = (change: (gids: Record<string, number>) => void) => { const gids = { ...engineGids }; change(gids); return { ...identity, engineGids: gids }; };
      expect(() => parseHomeIdentity({ ...identity, engineGids: undefined })).toThrow(/identity/u);
      expect(() => parseHomeIdentity({ uid: 1, gid: 1, turnGid: 1, proxyUid: 1, proxyGid: 1 })).toThrow(/identity/u);
      expect(() => parseHomeIdentity(withGids(gids => { delete gids.codex; }))).toThrow(/identity/u);
      expect(() => parseHomeIdentity(withGids(gids => { gids.codex = 1.5; }))).toThrow(/identity/u);
      expect(() => parseHomeIdentity(withGids(gids => { gids.codex = 0; }))).toThrow(/identity/u);
      expect(() => parseHomeIdentity(withGids(gids => { gids.codex = gids.pi; }))).toThrow(/identity/u);
      for (const gid of [identity.gid, identity.turnGid, identity.proxyGid]) expect(() => parseHomeIdentity(withGids(gids => { gids.codex = gid; }))).toThrow(/identity/u);
    });
    it("creates each engine home and tmp as root:engine-gid 2770 under a 0711 root", () => {
      const dir = mkdtempSync(join(tmpdir(), "engine-homes-")); dirs.push(dir);
      const root = join(dir, "engine-homes"); const owners = new Map<string, [number, number]>();
      prepareEngineHomes(identity, root, (path, uid, gid) => { owners.set(path, [uid, gid]); });
      expect(owners.get(root)).toEqual([0, 0]); expect(lstatSync(root).mode & 0o7777).toBe(0o711);
      for (const engine of CLOUD_ENGINES) for (const path of [join(root, engine), join(root, engine, "tmp")]) {
        expect(owners.get(path)).toEqual([0, engineGids[engine]]); expect(lstatSync(path).mode & 0o7777).toBe(0o2770);
      }
    });
    it("repairs a hand-made broker directory with the wrong mode or group, and the root launcher calls it after the volume binds and before privileges drop", () => {
      const dir = mkdtempSync(join(tmpdir(), "broker-")); dirs.push(dir);
      const broker = join(dir, "broker"); mkdirSync(broker, { mode: 0o755 }); chmodSync(broker, 0o755);
      const owners = new Map<string, [number, number]>();
      prepareBrokerDir(identity, broker, (path, uid, gid) => { owners.set(path, [uid, gid]); });
      expect(owners.get(broker)).toEqual([0, identity.turnGid]); expect(lstatSync(broker).mode & 0o7777).toBe(0o3770);
      // The order of a home start is the launcher's now (LANE-G r3 sec. 1.4): bind, prepare, gate, drop, exec through the descriptor.
      const source = readFileSync(launcher, "utf8");
      const main = source.slice(source.indexOf("def main():"));
      const bind = main.indexOf("bind_home_volume(DATA"), prepare = main.indexOf("prepare_broker_dir(identity)"), gate = main.indexOf("start_gate()"), drop = main.indexOf("drop_privileges(identity)"), exec = main.indexOf("exec_supervisor(dirfd, env)");
      expect(bind).toBeGreaterThan(-1); expect(prepare).toBeGreaterThan(bind); expect(gate).toBeGreaterThan(prepare); expect(drop).toBeGreaterThan(gate); expect(exec).toBeGreaterThan(drop);
    });
    it("creates the approval broker directory with the sticky bit (3770) so a group member cannot unlink a socket it does not own", () => {
      const dir = mkdtempSync(join(tmpdir(), "broker-")); dirs.push(dir);
      const broker = join(dir, "broker");
      prepareBrokerDir(identity, broker, () => {});
      expect(lstatSync(broker).mode & 0o7777).toBe(0o3770);
      const repaired = join(dir, "repaired"); mkdirSync(repaired, { mode: 0o2770 }); chmodSync(repaired, 0o2770);
      prepareBrokerDir(identity, repaired, () => {});
      expect(lstatSync(repaired).mode & 0o7777).toBe(0o3770);
    });
    it("creates the approval broker directory as root:murage-turn 3770, outside every engine home", () => {
      const dir = mkdtempSync(join(tmpdir(), "broker-")); dirs.push(dir);
      const broker = join(dir, "broker"); const owners = new Map<string, [number, number]>();
      prepareBrokerDir(identity, broker, (path, uid, gid) => { owners.set(path, [uid, gid]); });
      expect(owners.get(broker)).toEqual([0, identity.turnGid]); expect(lstatSync(broker).mode & 0o7777).toBe(0o3770);
    });
    // T-P5 (LANE-G r3 sec. 7): the Python port in murage-home-launch.py and the TypeScript spec produce the same tree (paths, modes,
    // owners, types), run against the same scratch volume. Owners need root; unprivileged runs check the TypeScript alone above.
    it.skipIf(!root || process.platform !== "linux")("the launcher's Python port of bindHomeVolume/prepareEngineHomes/prepareBrokerDir yields the identical tree (T-P5)", () => {
      const dir = mkdtempSync(join(tmpdir(), "home-port-")); dirs.push(dir);
      const ts = join(dir, "ts"), py = join(dir, "py");
      const ids = { uid: 60001, gid: 60001, turnGid: 60002, proxyUid: 60003, proxyGid: 60004, engineGids: Object.fromEntries(CLOUD_ENGINES.map((engine, index) => [engine, 60100 + index])) };
      for (const base of [ts, py]) mkdirSync(join(base, "data"), { recursive: true });
      bindHomeVolume(join(ts, "data"), "fixture-home", ids.uid, ids.gid, ids.proxyUid, ids.proxyGid);
      prepareEngineHomes(ids, join(ts, "data", "engine-homes"));
      prepareBrokerDir(ids, join(ts, "data", "broker"));
      const code = `import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); spec = importlib.util.spec_from_loader(loader.name, loader)
L = importlib.util.module_from_spec(spec); loader.exec_module(L)
ids = json.loads(sys.argv[3]); base = sys.argv[2]
L.bind_home_volume(base + "/data", "fixture-home", ids["uid"], ids["gid"], ids["proxyUid"], ids["proxyGid"])
L.prepare_engine_homes(ids, base + "/data/engine-homes")
L.prepare_broker_dir(ids, base + "/data/broker")`;
      const run = spawnSync("python3", ["-I", "-c", code, launcher, py, JSON.stringify(ids)], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const listing = (base: string) => execFileSync("find", [join(base, "data"), "-printf", "%P %m %u %g %y\n"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
      expect(listing(py)).toEqual(listing(ts));
      expect(listing(ts)).toContain(" 1771 root 60001 d");
      expect(readFileSync(join(py, "data", ".murage-home-machine"), "utf8")).toBe("fixture-home\n");
    });
  });
});
