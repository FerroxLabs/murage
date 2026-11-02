// 1.0.13 SENTINEL-WIN-WATCHER-LEAK: when the OS scheduler cannot be read back (seen on Windows Task Scheduler), the
// app falls back to a detached `--watch` watcher. A newer app start must move the schedule revision on so the older
// watcher retires; only a real prior OS registration is put back. Drives the real host, the real reconcile and the
// real `--watch` loop (server/sentinel/cli.ts) against one owner-only folder. platform "darwin" takes the same
// non-Linux fallback (the independent supervisor) that Windows takes, on POSIX paths.
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import * as boundary from "../server/health/host-boundary.ts";
import { main as sentinelCli } from "../server/sentinel/cli.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { createSentinelHost } from "./sentinel-host.mjs";
import { sentinelInvocation } from "./sentinel-schedule.mjs";

const POSIX = process.platform !== "win32";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

function installationFolders() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-sentinel-retire-")));
  roots.push(base);
  chmodSync(base, 0o700);
  const dataDir = path.join(base, "data");
  const home = path.join(base, "home");
  const userData = path.join(base, "userData");
  const app = path.join(base, "app");
  for (const dir of [dataDir, home, userData, app]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(path.join(home, "Library", "Application Support"), { recursive: true, mode: 0o700 });
  const executable = path.join(app, "Murage");
  writeFileSync(executable, "synthetic, never executed", { mode: 0o700 });
  const entrySource = path.join(app, "cli.js");
  writeFileSync(entrySource, "// entry v1\n", { mode: 0o600 });
  return { dataDir, home, userData, executable, entrySource };
}

/** An OS scheduler whose readback answers only for the revisions `readsBack` accepts (the Windows failure is none). */
function scheduler({ readsBack = () => false } = {}) {
  const installs = [];
  let registered = null;
  return {
    installs,
    async install(descriptor, descriptorPath) { installs.push(descriptor.scheduleRevision); registered = { descriptor: structuredClone(descriptor), descriptorPath }; },
    async read() {
      if (!registered || !readsBack(registered.descriptor.scheduleRevision)) return null;
      const invocation = sentinelInvocation({ platform: "darwin", descriptor: registered.descriptor, descriptorPath: registered.descriptorPath });
      return { mechanism: "launchd", registered: true, executable: invocation.executable, args: invocation.args, owner: String(process.getuid()), revision: registered.descriptor.scheduleRevision, lastResult: 0 };
    },
    async readFallback() { return null; },
    async installFallback() {},
    async remove() { return { removed: [] }; },
  };
}

/** One app start (a fresh process: no watcher of its own yet). */
async function appStart(fx, provider, watchers) {
  const host = createSentinelHost({
    platform: "darwin", dataDir: fx.dataDir, home: fx.home, userData: fx.userData, executable: fx.executable, entrySource: fx.entrySource,
    env: {}, uid: process.getuid(), loadBoundary: async () => boundary, now: () => 1_000_000, log: () => {},
    provider, probe: async () => boundary.EXIT.notProven,
    spawnWatcher: (descriptorPath, entry) => { watchers.push({ descriptorPath, entry }); return 5000 + watchers.length; },
    setInterval: () => ({}), clearInterval: () => {},
  });
  expect(await host.initialize()).toBe("ready");
  const result = await host.reconcile();
  await host.shutdown();
  return { host, result, descriptorPath: path.join(host.outputRoot, boundary.DESCRIPTOR_FILE) };
}

/** The real `--watch` loop on the descriptor as it is now; its scans are driven by hand. */
function startWatcher(descriptorPath) {
  const timers = [];
  let done = false;
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), { pid: 1, kill: () => true });
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  const running = sentinelCli([descriptorPath, "--watch"], {
    spawnChild: fakeChild, setTimer: fn => { timers.push(fn); return 0; }, untilStopped: () => new Promise(() => {}), out: () => {},
  }).then(code => { done = true; return code; });
  return {
    running,
    get retired() { return done; },
    async scan() { const next = timers.shift(); if (next) next(); await settle(); },
  };
}

const revisionOf = descriptorPath => {
  const loaded = boundary.loadDescriptor(descriptorPath);
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
  return loaded.value.scheduleRevision;
};

it.skipIf(!POSIX)("a failed readback after the watcher fallback moves the revision on, so the older watcher retires", async () => {
  const fx = installationFolders();
  const provider = scheduler();
  const watchers = [];

  const first = await appStart(fx, provider, watchers);
  expect(first.result).toMatchObject({ state: "registration-needed", mechanism: "supervisor", reason: "readback" });
  expect(watchers).toHaveLength(1);
  const oldRevision = revisionOf(first.descriptorPath);
  const oldWatcher = startWatcher(first.descriptorPath);
  await settle();
  await oldWatcher.scan();
  expect(oldWatcher.retired).toBe(false);

  // The update: a new entry, a new app process, and the scheduler readback fails again.
  writeFileSync(fx.entrySource, "// entry v2\n");
  const second = await appStart(fx, provider, watchers);
  expect(second.result).toMatchObject({ state: "registration-needed", mechanism: "supervisor", reason: "readback" });

  // Two scans on the moved revision and the older watcher is gone.
  await oldWatcher.scan();
  await oldWatcher.scan();
  expect({ revisionMovedOn: revisionOf(second.descriptorPath) > oldRevision, oldWatcherRetired: oldWatcher.retired })
    .toEqual({ revisionMovedOn: true, oldWatcherRetired: true });
  expect(await oldWatcher.running).toBe(boundary.EXIT.ok);
  // The new app runs one watcher of its own, on the new entry.
  expect(watchers).toHaveLength(2);
  expect(watchers[1].entry).not.toBe(watchers[0].entry);
  expect(watchers[1].entry).toBe(boundary.loadDescriptor(second.descriptorPath).value.executable.entry);
});

it.skipIf(!POSIX)("a failed readback on a real prior OS registration still puts that registration and its descriptor back", async () => {
  const fx = installationFolders();
  const provider = scheduler({ readsBack: revision => revision === 1 });
  const watchers = [];

  const first = await appStart(fx, provider, watchers);
  expect(first.result).toMatchObject({ state: "registered", mechanism: "launchd", revision: 1 });
  expect(watchers).toHaveLength(0);

  writeFileSync(fx.entrySource, "// entry v2\n");
  const second = await appStart(fx, provider, watchers);
  expect(second.result.reason).toBe("readback");
  expect(revisionOf(second.descriptorPath)).toBe(1);
  expect(provider.installs).toEqual([1, 2, 1]);
});
