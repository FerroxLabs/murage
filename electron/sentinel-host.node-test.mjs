// The desktop Sentinel host (1.0.9): health/ initialized through the bundled producer boundary before capture, the
// closed-app run never creating the root, the desktop producer and backup manifest, registration with a host status
// file, the host-side heartbeat note, native page delivery through the adapter, move reconciliation, and quitting
// that never unregisters. Needs `pnpm build:server` (dist-server/health/host-boundary.js).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { HEARTBEAT_STALE_MS, PAGE_NOTIFICATION, SENTINEL_HOST_STATUS_FILE, SENTINEL_LAST_INSTALLATION_FILE, createSentinelHost } from "./sentinel-host.mjs";
import { sentinelInvocation } from "./sentinel-schedule.mjs";

const POSIX_ONLY = process.platform === "win32" && "owner uid and mode checks are POSIX-only";
const boundaryPath = path.join(import.meta.dirname, "..", "dist-server", "health", "host-boundary.js");
const boundary = await import(pathToFileURL(boundaryPath).href);
// The producer's window clock is Date.now: a start and stop inside one millisecond have no window to flush.
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });

function rig({ closed = false, captureActive = () => false, provider, probe, delivery, Notification, spawnWatcher, bindingCurrent, now = () => 1_000_000, boundaryOverride } = {}) {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-sentinel-host-")));
  roots.push(base);
  chmodSync(base, 0o700);
  const dataDir = path.join(base, "data");
  const home = path.join(base, "home");
  const userData = path.join(base, "userData");
  const app = path.join(base, "app");
  for (const dir of [dataDir, home, userData, app]) mkdirSync(dir, { mode: 0o700 });
  const executable = path.join(app, "Murage");
  writeFileSync(executable, "synthetic, never executed", { mode: 0o700 });
  const entrySource = path.join(app, "cli.js");
  writeFileSync(entrySource, "// entry\n", { mode: 0o600 });
  const logs = [];
  const host = createSentinelHost({
    platform: "linux", dataDir, home, userData, executable, entrySource, env: { XDG_STATE_HOME: path.join(base, "state") }, uid: process.getuid?.(),
    loadBoundary: async () => boundaryOverride ?? boundary, closed, captureActive, now, log: line => logs.push(line),
    provider: provider ?? fakeProvider(), probe: probe ?? (async () => boundary.EXIT.notProven), delivery, Notification,
    spawnWatcher: spawnWatcher ?? (() => 4242), bindingCurrent,
    setInterval: () => ({}), clearInterval: () => {},
  });
  return { base, dataDir, home, userData, host, logs, health: path.join(dataDir, "health") };
}

function fakeProvider({ installFails = null } = {}) {
  const calls = { install: [], remove: [] };
  let registered = null;
  return {
    calls,
    async install(descriptor, descriptorPath) {
      calls.install.push(descriptor.scheduleRevision);
      if (installFails) throw Object.assign(new Error("refused"), { code: installFails });
      registered = { descriptor: structuredClone(descriptor), descriptorPath };
    },
    async read() {
      if (!registered) return null;
      const invocation = sentinelInvocation({ platform: "linux", descriptor: registered.descriptor, descriptorPath: registered.descriptorPath });
      return { mechanism: "systemd", registered: true, executable: invocation.executable, args: invocation.args, owner: "1", revision: registered.descriptor.scheduleRevision, lastResult: null };
    },
    async readFallback() { return null; },
    async installFallback() {},
    async remove(id) { calls.remove.push(id); return { removed: [] }; },
  };
}

test("initialize creates the owner-only health/ root through the bundled boundary and names the shared installation id", { skip: POSIX_ONLY }, async () => {
  const fx = rig();
  assert.equal(await fx.host.initialize(), "ready");
  const stat = lstatSync(fx.health);
  assert.ok(stat.isDirectory());
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(fx.host.installationId, boundary.sentinelInstallationId(realpathSync.native(fx.dataDir)));
  assert.equal(fx.host.outputRoot, path.join(fx.base, "state", "MurageSentinel", fx.host.installationId));
  await settle(); await fx.host.shutdown();
  // The desktop producer flushed a boot window on its own segment only.
  assert.deepEqual(readdirSync(fx.health).filter(name => name.endsWith(".ndjson")), ["desktop.current.ndjson"]);
  const lines = readFileSync(path.join(fx.health, "desktop.current.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(lines.every(window => window.producer === "desktop" && window.installationId === fx.host.installationId));
  assert.ok(lines.some(window => window.counters.some(row => row.detector === "coverage" && row.code === "boot")));
  assert.ok(lines.some(window => window.counters.some(row => row.detector === "coverage" && row.code === "shutdown")));
});

test("a capture in progress keeps an absent root absent (membership stays as the capture began)", { skip: POSIX_ONLY }, async () => {
  const fx = rig({ captureActive: () => true });
  assert.equal(await fx.host.initialize(), "publication-deferred");
  assert.equal(existsSync(fx.health), false);
});

test("a closed-app run never creates the root, uses an existing one, and starts no producer or registration", { skip: POSIX_ONLY }, async () => {
  const absent = rig({ closed: true });
  assert.equal(await absent.host.initialize(), "publication-deferred");
  assert.equal(existsSync(absent.health), false);
  const provider = fakeProvider();
  const present = rig({ closed: true, provider });
  mkdirSync(present.health, { mode: 0o700 });
  assert.equal(await present.host.initialize(), "ready");
  await present.host.reconcile();
  present.host.startBackground();
  await present.host.shutdown();
  assert.deepEqual(provider.calls.install, []);
  assert.deepEqual(readdirSync(present.health), []);
});

test("an unloadable boundary leaves the app running with health checks waiting", async () => {
  const host = createSentinelHost({ platform: "linux", dataDir: "/nonexistent", loadBoundary: async () => { throw new Error("missing"); }, home: "/h" });
  assert.equal(await host.initialize(), "absent");
  assert.equal(host.diagnosticsSummary().available, false);
});

test("backup commits publish the manifest after the commit and count desktop transitions", { skip: POSIX_ONLY }, async () => {
  const fx = rig();
  await fx.host.initialize();
  const schedule = { enabled: false, installationRef: "homefolderref", destinationRef: "usbdriveref", recoveryRef: "keyfileref", timezone: "UTC", time: "09:00", catchupMs: 21_600_000, maxBytes: 100_000_000, maxDurationMs: 60_000, selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } };
  const status = fx.host.backupCommitted({ version: 1, revision: 1, configuredAt: 0, schedule, seen: [], watermark: 0 });
  assert.ok(status, "a manifest was published");
  const manifest = JSON.parse(readFileSync(path.join(fx.health, "backup-status.json"), "utf8"));
  assert.equal(manifest.installationId, fx.host.installationId);
  assert.equal(manifest.enabled, false);
  assert.equal(fx.host.backupCommitted(null), null, "a malformed state never throws");
  await settle(); await fx.host.shutdown();
  const windows = readFileSync(path.join(fx.health, "desktop.current.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(windows.some(window => window.counters.some(row => row.detector === "backup")), "a backup transition count");
});

test("reconcile registers, writes host-status.json with enums only, and counts registration and schedule-ok", { skip: POSIX_ONLY }, async () => {
  const provider = fakeProvider();
  const fx = rig({ provider });
  await fx.host.initialize();
  const result = await fx.host.reconcile();
  assert.equal(result.state, "registered", fx.logs.join("\n"));
  assert.equal(lstatSync(path.join(fx.base, "state")).mode & 0o777, 0o700, "a missing XDG state folder is created owner-only");
  assert.deepEqual(provider.calls.install, [1]);
  const status = JSON.parse(readFileSync(path.join(fx.host.outputRoot, SENTINEL_HOST_STATUS_FILE), "utf8"));
  assert.deepEqual(Object.keys(status).sort(), ["at", "heartbeat", "heartbeatAt", "installationId", "mechanism", "registration", "rootState", "version"]);
  assert.equal(status.registration, "registered");
  assert.equal(status.mechanism, "systemd");
  assert.equal(lstatSync(path.join(fx.host.outputRoot, SENTINEL_HOST_STATUS_FILE)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(status).includes(fx.base), "no path");
  await settle(); await fx.host.shutdown();
  const windows = readFileSync(path.join(fx.health, "desktop.current.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const codes = windows.flatMap(window => window.counters.filter(row => row.detector === "coverage").map(row => row.code));
  assert.ok(codes.includes("registration") && codes.includes("schedule-ok"), codes.join(","));
});

test("an OS refusal falls back to the independent supervisor (Linux autostart) and starts it once", { skip: POSIX_ONLY }, async () => {
  let spawned = 0;
  const provider = { ...fakeProvider({ installFails: "SENTINEL_NO_USER_MANAGER" }), installFallback: async () => {}, readFallback: async () => null };
  const fx = rig({ provider, spawnWatcher: () => { spawned++; return 777; } });
  await fx.host.initialize();
  const result = await fx.host.reconcile();
  assert.deepEqual({ state: result.state, mechanism: result.mechanism }, { state: "registered", mechanism: "autostart" });
  await fx.host.reconcile();
  assert.equal(spawned, 1, "never a second supervisor in one session");
});

test("Linux: once the systemd timer is proven, the autostart fallback entry is removed, once", { skip: POSIX_ONLY }, async () => {
  const removed = [];
  const provider = { ...fakeProvider(), async removeFallback(id) { removed.push(id); return { removed: [] }; } };
  const proven = { ...boundary, checkInstall: async () => ({ descriptor: "ok", installationId: null, registrations: [{ matches: true }], heartbeatAt: 2_000_000, heartbeatAgeMs: 0, heartbeatFresh: true, scanner: null, state: "proven" }) };
  const fx = rig({ provider, boundaryOverride: proven });
  await fx.host.initialize();
  assert.equal((await fx.host.reconcile()).mechanism, "systemd");
  await fx.host.check();
  await fx.host.check();
  assert.deepEqual(removed, [fx.host.installationId]);
  await settle(); await fx.host.shutdown();
});

test("the host notes a heartbeat older than 30 minutes while awake, once, and not right after a resume", { skip: POSIX_ONLY }, async () => {
  let clock = 1_000_000;
  const fx = rig({ now: () => clock });
  await fx.host.initialize();
  await fx.host.reconcile();
  assert.equal((await fx.host.check()).state, "waiting", "no heartbeat yet, awake under 30 minutes");
  clock += HEARTBEAT_STALE_MS;
  assert.equal((await fx.host.check()).state, "stale");
  await fx.host.check();
  fx.host.suspend();
  clock += 60 * 60_000;
  fx.host.resume();
  assert.equal((await fx.host.check()).state, "waiting", "the awake clock restarts at resume");
  const status = JSON.parse(readFileSync(path.join(fx.host.outputRoot, SENTINEL_HOST_STATUS_FILE), "utf8"));
  assert.equal(status.heartbeat, "waiting");
  await settle(); await fx.host.shutdown();
  const windows = readFileSync(path.join(fx.health, "desktop.current.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const failed = windows.flatMap(window => window.counters.filter(row => row.detector === "coverage" && row.code === "schedule-failed"));
  assert.equal(failed.reduce((sum, row) => sum + row.value, 0), 1, "noted once per stale stretch");
});

test("pages: one claim, one notification with generic lock-screen text, then an ack", { skip: POSIX_ONLY }, async () => {
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() {}
    show() { shown.push(this.options); }
  }
  const acks = [];
  const queue = [{ deliveryId: "d-1", titleKey: "S01", bodyKey: "no-verified-backup" }];
  const delivery = { claimNextPage: async () => queue.shift() ?? null, ack: async (id, outcome) => { acks.push([id, outcome]); } };
  const fx = rig({ delivery, Notification: FakeNotification });
  await fx.host.initialize();
  assert.equal(await fx.host.deliverPages(), "delivered");
  assert.equal(await fx.host.deliverPages(), null);
  assert.deepEqual(shown, [{ title: PAGE_NOTIFICATION.title, body: PAGE_NOTIFICATION.body, silent: false }]);
  assert.deepEqual(acks, [["d-1", "delivered"]]);
  for (const text of [PAGE_NOTIFICATION.title, PAGE_NOTIFICATION.body]) {
    assert.ok(!/—/.test(text) && !/\b(safe|unsafe|safety)\b/i.test(text), "copy rules");
  }
});

test("pages: a notification that cannot show is acknowledged as suppressed; a failed claim or ack never re-sends", { skip: POSIX_ONLY }, async () => {
  const acks = [];
  class Broken { static isSupported() { return true; } constructor() { throw new Error("no notifications"); } }
  const fx = rig({ Notification: Broken, delivery: { claimNextPage: async () => ({ deliveryId: "d-2", titleKey: "S02", bodyKey: "x" }), ack: async (id, outcome) => { acks.push([id, outcome]); } } });
  await fx.host.initialize();
  assert.equal(await fx.host.deliverPages(), "suppressed");
  assert.deepEqual(acks, [["d-2", "suppressed"]]);
  const claims = [];
  const failing = rig({ Notification: Broken, delivery: { claimNextPage: async () => { claims.push(1); throw new Error("server down"); }, ack: async () => { throw new Error("never"); } } });
  await failing.host.initialize();
  assert.equal(await failing.host.deliverPages(), null);
  const odd = rig({ delivery: { claimNextPage: async () => ({ deliveryId: "bad id with spaces", titleKey: "x", bodyKey: "y" }), ack: async () => { throw new Error("never called"); } } });
  await odd.host.initialize();
  assert.equal(await odd.host.deliverPages(), null);
});

test("a moved installation removes only the previous installation's registration, once", { skip: POSIX_ONLY }, async () => {
  const provider = fakeProvider();
  const fx = rig({ provider });
  const previous = "fedcba9876543210fedcba9876543210";
  writeFileSync(path.join(fx.userData, SENTINEL_LAST_INSTALLATION_FILE), JSON.stringify({ version: 1, installationId: previous }));
  await fx.host.initialize();
  await fx.host.reconcile();
  await fx.host.reconcile();
  assert.deepEqual(provider.calls.remove, [previous]);
  assert.equal(JSON.parse(readFileSync(path.join(fx.userData, SENTINEL_LAST_INSTALLATION_FILE), "utf8")).installationId, fx.host.installationId);
});

test("quitting flushes and never unregisters; diagnostics carry enums and counts only", { skip: POSIX_ONLY }, async () => {
  const provider = fakeProvider();
  const fx = rig({ provider });
  await fx.host.initialize();
  await fx.host.reconcile();
  fx.host.startBackground();
  await settle(); await fx.host.shutdown();
  assert.deepEqual(provider.calls.remove, []);
  const summary = fx.host.diagnosticsSummary();
  assert.deepEqual(Object.keys(summary).sort(), ["available", "heartbeat", "heartbeatAgeMinutes", "mechanism", "pagesShown", "registration", "revision", "rootDeferred", "rootState"]);
  assert.ok(!JSON.stringify(summary).includes(fx.base));
});

test("electron/main.mjs: health/ is initialized after the data owner and before the backup host, on both paths", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
  assert.match(main, /acquireDesktopDataOwner\(\);closedTrace\("owner"\);await initializeSentinelHost\(\{closed:true\}\);await initializeBackupScheduleHost\(\);/);
  assert.match(main, /if \(app\.isPackaged\) \{ acquireDesktopDataOwner\(\); await initializeSentinelHost\(\); \}\n\s*await initializeBackupScheduleHost\(\);/);
  assert.match(main, /new BackupCoordinator\(\{stateDirectory,onCommitted:state=>sentinelHost\?\.backupCommitted\(state\)\}\)/);
  // A restart or an upgrade republishes the committed backup state once the backup host (its folder/key check) exists.
  const created = main.indexOf("backupScheduleHost=createBackupScheduleHost(");
  const republished = main.indexOf("sentinelHost?.backupCommitted(coordinator.committedState())");
  assert.ok(created > 0 && republished > created, "the committed backup state is republished after the backup host is created");
  assert.ok(!/removeRegistration\(/.test(main), "nothing in the app's lifecycle unregisters Sentinel");
});

test("S01: each backup commit publishes the live folder/key answer, unknown only when it cannot be checked", { skip: POSIX_ONLY }, async () => {
  const schedule = { enabled: true, installationRef: "homefolderref", destinationRef: "usbdriveref", recoveryRef: "keyfileref", timezone: "UTC", time: "09:00", catchupMs: 21_600_000, maxBytes: 100_000_000, maxDurationMs: 60_000, selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } };
  const lastVerified = { installationRef: "homefolderref", destinationRef: "usbdriveref", verifiedAt: 999_000, snapshotId: "snapshot-1", bytes: 10, jobId: "a".repeat(64), artifactRef: "a".repeat(64) };
  const state = revision => ({ version: 1, revision, configuredAt: 500_000, schedule, seen: [], watermark: 0, lastVerified });
  const read = fx => JSON.parse(readFileSync(path.join(fx.health, "backup-status.json"), "utf8"));
  let answer = true;
  const fx = rig({ bindingCurrent: async () => { if (answer instanceof Error) throw answer; return answer; } });
  await fx.host.initialize();
  assert.ok(await fx.host.backupCommitted(state(1)), "a manifest was published");
  assert.equal(read(fx).currentBindingMatches, true, "the folder and key in use are the verified ones");
  answer = false;
  await fx.host.backupCommitted(state(2));
  assert.equal(read(fx).currentBindingMatches, false, "a changed folder or key is not current protection");
  answer = new Error("store unavailable");
  await fx.host.backupCommitted(state(3));
  assert.equal(read(fx).currentBindingMatches, null, "a check that cannot run is unknown");
  assert.equal(read(fx).coverage, "partial");
  // Two commits in a row publish in order: the newest state is the one on disk.
  answer = true;
  const first = fx.host.backupCommitted(state(4));
  const second = fx.host.backupCommitted(state(5));
  await Promise.all([first, second]);
  assert.equal(read(fx).policyRevision, 5);
  assert.equal(read(fx).currentBindingMatches, true);
  await settle(); await fx.host.shutdown();
});

test("main.mjs passes the backup host's live binding check to the Sentinel host", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
  assert.match(main, /bindingCurrent:async\(\)=>backupScheduleHost\?backupScheduleHost\.bindingCurrent\(\):null/);
});

test("one delivery owner: main.mjs never injects the host's page adapter, so only the server claims pages", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
  const start = main.indexOf("sentinelHost=createSentinelHost({");
  assert.ok(start > 0, "main.mjs creates the Sentinel host");
  const end = main.indexOf("});", start);
  const call = main.slice(start, end);
  assert.doesNotMatch(call, /\bdelivery\s*:/, "no delivery adapter is passed");
  assert.doesNotMatch(main, /claimNextPage/, "main.mjs never claims a page itself");
});
