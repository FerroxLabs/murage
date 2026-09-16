import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EventEmitter } from "node:events";
const rawSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const writerBarrier = '  await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");';
const control = process.env.MURAGE_RECOVERY_CONTROL === "skip-writer-wait";
if (control) assert.ok(rawSource.includes(writerBarrier));
const source = control ? rawSource.replace(writerBarrier, "") : rawSource;
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = () => new Promise(resolve => setImmediate(resolve));

function encryptedSeparateFixture(change = () => {}) {
  const events = [], root = "/owned/original";
  const original = { utilityServerLeaseEnvironment: () => { if(state.originalLeaseFailed)throw Error("lost-original");events.push("check-original"); } };
  const target = { utilityServerLeaseEnvironment: () => { if(state.targetLeaseFailed)throw Error("lost-target");events.push("check-target"); }, release: () => events.push("release-target") };
  const state = { owner: original, root, shutdown: false, inode: 1 };
  const scope = {
    desktopRecoveryMode: true, desktopDataOwner: original, desktopDataDir: root, desktopShutdownStarted: false,
    fs: { lstatSync: () => ({ dev: 1, ino: state.inode, isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: () => root },
    requireDesktopBackupTool: async () => {},
    allocateSeparateInstallation: plan => ({ ...plan, dataDirectory: "/owned/new" }),
    acquireDataDirLease: () => target,
    runDesktopRecovery: async () => { await change(state); events.push("worker-exited"); return { ok: true, archiveSha256: "a".repeat(64) }; },
    loadMemoryRestore: async () => ({ mergeOriginalMemoryDeletions: (from, to) => {
      assert.equal(from, root); assert.equal(to, "/owned/new"); events.push("merge");
      if (state.mergeError) throw new Error("merge-failed");
    } }),
    publishInstallationSelection: () => events.push("publish"),
  };
  const loader='await import(pathToFileURL(path.join(process.resourcesPath,"server","memory","restore.js")).href)';
  let body=between("async function runEncryptedSeparateDesktopRecovery(", "async function runDesktopRecovery(");
  assert.equal(body.split(loader).length,2);
  body=body.replace(loader,"await loadMemoryRestore()");
  const keys=Object.keys(scope).filter(k=>!["desktopDataOwner","desktopDataDir","desktopShutdownStarted"].includes(k));
  body=body.replaceAll("desktopDataOwner","state.owner").replaceAll("desktopDataDir","state.root").replaceAll("desktopShutdownStarted","state.shutdown");
  const run=new Function(...keys,"state","let retainedSeparateDirectory=null;"+body+";return runEncryptedSeparateDesktopRecovery;")(...keys.map(k=>scope[k]),state);
  return { events, run: (originalRoot=root) => run({}, {originalRoot}) };
}
test("encrypted separate restore merges current deletions after worker exit and before selection",async()=>{
  const f=encryptedSeparateFixture();await f.run();
  assert.ok(f.events.indexOf("worker-exited")<f.events.indexOf("merge"));
  assert.ok(f.events.indexOf("merge")<f.events.indexOf("publish"));
  assert.equal(f.events.at(-1),"release-target");
  assert.equal(f.events.filter(x=>x==="check-target").length,2);
});
test("encrypted separate restore cannot publish after failed merge or changed original ownership",async()=>{
  for(const change of [s=>{s.mergeError=true;},s=>{s.owner={};},s=>{s.root="/foreign";},s=>{s.shutdown=true;},s=>{s.inode=2;},s=>{s.originalLeaseFailed=true;},s=>{s.targetLeaseFailed=true;}]){
    const f=encryptedSeparateFixture(change);await assert.rejects(f.run());
    assert.equal(f.events.includes("publish"),false);assert.equal(f.events.at(-1),"release-target");
  }
  const f=encryptedSeparateFixture();await assert.rejects(f.run("/foreign"));
  assert.equal(f.events.includes("worker-exited"),false);
});
test("encrypted separate restore waits for actual worker completion before touching the ledger",async()=>{
  const stopped=deferred(),f=encryptedSeparateFixture(()=>stopped.promise),pending=f.run();
  await pause();assert.equal(f.events.includes("merge"),false);assert.equal(f.events.includes("publish"),false);
  stopped.resolve();await pending;assert.equal(f.events.filter(x=>x==="merge").length,1);
});

function fixture({ writes = [], stop = async () => {}, mode = true, owned = true, separateAvailable = false } = {}) {
  let forks = 0, releases = 0, captured;
  const scope = {
    desktopRecoveryMode: mode, desktopShutdownStarted: false, desktopDataDir: "/owned/installation",
    desktopDataOwner: owned ? { release: () => { releases++; }, utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "private-owned-capability" }) } : null,
    canRestoreSeparateInstallation: () => separateAvailable,
    desktopStartup: Promise.resolve(), ownedServerChildren: new Set([{ stop }]), credentialWrites: new Set(writes), companionStarts: new Set(),
    browserLifecycleCleanups: new Map(), browserSurface: null, browserHost: null, cuaReady: Promise.resolve(),
    awaitOwnedWork: promise => promise, stopDesktopCompanion: async () => {}, stopCua: async () => {},
    process: { resourcesPath: "/package", env: { PATH: "/runtime", HOME: "/fixture", FLUX_API_KEY: "private-provider-canary", MURAGE_INTERNAL_DATA_DIR_LEASE: "forged-ambient" } }, path,
    utilityProcess: { fork() {} }, trackOwnedServerChild() {},
    runInstallationRecoveryWorker: async options => { forks++; captured = options; return { ok: true }; },
  };
  const body = between("async function runDesktopRecovery(", "function initializeBackgroundLifecycle()");
  const run = new Function(...Object.keys(scope), "let serverProc = {}; " + body + "; return runDesktopRecovery;")(...Object.values(scope));
  return { run, forks: () => forks, releases: () => releases, captured: () => captured };
}
test("actual recovery supervisor waits for admitted writers and retains primary ownership", async () => {
  const child = deferred(), write = deferred();
  const f = fixture({ writes: [write.promise], stop: () => child.promise });
  const run = f.run("backup", { output: "/chosen/new.zip" });
  await pause(); assert.equal(f.forks(), 0);
  child.resolve(); await pause(); assert.equal(f.forks(), 0);
  write.resolve(); await run;
  assert.equal(f.forks(), 1); assert.equal(f.releases(), 0);
  assert.deepEqual(f.captured().args, ["backup", "--data-dir", "/owned/installation", "--output", "/chosen/new.zip"]);
  assert.equal(f.captured().env.FLUX_API_KEY, undefined);
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, "private-owned-capability");
});
test("foreign ownership permits only archive planning or a separately supplied owned target", async () => {
  const f = fixture({ owned: false, separateAvailable: true });
  await assert.rejects(f.run("backup", { output: "/chosen/new.zip" }));
  await f.run("plan-restore", { archive: "/chosen/backup.zip" });
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, undefined);
  await f.run("restore", { archive: "/chosen/backup.zip", sha256: "a".repeat(64) }, {
    dataDirectory: "/new-owned/data", owner: { utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "new-target-only" }) },
  });
  assert.deepEqual(f.captured().args, ["restore", "--data-dir", "/new-owned/data", "--archive", "/chosen/backup.zip", "--sha256", "a".repeat(64)]);
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, "new-target-only");
  assert.equal(f.captured().env.FLUX_API_KEY, undefined);
});
test("startup selects before leasing and excludes selected roots from legacy migration", () => {
  const body = between("function acquireDesktopDataOwner()", "function ownedDesktopDataDir()");
  const calls = [];
  const scope = { assertDesktopStartupActive() {}, app: { isPackaged: true, getPath: key => "/fixture/" + key }, process: { env: {} }, path,
    dataDirLeasePaths: value => ({ canonicalDataDir: value }), resolveInstallationSelection: (userData, requested) => { calls.push([userData, requested]); return { dataDirectory: "/new/data", selected: true }; },
    acquireDataDirLease: value => { calls.push(value); return {}; } };
  new Function(...Object.keys(scope), "let desktopDataOwner=null,desktopDataDir=null,desktopRequestedDataDir=null,desktopSelectionActive=false;" + body + ";acquireDesktopDataOwner();")(...Object.values(scope));
  assert.deepEqual(calls, [["/fixture/userData", path.join("/fixture/home", ".murage")], "/new/data"]);
  assert.ok(source.includes('enabled: process.env.MURAGE_DATA_DIR === undefined && !desktopSelectionActive'));
});
test("separate supervisor publishes only after worker completion and releases only its new lease", async () => {
  const child = deferred(), events = [], plan = { dataDirectory: "/new/data" }, result = { ok: true, operation: "restore" };
  const owner = { release: () => events.push("release-new") };
  const scope = { canRestoreSeparateInstallation: () => true, allocateSeparateInstallation: value => { assert.equal(value, plan); return value; },
    acquireDataDirLease: value => { assert.equal(value, "/new/data"); return owner; },
    runDesktopRecovery: async (operation, parameters, authority) => { assert.equal(operation, "restore"); assert.equal(authority.owner, owner); await child.promise; return result; },
    publishInstallationSelection: (allocated, completed) => { assert.equal(allocated, plan); assert.equal(completed, result); events.push("publish"); }, desktopShutdownStarted: false, desktopDataDir: "/foreign/original" };
  const body = between("async function runSeparateDesktopRecovery(", "async function runDesktopRecovery(");
  const run = new Function(...Object.keys(scope), "let retainedSeparateDirectory=null;" + body + ";return runSeparateDesktopRecovery;")(...Object.values(scope));
  const pending = run({ archive: "/chosen/backup.zip", sha256: "a".repeat(64) }, plan);
  await pause(); assert.deepEqual(events, []);
  child.resolve(); assert.equal((await pending).retainedOriginal, "/foreign/original");
  assert.deepEqual(events, ["publish", "release-new"]);
});
test("normal mode and incomplete writer cleanup cannot fork a recovery worker", async () => {
  const normal = fixture({ mode: false });
  await assert.rejects(normal.run("rollback", {})); assert.equal(normal.forks(), 0);
  const held = fixture({ stop: async () => { throw new Error("still live"); } });
  await assert.rejects(held.run("rollback", {}), /still live/);
  assert.equal(held.forks(), 0); assert.equal(held.releases(), 0);
});
test("actual failed-server branch returns before background account work", async () => {
  const body = between('  if (app.isPackaged && !serverReady) {', '  if (serverReady && companionEnabledAtRest())');
  const events = [];
  const run = new Function("app", "serverReady", "serverStartConflictOnly", "showDesktopRecovery", "events", body + ';events.push("background");');
  run({ isPackaged: true }, false, false, reason => events.push(reason), events);
  assert.deepEqual(events, ["STARTUP_FAILED"]);
});
test("actual packaged early startup rejection opens recovery without exposing private error text", async () => {
  const body = between("void desktopStartup.catch((error) => {", 'app.on("window-all-closed"');
  const calls = [];
  const startup = Promise.reject(new Error("PRIVATE_CREDENTIAL_CANARY"));
  const scope = { desktopStartup: startup, desktopShutdownStarted: false, closedBackupRequested: false, app: { isPackaged: true, quit: () => calls.push("quit") }, slog: value => calls.push(value), dialog: { showErrorBox: () => calls.push("error-box") }, showDesktopRecovery: code => calls.push(code) };
  await new Function(...Object.keys(scope), body + "; return desktopStartup.catch(()=>{});")(...Object.values(scope));
  assert.equal(calls.includes("STARTUP_FAILED"), true);
  assert.equal(calls.includes("quit"), false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_CREDENTIAL_CANARY"), false);
});
test("actual startup catch forwards foreign ownership code without private error text", async () => {
  const body = between("void desktopStartup.catch((error) => {", 'app.on("window-all-closed"');
  const calls = [];
  const startup = Promise.reject(Object.assign(new Error("PRIVATE_ERROR_CANARY"), { name: "DataDirLeaseError", code: "LEASE_FOREIGN_HOST" }));
  const scope = { desktopStartup: startup, desktopShutdownStarted: false, closedBackupRequested: false, app: { isPackaged: true, quit: () => calls.push("quit") }, slog: value => calls.push(value), dialog: { showErrorBox: () => calls.push("error-box") }, showDesktopRecovery: code => calls.push(code) };
  await new Function(...Object.keys(scope), body + "; return desktopStartup.catch(()=>{});")(...Object.values(scope));
  assert.equal(calls.includes("LEASE_FOREIGN_HOST"), true);
  assert.equal(calls.includes("STARTUP_FAILED"), false);
  assert.equal(calls.includes("quit"), false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_ERROR_CANARY"), false);
});
test("failed acquisition retains location for diagnostics without granting ownership", () => {
  const body = between("function acquireDesktopDataOwner()", "function ownedDesktopDataDir()");
  const scope = { assertDesktopStartupActive() {}, app: { isPackaged: true, getPath: () => "/fixture/home" }, process: { env: { MURAGE_DATA_DIR: "/chosen/data" } }, path,
    dataDirLeasePaths: () => ({ canonicalDataDir: "/canonical/data" }), resolveInstallationSelection: (_user, data) => ({ dataDirectory: data, selected: false }), acquireDataDirLease: () => { throw Object.assign(new Error("foreign"), { code: "LEASE_FOREIGN_HOST" }); } };
  const result = new Function(...Object.keys(scope), "let desktopDataDir=null,desktopDataOwner=null,desktopRequestedDataDir=null,desktopSelectionActive=false;" + body + ";try{acquireDesktopDataOwner();}catch{}return {desktopDataDir,desktopDataOwner};")(...Object.values(scope));
  assert.deepEqual(result, { desktopDataDir: "/canonical/data", desktopDataOwner: null });
});
test("actual snapshot supervisor owns only the capture clone and restores its validated archive", async () => {
  const events = [], app = new EventEmitter(), window = new EventEmitter(); app.getPath = () => "/desktop";
  const captureDirectory = path.join("/desktop", "recovery-capture-fixture");
  const plan = { id: "fixture", dataDirectory: "/desktop/new/data" };
  const scope = { canCaptureSeparateInstallation: () => true, app, recoveryWindow: window, AbortController, fs: { existsSync: () => false }, path,
    desktopRequestedDataDir: "/foreign/original", desktopDataDir: "/foreign/original", planSeparateInstallation: () => plan,
    dataDirLeasePaths: () => ({ leasePath: "/foreign/.murage-data-owner-source.lease" }), process: { resourcesPath: "/resources", env: { PATH: "/runtime", SECRET: "excluded" } }, spawn() {},
    captureRecoveryCopy: async options => { assert.equal(options.source, "/foreign/original"); assert.equal(options.env.SECRET, undefined); assert.equal(await options.confirm({ destination: options.destination }), true); events.push("capture"); return { directory: options.destination }; },
    acquireDataDirLease: value => { assert.equal(value, captureDirectory); events.push("lease-clone"); return { release: () => events.push("release-clone") }; },
    runDesktopRecovery: async (operation, parameters, authority) => { assert.equal(operation, "backup"); assert.equal(authority.dataDirectory, captureDirectory); assert.equal(parameters.output, `${captureDirectory}.zip`); events.push("archive"); return { sha256: "a".repeat(64) }; },
    runSeparateDesktopRecovery: async (parameters, chosen, signal) => { assert.equal(chosen, plan); assert.equal(parameters.sha256, "a".repeat(64)); assert.equal(signal.aborted, false); events.push("restore-select"); return { status: "restored-review-required" }; } };
  const body = between("async function runSnapshotDesktopRecovery(", "async function runSeparateDesktopRecovery(");
  const run = new Function(...Object.keys(scope), "let retainedSeparateDirectory=null;" + body + ";return runSnapshotDesktopRecovery;")(...Object.values(scope));
  await run(async preview => { assert.equal(preview.installation, plan.dataDirectory); events.push("confirm"); return true; });
  assert.deepEqual(events, ["confirm", "capture", "lease-clone", "archive", "release-clone", "restore-select"]);
});
