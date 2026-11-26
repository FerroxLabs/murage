// DESIGN 1022-cua-windows r6: witnesses of the Windows runtime through its real entries (enable, disable, retry,
// shutdown, onHarnessMessage, wireHostDesktop, cuaCleanupStage). Only process creation, the OS probes, the native
// addon and the clock are faked; the runtime's own state machine, epoch fence and stop order are the code under test.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createWindowsCuaRuntime, createWindowsCuaPreferenceStore, classifyWhoamiGroups, cuaCleanupStage, cuaStopStageMs, wireHostDesktop, SAVE_FAILED,
} = require("./cua-windows-runtime.cjs");
const { verifyExeIdentity, defaultIdentityFs } = await import("../shared/cua-driver-identity.mjs");
const messages = await import("../shared/cua-host-messages.mjs");
const { prepareBackedUpInstall } = await import("./preupgrade-continuation.mjs");
const { prepareUpdaterRestart } = await import("./updater-restart.mjs");

const MEDIUM = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192","Mandatory group, Enabled by default, Enabled group"\r\n';
const MEDIUM_PLUS = '"Mandatory Label\\Medium Plus Mandatory Level","Label","S-1-16-8448","Mandatory group, Enabled by default, Enabled group"\r\n';
const HIGH = '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288","Mandatory group, Enabled by default, Enabled group"\r\n';
const SYSTEM = '"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384","Mandatory group, Enabled by default, Enabled group"\r\n';
const LOW = '"Mandatory Label\\Low Mandatory Level","Label","S-1-16-4096","Mandatory group, Enabled by default, Enabled group"\r\n';
const GROUP = '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\r\n';
const NO_TASKS = "INFO: No tasks are running which match the specified criteria.\r\n";

const flush = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) { id += 1; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
      await flush();
    },
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.exit = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit("exit", 0); } };
  return child;
}

function memoryFs(files = new Map()) {
  return {
    files,
    readFileSync(file) { if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(file); },
    writeFileSync(file, data) { files.set(file, String(data)); },
    rmSync(file) { files.delete(file); },
    mkdirSync() {},
  };
}

/** A gate: an await the test holds and releases with a chosen value. */
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release, held: true };
}

function rig(over = {}) {
  const clock = fakeClock();
  const posted = [];
  const spawned = [];
  const killed = [];
  let nextPid = 5000;
  const exitOnKill = over.exitOnKill ?? true;
  const pref = { value: over.pref ?? false, read() { return this.value; }, write(value) { if (over.prefWriteThrows && value === false) throw new Error("disk full"); this.value = value; } };
  const memFs = memoryFs();
  const starts = new Map();
  const spawn = vi.fn((file, args, options) => {
    const child = fakeChild(nextPid);
    nextPid += 1;
    starts.set(child.pid, String(132000000000000000n + BigInt(child.pid)));
    spawned.push({ file, args, options, child });
    return child;
  });
  const taskkill = vi.fn((pid) => {
    killed.push(pid);
    const entry = spawned.find((item) => item.child.pid === pid);
    if (entry && exitOnKill) clock.setTimeout(() => entry.child.exit(), over.exitAfterMs ?? 0);
  });
  const native = {
    processStart: vi.fn((pid) => (starts.has(pid) ? starts.get(pid) : null)),
    terminateIfStart: vi.fn(() => "unknown"),
    ...over.native,
  };
  const runtime = createWindowsCuaRuntime({
    resourcesPath: "C:\\R",
    runtimeDir: "C:\\U\\cua",
    preferenceStore: pref,
    port: over.port ?? { postMessage: (message) => posted.push(message) },
    spawn,
    taskkill,
    runProbe: over.runProbe ?? (async () => ({ code: 0, stdout: GROUP + MEDIUM })),
    runTasklist: over.runTasklist ?? (async () => ({ code: 0, stdout: NO_TASKS })),
    native,
    arm64: over.arm64 ?? (async () => false),
    verifyExeIdentity: over.verifyExeIdentity ?? (async () => ({ ok: true, identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" } })),
    statIdentity: over.statIdentity ?? (() => ({ dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" })),
    pins: { driver: "a".repeat(64), cursor: "b".repeat(64) },
    handshake: over.handshake ?? (async () => true),
    writeDescriptor: over.writeDescriptor ?? (() => {}),
    deleteDescriptor: over.deleteDescriptor ?? (() => {}),
    fs: memFs,
    clock,
    env: over.env ?? {},
    processId: 4242,
    generationId: (() => { let n = 0; return () => { n += 1; return n.toString(16).padStart(12, "0"); }; })(),
  });
  return { runtime, clock, posted, spawned, killed, spawn, taskkill, native, pref, memFs, starts };
}

const ownerRecordPath = path.join("C:\\U\\cua", "driver.owner.json");

afterEach(() => { vi.restoreAllMocks(); });

describe("W-C2 switch default OFF (R10)", () => {
  it("fresh userData: initialize spawns nothing and reports enabled:false", async () => {
    const r = rig();
    const status = await r.runtime.initialize();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    expect(status.enabled).toBe(false);
  });
  it("enable: exactly one daemon spawn (the daemon needs the app switch only)", async () => {
    const r = rig();
    await r.runtime.enable();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
});

describe("W-S2 spawn env exact and scrubbed (R6)", () => {
  it("hostile parent env -> the daemon gets the D4 values and no other CUA_* key", async () => {
    const r = rig({ env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "true", DO_NOT_TRACK: "0", CUA_DRIVER_FOO: "1", PATH: "C:\\Windows" } });
    await r.runtime.enable();
    const env = r.spawned[0].options.env;
    expect(env).toMatchObject({ CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.murage.app", CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1" });
    expect(Object.keys(env).filter((key) => /^CUA_/i.test(key)).sort()).toEqual(["CUA_DRIVER_EMBEDDED", "CUA_DRIVER_HOST_BUNDLE_ID", "CUA_DRIVER_PARENT_LIVENESS_STDIN", "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK"]);
  });
  it("the daemon command line is the supervised serve with the private pipe", async () => {
    const r = rig();
    await r.runtime.enable();
    expect(r.spawned[0].args.slice(0, 4)).toEqual(["serve", "--embedded", "--socket", "\\\\.\\pipe\\murage-cua-4242-000000000001"]);
    expect(r.spawned[0].options.windowsHide).toBe(true);
  });
});

describe("W-E1 elevation probe, positive parse only (R11)", () => {
  const refused = [
    ["High row", { code: 0, stdout: GROUP + HIGH }, "windows-elevated"],
    ["System row", { code: 0, stdout: GROUP + SYSTEM }, "windows-elevated"],
    ["exit 0 with garbage", { code: 0, stdout: "not csv at all\r\n" }, "windows-integrity-unknown"],
    ["exit 0 CSV with no label row", { code: 0, stdout: GROUP }, "windows-integrity-unknown"],
    ["Low row", { code: 0, stdout: GROUP + LOW }, "windows-integrity-unknown"],
    ["exit 1", { code: 1, stdout: GROUP + MEDIUM }, "windows-integrity-unknown"],
    ["two label rows (Medium + High)", { code: 0, stdout: MEDIUM + HIGH }, "windows-integrity-unknown"],
  ];
  for (const [name, result, code] of refused) {
    it(`${name} -> ${code}, spawn 0`, async () => {
      const r = rig({ runProbe: async () => result });
      const status = await r.runtime.enable();
      expect(status.reasonCode, expect.getState().currentTestName).toBe(code);
      expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    });
  }
  it("spawn error (ENOENT) -> windows-integrity-unknown, spawn 0", async () => {
    const r = rig({ runProbe: async () => { throw Object.assign(new Error("spawn whoami ENOENT"), { code: "ENOENT" }); } });
    const status = await r.runtime.enable();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("windows-integrity-unknown");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("probe that never answers within 5 s (fake clock) -> windows-integrity-unknown, spawn 0", async () => {
    const r = rig({ runProbe: () => new Promise(() => {}) });
    const pending = r.runtime.enable();
    await r.clock.advance(5_001);
    const status = await pending;
    expect(status.reasonCode, expect.getState().currentTestName).toBe("windows-integrity-unknown");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("Medium row -> proceeds to spawn", async () => {
    const r = rig({ runProbe: async () => ({ code: 0, stdout: GROUP + MEDIUM }) });
    await r.runtime.enable();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("Medium Plus row -> proceeds to spawn", async () => {
    const r = rig({ runProbe: async () => ({ code: 0, stdout: GROUP + MEDIUM_PLUS }) });
    await r.runtime.enable();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("classifier: first label row never wins over a second", () => {
    expect(classifyWhoamiGroups({ code: 0, stdout: MEDIUM + HIGH })).toBe("windows-integrity-unknown");
  });
});

describe("W-A1 Windows on Arm refused (R12)", () => {
  it("running under ARM64 translation -> windows-arm64-unsupported, spawn 0", async () => {
    const r = rig({ arm64: async () => true });
    const status = await r.runtime.enable();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("windows-arm64-unsupported");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
});

describe("W-S1 / W-S1b integrity at daemon start, fd-bound (R5)", () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const stage = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-cua-win-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "cua-win32-x64"));
    const files = { driver: path.join(dir, "cua-win32-x64", "cua-driver.exe"), cursor: path.join(dir, "cua-win32-x64", "cua-cursor-theme.exe") };
    fs.writeFileSync(files.driver, Buffer.alloc(4096, 7));
    fs.writeFileSync(files.cursor, Buffer.alloc(2048, 9));
    fs.writeFileSync(path.join(dir, "other.exe"), Buffer.alloc(4096, 1));
    const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { dir, files, pins: { driver: sha(files.driver), cursor: sha(files.cursor) } };
  };
  const runtimeOver = (staged, identityFs) => {
    const r = rig({ verifyExeIdentity: (file, pin) => verifyExeIdentity(file, pin, identityFs ?? defaultIdentityFs, { platform: "linux" }) });
    return r;
  };
  const build = (staged, identityFs) => {
    const base = runtimeOver(staged, identityFs);
    const runtime = createWindowsCuaRuntime({
      resourcesPath: staged.dir, runtimeDir: path.join(staged.dir, "run"), preferenceStore: base.pref, port: { postMessage() {} },
      spawn: base.spawn, taskkill: base.taskkill, runProbe: async () => ({ code: 0, stdout: GROUP + MEDIUM }), runTasklist: async () => ({ code: 0, stdout: NO_TASKS }),
      native: base.native, verifyExeIdentity: (file, pin) => verifyExeIdentity(file, pin, identityFs ?? defaultIdentityFs, { platform: "linux" }),
      pins: staged.pins, handshake: async () => true, fs: memoryFs(), clock: base.clock, env: {}, processId: 4242,
    });
    return { ...base, runtime };
  };
  it("untouched staged exes -> spawn 1 (control)", async () => {
    const staged = stage();
    const r = build(staged);
    await r.runtime.enable();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  for (const which of ["driver", "cursor"]) {
    it(`W-S1 one changed byte in ${which} -> driver-integrity, spawn 0`, async () => {
      const staged = stage();
      const bytes = fs.readFileSync(staged.files[which]); bytes[10] ^= 1; fs.writeFileSync(staged.files[which], bytes);
      const r = build(staged);
      const status = await r.runtime.enable();
      expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-integrity");
      expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    });
    // The OS decides whether a file held open can be replaced: POSIX lets the rename through (the hash read next is of
    // the OTHER file -> driver-integrity); NTFS refuses it (EPERM/EBUSY, the real Windows run on 4e3d2628f0) so the held bytes
    // stay the pinned ones. `refuse` simulates the NTFS answer on every platform; the real-rename cell runs where the OS
    // lets the swap through (never on win32, where the next cell is the real witness).
    for (const refuse of [false, true]) {
      it.skipIf(!refuse && process.platform === "win32")(`W-S1b ${which}: a same-size other file renamed over the path after the first fd read, ${refuse ? "the OS refuses (NTFS)" : "the OS allows (POSIX)"} -> ${refuse ? "the pinned bytes start" : "driver-integrity, spawn 0"}`, async () => {
        const staged = stage();
        const other = path.join(staged.dir, "other.exe");
        if (which === "cursor") fs.writeFileSync(other, Buffer.alloc(2048, 1));
        let reads = 0;
        let swapped = false;
        let attempts = 0;
        const identityFs = { ...defaultIdentityFs, read: async (fd, buffer, offset, length, position) => {
          const bytes = await defaultIdentityFs.read(fd, buffer, offset, length, position);
          reads += 1;
          if (reads === 1 && fdPath.get(fd) === staged.files[which]) {
            attempts += 1;
            try {
              if (refuse) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
              fs.renameSync(other, staged.files[which]); swapped = true;
            } catch { swapped = false; }
          }
          return bytes;
        }, open: async (file, flags) => { const fd = await defaultIdentityFs.open(file, flags); fdPath.set(fd, file); reads = 0; return fd; } };
        const fdPath = new Map();
        const r = build(staged, identityFs);
        const status = await r.runtime.enable();
        expect(attempts, `${expect.getState().currentTestName}: the rename was attempted exactly once, on the held driver file after its first read`).toBe(1);
        expect(swapped, "the swap outcome is the OS's, as set up").toBe(!refuse);
        if (swapped) {
          expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-integrity");
          expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
        } else {
          // nothing replaced the file: only the pinned bytes can start, and nothing reports an integrity failure
          expect(status.reasonCode, expect.getState().currentTestName).not.toBe("driver-integrity");
          expect(createHash("sha256").update(fs.readFileSync(staged.files[which])).digest("hex"), "the file on disk is still the pinned one").toBe(staged.pins[which]);
          expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
        }
      });
    }
    // Runs on every platform with the OS's own answer (NTFS refuses: pinned bytes start; POSIX allows: driver-integrity), so its attempt counter is proven by a mutant on Linux CI too.
    it(`W-S1b ${which} (real rename, the OS decides): a rename over the held file either fails (pinned bytes start) or ends driver-integrity; a swapped file never starts`, async () => {
      const staged = stage();
      const other = path.join(staged.dir, "other.exe");
      if (which === "cursor") fs.writeFileSync(other, Buffer.alloc(2048, 1));
      let reads = 0; let swapped = false; let attempts = 0; let refusedWith = null;
      const fdPath = new Map();
      const identityFs = { ...defaultIdentityFs, read: async (fd, buffer, offset, length, position) => {
        const bytes = await defaultIdentityFs.read(fd, buffer, offset, length, position);
        reads += 1;
        if (reads === 1 && fdPath.get(fd) === staged.files[which]) { attempts += 1; try { fs.renameSync(other, staged.files[which]); swapped = true; } catch (error) { swapped = false; refusedWith = error?.code ?? "unknown"; } }
        return bytes;
      }, open: async (file, flags) => { const fd = await defaultIdentityFs.open(file, flags); fdPath.set(fd, file); reads = 0; return fd; } };
      const r = build(staged, identityFs);
      const status = await r.runtime.enable();
      expect(attempts, `${expect.getState().currentTestName}: the rename was attempted exactly once, on the held driver file after its first read`).toBe(1);
      if (!swapped) expect(["EPERM", "EBUSY", "EACCES"], `the OS refused the rename with ${refusedWith}`).toContain(refusedWith);
      if (swapped) { expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-integrity"); expect(r.spawn, "a swapped file never starts").toHaveBeenCalledTimes(0); }
      else expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    });
    it(`W-S1b ${which}: one byte written in place through the path after the first fd read -> driver-integrity, spawn 0`, async () => {
      const staged = stage();
      let reads = 0;
      const fdPath = new Map();
      const identityFs = { ...defaultIdentityFs, read: async (fd, buffer, offset, length, position) => {
        const bytes = await defaultIdentityFs.read(fd, buffer, offset, length, position);
        reads += 1;
        if (reads === 1 && fdPath.get(fd) === staged.files[which]) {
          const handle = fs.openSync(staged.files[which], "r+");
          fs.writeSync(handle, Buffer.from([0x42]), 0, 1, 4000 % fs.statSync(staged.files[which]).size);
          fs.closeSync(handle);
          const later = new Date(Date.now() + 5_000); fs.utimesSync(staged.files[which], later, later);
        }
        return bytes;
      }, open: async (file, flags) => { const fd = await defaultIdentityFs.open(file, flags); fdPath.set(fd, file); reads = 0; return fd; } };
      const r = build(staged, identityFs);
      const status = await r.runtime.enable();
      expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-integrity");
      expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    });
  }
});

describe("W-Q1 one stop barrier (R20)", () => {
  it("withdrawn:G is posted before taskkill, taskkill hits the exact pid, the stop settles only after exit", async () => {
    const r = rig({ exitAfterMs: 1_000 });
    await r.runtime.enable();
    const pid = r.spawned[0].child.pid;
    const order = [];
    r.taskkill.mockImplementation((killedPid) => { order.push(["taskkill", killedPid, r.posted.some((m) => m.withdrawn)]); r.clock.setTimeout(() => r.spawned[0].child.exit(), 1_000); });
    let settled = false;
    const stopping = r.runtime.shutdown("quit").then(() => { settled = true; });
    await flush();
    expect(order).toEqual([["taskkill", pid, true]]);
    await r.clock.advance(500);
    expect(settled).toBe(false);
    await r.clock.advance(600);
    await stopping;
    expect(settled).toBe(true);
    expect(r.posted.at(-1)).toEqual(messages.retiredMessage("000000000001"));
  });
  it("no exit -> the stop rejects at 5 s with cua-stop-timeout", async () => {
    const r = rig({ exitOnKill: false });
    await r.runtime.enable();
    const stopping = r.runtime.shutdown("quit");
    const outcome = stopping.then(() => "resolved", (error) => error.code);
    await r.clock.advance(5_001);
    expect((await outcome) === "cua-stop-timeout", "cleanup reported incomplete").toBe(true);
  });
  for (const [name, port] of [["throws", { postMessage() { throw new Error("gone"); } }], ["never returns", { postMessage() { return new Promise(() => {}); } }]]) {
    it(`harness gone at quit (postMessage ${name}) -> taskkill still called on the exact pid within 50 ms, stop settles on exit`, async () => {
      const r = rig({ port });
      await r.runtime.enable();
      const pid = r.spawned[0].child.pid;
      const stopping = r.runtime.shutdown("quit");
      await r.clock.advance(50);
      expect(r.killed).toEqual([pid]);
      await stopping;
    });
  }
});

describe("W-Q2 a stop that never exits (R17c)", () => {
  it("-> driver-stuck, no retired post, and a re-enable does not spawn while the old pid lives", async () => {
    const r = rig({ exitOnKill: false });
    await r.runtime.enable();
    const outcome = r.runtime.retry();
    await r.clock.advance(5_001);
    await outcome;
    expect(r.runtime.getStatus().reasonCode).toBe("driver-stuck");
    expect(r.posted.some((m) => m.retired)).toBe(false);
    // the old pid still answers its own start time (alive)
    await r.runtime.enable();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    expect(r.runtime.getStatus().message).toMatch(/didn't stop when asked/);
  });
});

describe("W-C7 Disable never depends on saving the setting (R10d, D17 d)", () => {
  it("preference write throws -> live:null then withdrawn:G posted and taskkill on the exact pid", async () => {
    const r = rig({ prefWriteThrows: true });
    await r.runtime.enable();
    const pid = r.spawned[0].child.pid;
    const outcome = r.runtime.disable().catch((error) => error);
    await r.clock.advance(10);
    await outcome;
    const tail = r.posted.slice(-3).map((m) => (m.live !== undefined ? "live" : m.withdrawn ? "withdrawn" : m.retired ? "retired" : "?"));
    expect(tail).toEqual(["live", "withdrawn", "retired"]);
    expect(r.killed).toEqual([pid]);
  });
  it("and the handler rejects with the D17(d) sentence", async () => {
    const r = rig({ prefWriteThrows: true });
    await r.runtime.enable();
    const outcome = r.runtime.disable().then(() => null, (error) => error.message);
    await r.clock.advance(10);
    expect(await outcome).toBe(SAVE_FAILED);
  });
});

describe("W-K4 the Electron half of harness messages (R17f)", () => {
  it("cua-stuck {G} -> D15 stop of G, then a new checking with G+1", async () => {
    const r = rig();
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(10);
    expect(r.killed).toEqual([r.spawned[0].child.pid]);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(2);
    expect(r.runtime.getStatus()).toMatchObject({ status: "ready", generation: "000000000002" });
  });
  it("cua-integrity {G} -> card driver-integrity and D15 stop, no respawn", async () => {
    const r = rig();
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.integrityMessage("000000000001"), {});
    await r.clock.advance(10);
    expect(r.runtime.getStatus().reasonCode).toBe("driver-integrity");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("stale cua-stuck {G-1} -> no stop", async () => {
    const r = rig();
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(10);
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(10);
    expect(r.killed).toHaveLength(1);
  });
});

describe("W-K5 (vi) leftover process at app start: pid AND start time, UNKNOWN fails closed (D19)", () => {
  const leftover = (r, start = "131111111111111111") => { r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start, generation: "00000000000f" })); };
  it("(vi-a) record matches a live process -> terminateIfStart once with the recorded start, taskkill 0, spawn only after gone()", async () => {
    let alive = true;
    const r = rig({ pref: true, native: {
      processStart: vi.fn((pid) => (pid === 777 ? (alive ? "131111111111111111" : null) : "132000000000005000")),
      terminateIfStart: vi.fn(() => { r_clockKill(); return "terminated"; }),
    } });
    function r_clockKill() { r.clock.setTimeout(() => { alive = false; }, 300); }
    leftover(r);
    const pending = r.runtime.initialize();
    await r.clock.advance(200);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    await r.clock.advance(400);
    await pending;
    expect(r.native.terminateIfStart).toHaveBeenCalledTimes(1);
    expect(r.native.terminateIfStart).toHaveBeenCalledWith(777, "131111111111111111");
    expect(r.taskkill).toHaveBeenCalledTimes(0);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("(vi-b) the pid is alive with ANOTHER start (reused) -> nothing terminated, record deleted, spawn 1", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn((pid) => (pid === 777 ? "139999999999999999" : "132000000000005000")), terminateIfStart: vi.fn(() => "terminated") } });
    leftover(r);
    await r.runtime.initialize();
    expect(r.native.terminateIfStart).toHaveBeenCalledTimes(0);
    expect(r.taskkill).toHaveBeenCalledTimes(0);
    expect(r.memFs.files.has(ownerRecordPath)).toBe(true); // replaced by the new driver's own record
    expect(JSON.parse(r.memFs.files.get(ownerRecordPath)).pid).toBe(5000);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("(vi-b2) the pid is reused between the read and the kill -> terminateIfStart answers mismatch, nothing is killed by pid, the record is dropped", async () => {
    // processStart still answers the recorded start (the read happened before the reuse); only the one-handle
    // terminateIfStart sees the foreign process. Any kill by pid here would hit that foreign process.
    const r = rig({ pref: true, native: {
      processStart: vi.fn((pid) => (pid === 777 ? "131111111111111111" : "132000000000005000")),
      terminateIfStart: vi.fn(() => "mismatch"),
    } });
    leftover(r);
    const pending = r.runtime.initialize();
    await r.clock.advance(5_200);
    await pending;
    expect(r.native.terminateIfStart).toHaveBeenCalledWith(777, "131111111111111111");
    expect(r.taskkill).toHaveBeenCalledTimes(0);
    expect(JSON.parse(r.memFs.files.get(ownerRecordPath)).pid, "the leftover record was dropped (now our new driver's)").toBe(5000);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("(vi-c) terminateIfStart says terminated but the same start stays for 5 s -> driver-stuck, spawn 0", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn(() => "131111111111111111"), terminateIfStart: vi.fn(() => "terminated") } });
    leftover(r);
    const pending = r.runtime.initialize();
    await r.clock.advance(5_200);
    const status = await pending;
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("(vi-d) a driver.pid with no owner record -> taskkill 0, terminate 0", async () => {
    const r = rig({ pref: true });
    r.memFs.files.set(path.join("C:\\U\\cua", "driver.pid"), "777");
    await r.runtime.initialize();
    expect(r.taskkill).toHaveBeenCalledTimes(0);
    expect(r.native.terminateIfStart).toHaveBeenCalledTimes(0);
  });
  it("(vi-e) processStart null and tasklist unreadable -> driver-stuck, spawn 0, record kept", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "terminated") }, runTasklist: async () => ({ code: 1, stdout: "" }) });
    leftover(r);
    const status = await r.runtime.initialize();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    expect(r.memFs.files.has(ownerRecordPath)).toBe(true);
  });
  it("(vi-a') processStart null after terminate: the exit counts only once tasklist shows no row", async () => {
    let rows = true;
    const r = rig({ pref: true, native: {
      processStart: vi.fn((pid) => (pid === 777 ? (calls++ === 0 ? "131111111111111111" : null) : "132000000000005000")),
      terminateIfStart: vi.fn(() => "terminated"),
    }, runTasklist: async () => ({ code: 0, stdout: rows ? '"cua-driver.exe","777","Console","1","10,000 K"\r\n' : NO_TASKS }) });
    let calls = 0;
    leftover(r);
    const pending = r.runtime.initialize();
    await r.clock.advance(1_000);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    rows = false;
    await r.clock.advance(200);
    await pending;
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
});

describe("W-Q4 nothing spawns after a stop, from any await point (R20b, D18)", () => {
  const points = ["arm64", "probe", "driver-hash", "cursor-hash"];
  const holdAt = (point, g) => ({
    arm64: point === "arm64" ? () => g.promise.then(() => false) : async () => false,
    runProbe: point === "probe" ? () => g.promise.then(() => ({ code: 0, stdout: GROUP + MEDIUM })) : async () => ({ code: 0, stdout: GROUP + MEDIUM }),
    verifyExeIdentity: async (file) => {
      if ((point === "driver-hash" && file.endsWith("cua-driver.exe")) || (point === "cursor-hash" && file.endsWith("cua-cursor-theme.exe"))) await g.promise;
      later.push(file);
      return { ok: true, identity: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" } };
    },
  });
  let later = [];
  for (const point of points) {
    for (const trigger of ["disable", "quit", "retry"]) {
      it(`${point} held, ${trigger} -> spawn ${trigger === "retry" ? "exactly 1 of the new epoch" : "0"}, no live for the old attempt`, async () => {
        later = [];
        const g = gate();
        const r = rig({ ...holdAt(point, g) });
        const enabling = r.runtime.enable();
        await flush();
        const stopping = trigger === "disable" ? r.runtime.disable() : trigger === "quit" ? r.runtime.shutdown("quit") : r.runtime.retry();
        await flush();
        g.release();
        await r.clock.advance(10);
        await Promise.all([enabling, stopping]);
        expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(trigger === "retry" ? 1 : 0);
        expect(r.posted.filter((m) => m.live === "000000000001").length, expect.getState().currentTestName).toBe(trigger === "retry" ? 1 : 0);
      });
    }
    it(`${point} held, disable -> no later step of checking starts for the old epoch`, async () => {
      later = [];
      const g = gate();
      const steps = { arm64: 0, probe: 0, driver: 0, cursor: 0 };
      const hold = holdAt(point, g);
      const r = rig({
        arm64: () => { steps.arm64 += 1; return hold.arm64(); },
        runProbe: () => { steps.probe += 1; return hold.runProbe(); },
        verifyExeIdentity: (file) => { steps[file.endsWith("cua-driver.exe") ? "driver" : "cursor"] += 1; return hold.verifyExeIdentity(file); },
      });
      const enabling = r.runtime.enable();
      await flush();
      const disabling = r.runtime.disable();
      await flush();
      g.release();
      await r.clock.advance(10);
      await Promise.all([enabling, disabling]);
      const order = ["arm64", "probe", "driver", "cursor"];
      const heldIndex = order.indexOf(point === "driver-hash" ? "driver" : point === "cursor-hash" ? "cursor" : point);
      for (const step of order.slice(heldIndex + 1)) expect(steps[step], `${step} after ${point}`).toBe(0);
    });
  }
  it("update joins the pending check: the installer runs only after the held check has returned", async () => {
    const g = gate();
    const r = rig({ runProbe: () => g.promise.then(() => ({ code: 0, stdout: GROUP + MEDIUM })) });
    const enabling = r.runtime.enable();
    await flush();
    let installed = 0;
    const update = cuaCleanupStage({ stop: () => r.runtime.shutdown("update"), ms: cuaStopStageMs("win32"), clock: r.clock }).then(() => { installed += 1; }, () => {});
    await r.clock.advance(3_000);
    expect(installed).toBe(0);
    g.release();
    await r.clock.advance(10);
    await Promise.all([enabling, update]);
    expect(installed).toBe(1);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("update with the check held past the stage bound -> the stage rejects and the installer count is 0", async () => {
    // held at the driver hash: the elevation probe has its own 5 s bound, so only a hash can outlast the 6 s stage
    const g = gate();
    const r = rig({ verifyExeIdentity: async () => { await g.promise; return { ok: true, identity: {} }; } });
    void r.runtime.enable();
    await flush();
    let installed = 0;
    let rejected = false;
    const update = cuaCleanupStage({ stop: () => r.runtime.shutdown("update"), ms: cuaStopStageMs("win32"), clock: r.clock }).then(() => { installed += 1; }, () => { rejected = true; });
    await r.clock.advance(6_001);
    await update;
    expect(rejected).toBe(true);
    expect(installed).toBe(0);
  });
});

describe("W-Q3 (iii)/(iv) update while starting (R20)", () => {
  it("(iii) handshake pending -> withdrawn:G and taskkill on the starting child at t=0; no descriptor for G admitted", async () => {
    const writes = [];
    const r = rig({ handshake: () => new Promise(() => {}), writeDescriptor: (d) => writes.push(d) });
    void r.runtime.enable();
    await flush();
    expect(r.runtime.getStatus().status).toBe("starting");
    const stopping = r.runtime.shutdown("update");
    await flush();
    expect(r.posted.some((m) => m.withdrawn === "000000000001" && m.cause === "update")).toBe(true);
    expect(r.killed).toEqual([r.spawned[0].child.pid]);
    await r.clock.advance(10);
    await stopping;
    expect(writes).toHaveLength(0);
  });
  it("(iv) late readiness after the withdrawal -> never ready(G), no live:G", async () => {
    const hs = gate();
    const r = rig({ handshake: () => hs.promise, exitAfterMs: 2_000 });
    void r.runtime.enable();
    await flush();
    const stopping = r.runtime.shutdown("update");
    await r.clock.advance(1_000);
    hs.release(true);
    await r.clock.advance(1_500);
    await stopping;
    expect(r.posted.some((m) => m.live === "000000000001")).toBe(false);
    expect(r.runtime.getStatus().status).not.toBe("ready");
  });
  it("a stop during checking kills the elevation probe child by its exact pid", async () => {
    const r = rig({ runProbe: ({ onChild }) => { onChild({ pid: 9191 }); return new Promise(() => {}); } });
    void r.runtime.enable();
    await flush();
    const stopping = r.runtime.disable();
    await r.clock.advance(10);
    expect(r.killed).toContain(9191);
    await r.clock.advance(5_100);
    await stopping;
  });
  it("win32 stage bound is WIN_CUA_STOP_MS + 1000; darwin/linux keep 2500", () => {
    expect(cuaStopStageMs("win32")).toBe(6_000);
    expect(cuaStopStageMs("linux")).toBe(2_500);
  });
});

describe("W-Q3 (i)/(ii) the real update preparation over the win32 stage (R20, D14)", () => {
  // The real updater preparation chain main.mjs runs (prepareBackedUpInstall -> prepareUpdaterRestart -> cleanup), with
  // cleanup = the real win32 stage. The installer spy runs only when the preparation resolves, as updater.mjs does.
  const prepareUpdate = (r) => {
    return prepareBackedUpInstall(null, {
      backup: { requestUpgrade: async () => ({ status: "continue" }) },
      prepareNormal: () => prepareUpdaterRestart({
        environment: {}, isClosing: () => false, isCleanedUp: () => false,
        readActivity: async () => ({ bots: [], groups: [] }),
        cleanup: () => cuaCleanupStage({ stop: () => r.runtime.shutdown("update"), ms: cuaStopStageMs("win32"), clock: r.clock }),
      }),
    });
  };
  it("(i) the driver exits 4 s after taskkill -> the installer is invoked once, after the exit", async () => {
    const r = rig({ exitAfterMs: 4_000 });
    await r.runtime.enable();
    const child = r.spawned[0].child;
    const events = [];
    child.on("exit", () => events.push("exit"));
    const outcome = prepareUpdate(r).then(() => { events.push("installer"); }, () => { events.push("refused"); });
    await r.clock.advance(4_100);
    await outcome;
    expect(events, expect.getState().currentTestName).toEqual(["exit", "installer"]);
  });
  it("(ii) the driver never exits -> the preparation is refused, installer 0, pid retained, driver-stuck", async () => {
    const r = rig({ exitOnKill: false });
    await r.runtime.enable();
    const pid = r.spawned[0].child.pid;
    let installed = 0;
    let refusal = null;
    const outcome = prepareUpdate(r).then(() => { installed += 1; }, (error) => { refusal = error; });
    await r.clock.advance(6_100);
    await outcome;
    expect(installed, expect.getState().currentTestName).toBe(0);
    expect(refusal?.message).toMatch(/could not finish closing/);
    expect(r.memFs.files.has(ownerRecordPath)).toBe(true);
    expect(JSON.parse(r.memFs.files.get(ownerRecordPath)).pid).toBe(pid);
    expect(r.runtime.getStatus().reasonCode).toBe("driver-stuck");
  });
});

describe("W-K5 (vii)/(viii) one harness per generation (D20)", () => {
  it("(vii) a replacement harness posts -ready while G is live -> live:null, taskkill on G, live:G+1 only after G's exit", async () => {
    const r = rig({ exitAfterMs: 1_000 });
    const first = { name: "first" };
    const second = { name: "second" };
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), first);
    expect(r.posted.at(-1)).toEqual(messages.liveMessage("000000000001"));
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), second);
    await flush();
    expect(r.posted.some((m, i) => i > 0 && m.live === null)).toBe(true);
    expect(r.killed).toEqual([r.spawned[0].child.pid]);
    expect(r.posted.some((m) => m.live === "000000000002")).toBe(false);
    await r.clock.advance(1_100);
    expect(r.posted.at(-1)).toEqual(messages.liveMessage("000000000002"));
  });
  it("(viii) the SAME harness posts -ready twice in ready(G) -> live:G both times, taskkill 0", async () => {
    const r = rig();
    const only = { name: "only" };
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), only);
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), only);
    expect(r.posted.filter((m) => m.live === "000000000001")).toHaveLength(3);
    expect(r.taskkill).toHaveBeenCalledTimes(0);
  });
  it("(v-control) -ready while driver-stuck is answered live:null", async () => {
    const r = rig({ exitOnKill: false });
    await r.runtime.enable();
    const outcome = r.runtime.retry();
    await r.clock.advance(5_001);
    await outcome;
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), { name: "new" });
    expect(r.posted.at(-1)).toEqual(messages.liveMessage(null));
  });
});

describe("W-L2 the main-side host-desktop channel (R13c)", () => {
  const tracker = (initial) => {
    let state = initial;
    const listeners = [];
    return { state: () => state, refresh: vi.fn(), onChange: (fn) => { listeners.push(fn); return () => {}; }, set(next) { state = next; listeners.forEach((fn) => fn(next === "locked")); } };
  };
  it("a new server process -> refresh() called, then the current state sent", () => {
    const lock = tracker("unlocked");
    const posted = [];
    wireHostDesktop({ lock, port: { postMessage: (m) => posted.push(m) } });
    expect(lock.refresh).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([messages.hostDesktopMessage("active")]);
  });
  it("a change -> a message with the state", () => {
    const lock = tracker("unlocked");
    const posted = [];
    wireHostDesktop({ lock, port: { postMessage: (m) => posted.push(m) } });
    lock.set("locked");
    expect(posted.at(-1)).toEqual(messages.hostDesktopMessage("locked"));
  });
  it("murage:host-desktop-ready from the harness -> refresh() + state re-sent", () => {
    const lock = tracker("locked");
    const posted = [];
    const wire = wireHostDesktop({ lock, port: { postMessage: (m) => posted.push(m) } });
    wire.onReady();
    expect(lock.refresh).toHaveBeenCalledTimes(2);
    expect(posted).toEqual([messages.hostDesktopMessage("locked"), messages.hostDesktopMessage("locked")]);
  });
  it("tracker unknown -> message unknown (never active)", () => {
    const lock = tracker("unknown");
    const posted = [];
    wireHostDesktop({ lock, port: { postMessage: (m) => posted.push(m) } });
    expect(posted).toEqual([messages.hostDesktopMessage("unknown")]);
  });
});

describe("self-review fixes (pre-push Opus review of 69faa8183f)", () => {
  it("A1 -ready is answered to the harness process that asked, even before main names it as the port", async () => {
    const r = rig({ port: { postMessage() {} } });
    await r.runtime.enable();
    const asked = [];
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), { postMessage: (m) => asked.push(m) });
    expect(asked).toEqual([messages.liveMessage("000000000001")]);
  });
  it("A2 two restarts at once (Retry and a stuck report) leave exactly one new driver", async () => {
    const r = rig();
    await r.runtime.enable();
    const retry = r.runtime.retry();
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(50);
    await retry;
    await r.clock.advance(50);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(2);
  });
  it("A3 a spawn that errors (exe blocked) is start-failed, never a crash or a stuck stop", async () => {
    // a blocked exe never answers the handshake; it emits error with no pid and no exit
    const r = rig({ handshake: () => new Promise(() => {}) });
    const child = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    r.spawn.mockImplementationOnce(() => child);
    const enabling = r.runtime.enable();
    await flush();
    // an error event with no listener would throw in Electron main
    expect(child.listenerCount("error"), "the runtime listens for spawn errors").toBeGreaterThan(0);
    child.emit("error", Object.assign(new Error("blocked"), { code: "EACCES" }));
    await r.clock.advance(10);
    await enabling;
    expect(r.runtime.getStatus().reasonCode).toBe("start-failed");
  });
  it("A5 an exe that cannot be read now (busy) is start-failed, not driver-integrity", async () => {
    const r = rig({ verifyExeIdentity: async () => ({ ok: false, reason: "busy" }) });
    const status = await r.runtime.enable();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("start-failed");
  });
  it("after shutdown (quit/update) nothing starts again, whatever the card or a late IPC asks", async () => {
    const r = rig();
    await r.runtime.enable();
    const stopping = r.runtime.shutdown("quit");
    await r.clock.advance(10);
    await stopping;
    await r.runtime.enable();
    // bounded: a retry that (wrongly) stops and restarts a driver after quit settles on the fake clock
    const retrying = r.runtime.retry();
    await r.clock.advance(6_000);
    await retrying;
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
});

describe("Astra precheck fixes (6de17f422a)", () => {
  it("H1 an Enable waiting on a stop never starts a check once Disable or Quit came in meanwhile", async () => {
    const r = rig({ exitAfterMs: 1_000 });
    await r.runtime.enable();
    const firstStop = r.runtime.disable();
    const lateEnable = r.runtime.enable();
    await flush();
    const quit = r.runtime.shutdown("quit");
    await r.clock.advance(1_100);
    await Promise.all([firstStop.catch(() => {}), lateEnable, quit.catch(() => {})]);
    await r.clock.advance(100);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
  it("H2 (vi-f) a record whose start was never read, pid alive by tasklist -> UNKNOWN: driver-stuck, spawn 0, record kept", async () => {
    // processStart answers a valid start now; the record has none to compare it with
    const r = rig({ pref: true, native: { processStart: vi.fn((pid) => (pid === 777 ? "131111111111111111" : "132000000000005000")), terminateIfStart: vi.fn(() => "terminated") }, runTasklist: async () => ({ code: 0, stdout: '"cua-driver.exe","777","Console","1","10,000 K"\r\n' }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: null, generation: "00000000000f" }));
    const status = await r.runtime.initialize();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("H2 (vi-g) an owner record that is there but unreadable -> UNKNOWN: driver-stuck, spawn 0", async () => {
    const r = rig({ pref: true });
    r.memFs.files.set(ownerRecordPath, "{not json");
    const status = await r.runtime.initialize();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("H2 (vi-h) processStart null and a tasklist line that is not the exact no-match line (localized) -> UNKNOWN: driver-stuck", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "terminated") }, runTasklist: async () => ({ code: 0, stdout: "INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgefuehrt.\r\n" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    const status = await r.runtime.initialize();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
  });
  it("H3 quit/update with an unresolved leftover does not report cleanup done", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "unknown") }, runTasklist: async () => ({ code: 1, stdout: "" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    const pending = r.runtime.shutdown("update").then(() => "resolved", (error) => error.code);
    await r.clock.advance(6_000);
    const outcome = await pending;
    expect(outcome === "cua-stop-timeout", "cleanup reported incomplete").toBe(true);
  });
  it("H5 the Windows switch persists across a restart even when the file reads as mode 0o644 (as every Windows file does)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-cua-pref-"));
    try {
      createWindowsCuaPreferenceStore({ getUserData: () => dir }).write(true);
      fs.chmodSync(path.join(dir, "cua-local-control-win32.json"), 0o644);
      expect(createWindowsCuaPreferenceStore({ getUserData: () => dir }).read()).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("H6 the driver path replaced while the cursor helper is hashed -> driver-integrity, spawn 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murage-cua-win-h6-"));
    try {
      fs.mkdirSync(path.join(dir, "cua-win32-x64"));
      const driver = path.join(dir, "cua-win32-x64", "cua-driver.exe");
      const cursor = path.join(dir, "cua-win32-x64", "cua-cursor-theme.exe");
      fs.writeFileSync(driver, Buffer.alloc(4096, 7));
      fs.writeFileSync(cursor, Buffer.alloc(2048, 9));
      fs.writeFileSync(path.join(dir, "other.exe"), Buffer.alloc(4096, 1));
      const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const pins = { driver: sha(driver), cursor: sha(cursor) };
      const base = rig();
      const runtime = createWindowsCuaRuntime({
        resourcesPath: dir, runtimeDir: path.join(dir, "run"), preferenceStore: base.pref, port: { postMessage() {} },
        spawn: base.spawn, taskkill: base.taskkill, runProbe: async () => ({ code: 0, stdout: GROUP + MEDIUM }), runTasklist: async () => ({ code: 0, stdout: NO_TASKS }),
        native: base.native, pins, handshake: async () => true, fs: memoryFs(), clock: base.clock, env: {}, processId: 4242,
        verifyExeIdentity: async (file, pin) => {
          if (file === cursor) fs.renameSync(path.join(dir, "other.exe"), driver);
          return verifyExeIdentity(file, pin, defaultIdentityFs, { platform: "linux" });
        },
      });
      const status = await runtime.enable();
      expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-integrity");
      expect(base.spawn).toHaveBeenCalledTimes(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Astra precheck pass 2 fixes (12c7c19559)", () => {
  it("P2-1 a quit/update that starts while the leftover query is pending does not report cleanup done when the query fails", async () => {
    const query = gate();
    let calls = 0;
    const r = rig({ pref: true, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "unknown") },
      runTasklist: () => { calls += 1; return calls === 1 ? query.promise : Promise.resolve({ code: 1, stdout: "" }); } });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    const starting = r.runtime.initialize();
    await flush();
    expect(calls, "the leftover query is pending when the update starts").toBe(1);
    const update = r.runtime.shutdown("update").then(() => "resolved", (error) => error.code);
    await flush();
    query.release({ code: 1, stdout: "" });
    await r.clock.advance(6_000);
    await starting;
    expect((await update) === "cua-stop-timeout", "cleanup reported incomplete").toBe(true);
  });
  it("P2-1b with Local control off, an unresolved leftover at app start still blocks a clean quit/update", async () => {
    const r = rig({ pref: false, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "unknown") }, runTasklist: async () => ({ code: 1, stdout: "" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    const pending = r.runtime.shutdown("update").then(() => "resolved", (error) => error.code);
    await r.clock.advance(6_000);
    const outcome = await pending;
    expect(outcome === "cua-stop-timeout", "cleanup reported incomplete").toBe(true);
  });
  it("P2-2 a harness that asked during startup gets live:G when the driver becomes ready, before main names it as the port", async () => {
    const hs = gate();
    const r = rig({ port: { postMessage() {} }, handshake: () => hs.promise });
    const enabling = r.runtime.enable();
    await flush();
    const asked = [];
    r.runtime.onHarnessMessage(messages.hostDesktopReadyMessage(), { postMessage: (m) => asked.push(m) });
    expect(asked).toEqual([messages.liveMessage(null)]);
    hs.release(true);
    await enabling;
    expect(asked.at(-1)).toEqual(messages.liveMessage("000000000001"));
  });
  it("H1b an Enable waiting on a stop never starts a check once a Disable alone came in meanwhile", async () => {
    const r = rig({ exitAfterMs: 1_000 });
    await r.runtime.enable();
    const firstStop = r.runtime.disable();
    const lateEnable = r.runtime.enable();
    await flush();
    const secondDisable = r.runtime.disable();
    await r.clock.advance(1_100);
    await Promise.all([firstStop.catch(() => {}), lateEnable, secondDisable.catch(() => {})]);
    await r.clock.advance(100);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
  });
});

describe("Astra precheck pass 3 fix (1bae65b6cb)", () => {
  it("P3-1 a leftover first UNKNOWN, then proven gone, no longer blocks Enable (no restart needed)", async () => {
    let gone = false;
    const r = rig({ pref: false, native: { processStart: vi.fn((pid) => (pid === 777 ? null : "132000000000005000")), terminateIfStart: vi.fn(() => "unknown") },
      runTasklist: async () => (gone ? { code: 0, stdout: NO_TASKS } : { code: 1, stdout: "" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    expect(r.memFs.files.has(ownerRecordPath), "UNKNOWN at app start keeps the record").toBe(true);
    gone = true;
    await r.runtime.enable();
    expect(r.spawn, "the confirmed-gone leftover no longer blocks the driver").toHaveBeenCalledTimes(1);
  });
});

describe("BLOCK fixes on 7b894ab0dc (ASTRA retry, FABLE locale-independent absence)", () => {
  const LOCALIZED = "INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgefuehrt.\r\n";
  it("ASTRA-R1 Retry after a leftover first UNKNOWN, then proven gone, starts a fresh driver (never the stale driver-stuck)", async () => {
    let gone = false;
    const r = rig({ pref: true, native: { processStart: vi.fn((pid) => (pid === 777 ? null : "132000000000005000")), terminateIfStart: vi.fn(() => "unknown") },
      runTasklist: async () => (gone ? { code: 0, stdout: NO_TASKS } : { code: 1, stdout: "" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    const first = await r.runtime.initialize();
    expect(first.reasonCode, "UNKNOWN at app start shows driver-stuck").toBe("driver-stuck");
    expect(r.spawn, "nothing spawned over the UNKNOWN leftover").toHaveBeenCalledTimes(0);
    gone = true;
    await r.runtime.retry();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    expect(r.runtime.getStatus().reasonCode, "the card no longer says driver-stuck").not.toBe("driver-stuck");
  });
  it("ASTRA-R1 control: Retry while the leftover is still UNKNOWN stays driver-stuck, spawn 0", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn((pid) => (pid === 777 ? null : "132000000000005000")), terminateIfStart: vi.fn(() => "unknown") },
      runTasklist: async () => ({ code: 1, stdout: "" }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    const status = await r.runtime.retry();
    expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
    expect(r.spawn).toHaveBeenCalledTimes(0);
  });
  // REGRESSION GUARD, not a witness of a finding: green on 7b894ab0dc by design (the base already stayed stuck after a
  // failed stop). It pins that the ASTRA-R1 rewrite of restart() keeps that behaviour; its mutants prove the guard line.
  it("REGRESSION-GUARD ASTRA-R1: a cua-stuck restart whose stop fails (the driver never exits) starts no new check over the retained driver", async () => {
    const r = rig({ exitOnKill: false });
    await r.runtime.enable();
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(6_100);
    await flush();
    expect(r.native.terminateIfStart, expect.getState().currentTestName).toHaveBeenCalledTimes(0);
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(r.runtime.getStatus().reasonCode).toBe("driver-stuck");
  });
  it("FABLE-H1 a dead pid on a non-English Windows (localized tasklist, native says absent) -> record cleared, the driver starts", async () => {
    const r = rig({ pref: true, native: { processStart: vi.fn((pid) => (pid === 777 ? null : "132000000000005000")), terminateIfStart: vi.fn(() => "unknown"), processPresence: vi.fn((pid) => (pid === 777 ? "absent" : "present")) },
      runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    expect(r.native.processPresence).toHaveBeenCalledWith(777);
  });
  it("FABLE-H1 the same dead pid with the switch off: quit/update cleanup completes (no cua-stop-timeout)", async () => {
    const r = rig({ pref: false, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "unknown"), processPresence: vi.fn(() => "absent") },
      runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    await r.runtime.initialize();
    let error = null;
    await r.runtime.shutdown("update").catch((e) => { error = e; });
    expect(error?.code ?? null, expect.getState().currentTestName).toBeNull();
    expect(r.memFs.files.has(ownerRecordPath)).toBe(false);
  });
  // ASTRA r5 (TEST-EVIDENCE on 4e3d2628f0): the locale-independent proof is also what ends the POST-TERMINATION wait
  // (confirmGone -> gone -> provenAbsent) and the RETAINED-child check (retainedStillAlive -> provenAbsent).
  it("ASTRA-R5 post-termination confirmation on a non-English Windows: terminateIfStart terminated, then processStart null + native absent + localized tasklist -> the wait ends, the driver starts", async () => {
    let alive = true;
    const r = rig({ pref: true, native: {
      processStart: vi.fn((pid) => (pid === 777 ? (alive ? "131111111111111111" : null) : "132000000000005000")),
      terminateIfStart: vi.fn(() => { r.clock.setTimeout(() => { alive = false; }, 300); return "terminated"; }),
      processPresence: vi.fn((pid) => (pid === 777 && !alive ? "absent" : "present")),
    }, runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
    r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
    const pending = r.runtime.initialize();
    await r.clock.advance(6_100);
    const status = await pending;
    expect(r.native.terminateIfStart).toHaveBeenCalledTimes(1);
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    expect(status.reasonCode).not.toBe("driver-stuck");
    expect(JSON.parse(r.memFs.files.get(ownerRecordPath)).pid, "the old record is replaced by the fresh driver's").not.toBe(777);
  });
  it("ASTRA-R5 retained-child recovery on a non-English Windows: a driver that would not stop is later gone (processStart null, native absent, localized tasklist) -> Retry starts a fresh driver", async () => {
    let killWorks = false;
    const r = rig({ exitOnKill: false, native: { processPresence: vi.fn(() => "absent") }, runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
    r.taskkill.mockImplementation((pid) => { if (killWorks) r.spawned.find((item) => item.child.pid === pid)?.child.exit(); });
    await r.runtime.enable();
    expect(r.spawn).toHaveBeenCalledTimes(1);
    const first = r.spawned[0].child.pid;
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(6_100);
    expect(r.runtime.getStatus().reasonCode, "the unstoppable driver is retained: driver-stuck").toBe("driver-stuck");
    r.starts.delete(first); // the driver is gone now: processStart answers null, native presence answers absent
    killWorks = true;
    await r.runtime.retry();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(2);
    expect(r.runtime.getStatus().reasonCode).not.toBe("driver-stuck");
  });
  it("ASTRA-R5 control: the same retained child with native unknown and the localized line stays driver-stuck, spawn 1", async () => {
    const r = rig({ exitOnKill: false, native: { processPresence: vi.fn(() => "unknown") }, runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
    await r.runtime.enable();
    const first = r.spawned[0].child.pid;
    r.runtime.onHarnessMessage(messages.stuckMessage("000000000001"), {});
    await r.clock.advance(6_100);
    r.starts.delete(first);
    await r.runtime.retry();
    expect(r.spawn, expect.getState().currentTestName).toHaveBeenCalledTimes(1);
    expect(r.runtime.getStatus().reasonCode).toBe("driver-stuck");
  });
  for (const answer of ["unknown", "present"]) {
    it(`FABLE-H1 control: native says ${answer} with the localized line -> UNKNOWN: driver-stuck, spawn 0, record kept`, async () => {
      const r = rig({ pref: true, native: { processStart: vi.fn(() => null), terminateIfStart: vi.fn(() => "unknown"), processPresence: vi.fn(() => answer) },
        runTasklist: async () => ({ code: 0, stdout: LOCALIZED }) });
      r.memFs.files.set(ownerRecordPath, JSON.stringify({ pid: 777, start: "131111111111111111", generation: "00000000000f" }));
      const status = await r.runtime.initialize();
      expect(status.reasonCode, expect.getState().currentTestName).toBe("driver-stuck");
      expect(r.spawn).toHaveBeenCalledTimes(0);
      expect(r.memFs.files.has(ownerRecordPath)).toBe(true);
    });
  }
});
