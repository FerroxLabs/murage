import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
const rawSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const writerBarrier = '  await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");';
const control = process.env.MURAGE_RECOVERY_CONTROL === "skip-writer-wait";
if (control) assert.ok(rawSource.includes(writerBarrier));
const source = control ? rawSource.replace(writerBarrier, "") : rawSource;
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = () => new Promise(resolve => setImmediate(resolve));

function fixture({ writes = [], stop = async () => {}, mode = true } = {}) {
  let forks = 0, releases = 0, captured;
  const scope = {
    desktopRecoveryMode: mode, desktopShutdownStarted: false, desktopDataDir: "/owned/installation",
    desktopDataOwner: { release: () => { releases++; }, utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "private-owned-capability" }) },
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
  const scope = { desktopStartup: startup, desktopShutdownStarted: false, app: { isPackaged: true, quit: () => calls.push("quit") }, slog: value => calls.push(value), dialog: { showErrorBox: () => calls.push("error-box") }, showDesktopRecovery: code => calls.push(code) };
  await new Function(...Object.keys(scope), body + "; return desktopStartup.catch(()=>{});")(...Object.values(scope));
  assert.equal(calls.includes("STARTUP_FAILED"), true);
  assert.equal(calls.includes("quit"), false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_CREDENTIAL_CANARY"), false);
});
