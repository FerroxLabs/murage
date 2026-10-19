import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudProcessHooks, sliceCgroupPath, forgetCloudTurnUnitsForTests, installCloudProcessHooks, registerCloudTurnUnit, unitFor, STOP_WAIT_MS, type HookEnvironment } from "./cloud-process-hooks.ts";
import { platformProcessHooks, setPlatformProcessHooks } from "../platform-process-hooks.ts";
import { cloudTurnEnvironment, cloudTurnLaunch, newTurnUnit, TURN_UNIT_PATTERN } from "./turn-process.ts";

const UNIT = "murage-turn-0123456789abcdef.scope";
const base = `/cg/murage.slice/murage-turns.slice/${UNIT}`;
const err = (code: string) => Object.assign(new Error(code), { code });

/** A fake cgroupfs (path -> contents; a trailing "/" entry is a directory), fake process table and fake systemctl. */
function fake(files: Record<string, string>, opts: { alive?: Set<number>; systemctl?: (unit: string) => string; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 0 };
  const env: HookEnvironment = {
    cgroupRoot: "/cg",
    async readText(path) { if (path in files) return files[path]!; throw err("ENOENT"); },
    async listDirs(path) {
      const prefix = path + "/";
      return [...new Set(Object.keys(files).filter(f => f.startsWith(prefix) && f.endsWith("/cgroup.procs")).map(f => f.slice(prefix.length).split("/")[0]!).filter(n => n !== "cgroup.procs"))];
    },
    processExists: pid => (opts.alive ?? new Set()).has(pid),
    systemctlShow: async unit => (opts.systemctl ?? (() => "ActiveState=inactive\nLoadState=not-found\n"))(unit),
    now: () => clock.t,
    sleep: async ms => { clock.t += ms; },
  };
  return env;
}
const child = (pid = 500) => ({ pid, spawnedAt: 1, command: "sudo" });

beforeEach(() => { forgetCloudTurnUnitsForTests(); registerCloudTurnUnit(500, UNIT); });
afterEach(() => vi.unstubAllEnvs());

describe("turn unit mapping", () => {
  it("generates names the launcher regex accepts and rejects everything else", () => {
    for (let i = 0; i < 50; i++) expect(newTurnUnit()).toMatch(TURN_UNIT_PATTERN);
    for (const bad of ["murage-turn-0123456789ABCDEF.scope", "murage-turn-0123456789abcde.scope", "murage-turn-0123456789abcdef.scope\n", "../murage-turn-0123456789abcdef.scope", "murage-turn-0123456789abcdef.service", "-p MemoryMax=0", "murage-browser-b.01234567.scope", ""])
      expect(TURN_UNIT_PATTERN.test(bad)).toBe(false);
  });
  it("puts the unit in the FD3 request and returns it with the launch", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const launch = cloudTurnLaunch("/usr/bin/claude", [], cloudTurnEnvironment("claudeAgent", {}))!;
    expect(launch.unit).toMatch(TURN_UNIT_PATTERN);
    expect(JSON.parse(launch.request).unit).toBe(launch.unit);
    expect(cloudTurnLaunch("/usr/bin/claude", [], cloudTurnEnvironment("claudeAgent", {}))!.unit).not.toBe(launch.unit);
  });
  it("maps a pid through the registry (reused pids overwrite) or a tag that is itself a valid unit", () => {
    expect(unitFor(child())).toBe(UNIT);
    registerCloudTurnUnit(500, "murage-turn-aaaaaaaaaaaaaaaa.scope");
    expect(unitFor(child())).toBe("murage-turn-aaaaaaaaaaaaaaaa.scope");
    registerCloudTurnUnit(501, "not-a-unit");
    expect(unitFor(child(501))).toBeUndefined();
    expect(unitFor({ ...child(502), tag: UNIT })).toBe(UNIT);
    expect(unitFor({ ...child(502), tag: "../../x" })).toBeUndefined();
  });
});

describe("cgroup path", () => {
  it("nests the turn slice under murage.slice the way systemd does", () => {
    expect(sliceCgroupPath("murage-turns.slice")).toBe("murage.slice/murage-turns.slice");
    expect(sliceCgroupPath("system.slice")).toBe("system.slice");
    expect(sliceCgroupPath("a-b-c.slice")).toBe("a.slice/a-b.slice/a-b-c.slice");
  });
});

describe("listTree", () => {
  it("returns the scope's and its child cgroups' pids minus the root, deduplicated and sorted", async () => {
    const hooks = cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "900\n500\n", [`${base}/sub/cgroup.procs`]: "950\n900\n", [`${base}/sub/deep/cgroup.procs`]: "960\n" }));
    expect(await hooks.listTree!(child())).toEqual([900, 950, 960]);
  });
  it("is [] for an empty scope, and [] once a scope that was seen has vanished", async () => {
    const files: Record<string, string> = { [`${base}/cgroup.procs`]: "" };
    const hooks = cloudProcessHooks(fake(files, { alive: new Set([500]) }));
    expect(await hooks.listTree!(child())).toEqual([]);
    delete files[`${base}/cgroup.procs`];
    expect(await hooks.listTree!(child())).toEqual([]);
  });
  it("is undefined before the scope has started, [] if the root already exited without one", async () => {
    expect(await cloudProcessHooks(fake({}, { alive: new Set([500]) })).listTree!(child())).toBeUndefined();
    expect(await cloudProcessHooks(fake({}, { alive: new Set() })).listTree!(child())).toEqual([]);
  });
  it("is undefined for read errors, malformed pids and children it did not launch", async () => {
    const denied = fake({}); denied.readText = async () => { throw err("EACCES"); };
    expect(await cloudProcessHooks(denied).listTree!(child())).toBeUndefined();
    expect(await cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "12\nabc\n" })).listTree!(child())).toBeUndefined();
    expect(await cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "12\n" })).listTree!(child(777))).toBeUndefined();
  });
  it("ignores a child cgroup that disappears mid-walk", async () => {
    const env = fake({ [`${base}/cgroup.procs`]: "900\n", [`${base}/gone/cgroup.procs`]: "1\n" });
    const read = env.readText; env.readText = async p => p.includes("/gone/") ? Promise.reject(err("ENOENT")) : read(p);
    expect(await cloudProcessHooks(env).listTree!(child())).toEqual([900]);
  });
});

describe("rssBytes", () => {
  it("reads memory.current and is undefined when unreadable or malformed", async () => {
    expect(await cloudProcessHooks(fake({ [`${base}/memory.current`]: "73400320\n" })).rssBytes!(child())).toBe(73400320);
    expect(await cloudProcessHooks(fake({})).rssBytes!(child())).toBeUndefined();
    expect(await cloudProcessHooks(fake({ [`${base}/memory.current`]: "max" })).rssBytes!(child())).toBeUndefined();
    expect(await cloudProcessHooks(fake({ [`${base}/memory.current`]: "5" })).rssBytes!(child(9))).toBeUndefined();
  });
});

describe("confirmStopped", () => {
  it("is true when the unit is gone, the cgroup is gone and the root has exited", async () => {
    expect(await cloudProcessHooks(fake({})).confirmStopped!(child())).toBe(true);
  });
  it("is true for an inactive unit with an empty cgroup", async () => {
    expect(await cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "\n" }, { systemctl: () => "ActiveState=inactive\nLoadState=loaded\n" })).confirmStopped!(child())).toBe(true);
  });
  it("is false (after the bounded wait, never hanging) while an orphaned grandchild stays in the cgroup", async () => {
    const clock = { t: 0 };
    const hooks = cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "", [`${base}/x/cgroup.procs`]: "4242\n" }, { clock }));
    expect(await hooks.confirmStopped!(child())).toBe(false);
    expect(clock.t).toBeGreaterThanOrEqual(STOP_WAIT_MS); expect(clock.t).toBeLessThan(STOP_WAIT_MS + 1000);
  });
  it("is false while systemd still reports the unit active or deactivating", async () => {
    for (const state of ["active", "deactivating", "activating"])
      expect(await cloudProcessHooks(fake({}, { systemctl: () => `ActiveState=${state}\nLoadState=loaded\n` })).confirmStopped!(child())).toBe(false);
  });
  it("a scope systemd killed (state failed, e.g. RuntimeMaxSec) counts as stopped once its cgroup is gone, but not while processes remain", async () => {
    expect(await cloudProcessHooks(fake({}, { systemctl: () => "ActiveState=failed\nLoadState=loaded\n" })).confirmStopped!(child())).toBe(true);
    const clock = { t: 0 };
    const hooks = cloudProcessHooks(fake({ [`${base}/cgroup.procs`]: "4242\n" }, { clock, systemctl: () => "ActiveState=failed\nLoadState=loaded\n" }));
    expect(await hooks.confirmStopped!(child())).toBe(false);
  });
  it("is false while the root (sudo) is still alive, and when systemctl or the cgroup cannot be read", async () => {
    expect(await cloudProcessHooks(fake({}, { alive: new Set([500]) })).confirmStopped!(child())).toBe(false);
    const broken = fake({}); broken.systemctlShow = async () => { throw new Error("no dbus"); };
    expect(await cloudProcessHooks(broken).confirmStopped!(child())).toBe(false);
    const unreadable = fake({}); unreadable.readText = async () => { throw err("EACCES"); };
    expect(await cloudProcessHooks(unreadable).confirmStopped!(child())).toBe(false);
  });
  it("turns true once the tree drains inside the wait", async () => {
    const clock = { t: 0 }; const files: Record<string, string> = { [`${base}/cgroup.procs`]: "900\n" };
    const env = fake(files, { clock });
    const sleep = env.sleep; env.sleep = async ms => { await sleep(ms); if (clock.t >= 1000) delete files[`${base}/cgroup.procs`]; };
    expect(await cloudProcessHooks(env).confirmStopped!(child())).toBe(true);
  });
  it("for a child that was not launched through the launcher only the direct pid is checked", async () => {
    expect(await cloudProcessHooks(fake({})).confirmStopped!(child(777))).toBe(true);
    expect(await cloudProcessHooks(fake({}, { alive: new Set([777]) })).confirmStopped!(child(777))).toBe(false);
  });
});

describe("installation", () => {
  it("installs only on a Cloud home", () => {
    expect(installCloudProcessHooks("")).toBe(false);
    expect(installCloudProcessHooks(undefined)).toBe(false);
    setPlatformProcessHooks({});
    expect(installCloudProcessHooks("x")).toBe(false);
    expect(platformProcessHooks()).toEqual({});
    expect(installCloudProcessHooks("home")).toBe(true);
    expect(platformProcessHooks()).toMatchObject({ listTree: expect.any(Function), confirmStopped: expect.any(Function), rssBytes: expect.any(Function) });
  });
});
