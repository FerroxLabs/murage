// SPDX-License-Identifier: Apache-2.0
// Protocol cases adapted from OpenMausBot v0.1.54; see data-dir-lease.mjs.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import { inspect } from "node:util";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { acquireDataDirLease, acquireDataDirLeaseForProcess, dataDirLeasePaths, inspectDataDirLease } from "./data-dir-lease.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const MODULE = new URL("./data-dir-lease.mjs", import.meta.url).href;
const PRIVATE_ENV = "MURAGE_INTERNAL_DATA_DIR_LEASE";
const roots = [];
const workers = new Set();

function fixture(name = "data") {
  const root = mkdtempSync(join(tmpdir(), "murage-data-lease-"));
  roots.push(root);
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, ...dataDirLeasePaths(dataDir) };
}

async function until(predicate, detail) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Barriers wrap the real filesystem only inside disposable Node processes.
// No production test hooks or alternate publication algorithm are involved.
const WORKER = `
  import fs from 'node:fs';
  import os from 'node:os';
  import nodePath from 'node:path';
  import cp from 'node:child_process';
  import { createRequire, syncBuiltinESMExports } from 'node:module';
  import { spawnSync } from 'node:child_process';
  // Probe faults are confined to this disposable process, before ESM imports.
  const bootProbe = () => {
    if (process.env.LEASE_TEST_BOOT === 'throw') throw new Error('probe unavailable');
    return process.env.LEASE_TEST_BOOT;
  };
  if (process.env.LEASE_TEST_BOOT !== undefined) {
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => path === '/proc/sys/kernel/random/boot_id' ? bootProbe() : read(path, ...args);
    const exec = cp.execFileSync;
    cp.execFileSync = (path, ...args) => path === '/usr/sbin/sysctl' ? bootProbe() : exec(path, ...args);
  }
  if (process.env.LEASE_TEST_UPTIME !== undefined) os.uptime = () => {
    if (process.env.LEASE_TEST_UPTIME === 'throw') throw new Error('uptime unavailable');
    return Number(process.env.LEASE_TEST_UPTIME);
  };
  if (process.env.LEASE_TEST_PID_EPERM) process.kill = () => {
    throw Object.assign(new Error('not permitted'), {code:'EPERM'});
  };
  // Windows creation-identity seam: only the engine-exclusion addon's processStart is simulated (no PowerShell is involved any more,
  // murage-releases #1). Answers are keyed by queried PID ("self" = this worker); absent keys fail. An answer "<pid>:<start>" for the
  // queried pid gives <start>; anything else is handed back as it is (and must be refused as malformed).
  const probes = [];
  if (process.env.LEASE_TEST_WIN32) Object.defineProperty(process, 'platform', { value: 'win32' });
  const seam = process.env.LEASE_TEST_PS === undefined ? {} : { probes };
  if (process.env.LEASE_TEST_PS !== undefined) {
    const table = JSON.parse(process.env.LEASE_TEST_PS);
    const native = {
      version: () => 9,
      processStart(pid) {
        probes.push({ mode: 'sync', pid });
        const entry = pid === process.pid && table.self !== undefined ? table.self.replace('SELF_PID', String(process.pid)) : table[String(pid)];
        if (entry === undefined || entry === 'throw') throw Object.assign(new Error('probe failed'), { code: 'EIO' });
        return entry.startsWith(pid + ':') ? entry.slice(String(pid).length + 1) : entry;
      },
    };
    // require() hands the loader the file's resolved path: on macOS the temp folder /var/folders/... resolves to /private/var/...,
    // and on Windows it has backslashes and may be an 8.3 short name, so the fake is told by its own unique folder name, never by
    // a prefix of the unresolved spelling (that missed on both, and the real addon lookup then found nothing).
    const fakeDir = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lease-native-')));
    fs.writeFileSync(nodePath.join(fakeDir, 'engine-exclusion.node'), '');
    process.env.MURAGE_RESOURCES_PATH = fakeDir;
    const Module = createRequire(import.meta.url)('node:module');
    const loadNative = Module._extensions['.node'];
    const isFake = (filename) => nodePath.basename(filename) === 'engine-exclusion.node' && nodePath.basename(nodePath.dirname(filename)) === nodePath.basename(fakeDir);
    Module._extensions['.node'] = (module, filename) => { if (isFake(filename)) { module.exports = native; return; } loadNative(module, filename); };
  }
  // Windows share-none seam (simulated win32 only): a share-none open leaves a
  // marker naming this process; any other open of that file is refused with
  // EBUSY while the marker's process lives, as Windows refuses it. Paths
  // are split on either separator, so the seam reads the same on a real
  // Windows host.
  if (process.env.LEASE_TEST_WIN32) {
    const EX = 0x10000000;
    const open = fs.openSync, close = fs.closeSync;
    const markers = new Map();
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    fs.openSync = (path, flags, ...rest) => {
      const name = String(path);
      if (typeof flags === 'number' && (flags & EX)) {
        const fd = open(name, flags & ~EX, ...rest);
        fs.writeFileSync(name + '.held-' + process.pid, '');
        markers.set(fd, name + '.held-' + process.pid);
        probes.push({ mode: 'held-open' });
        return fd;
      }
      if (/[.]alive-[0-9a-f-]{36}$/.test(name)) {
        probes.push({ mode: 'held-check' });
        const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(String.fromCharCode(92))), dir = name.slice(0, slash), base = name.slice(slash + 1);
        const busy = fs.existsSync(name + '.busy') || fs.readdirSync(dir).some((entry) => entry.startsWith(base + '.held-') && alive(Number(entry.slice(base.length + 6))));
        if (busy) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
      }
      return open(path, flags, ...rest);
    };
    fs.closeSync = (fd) => {
      const marker = markers.get(fd);
      if (marker) { markers.delete(fd); try { fs.unlinkSync(marker); } catch {} }
      return close(fd);
    };
  }
  let pause;
  let paused = false;
  let attempts = 0;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  const hold = () => {
    paused = true;
    fs.writeFileSync(pause.stage, 'paused');
    const deadline = Date.now() + 10000;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(pause.gate)) {
      if (Date.now() > deadline) throw new Error('test barrier expired');
      Atomics.wait(cell, 0, 0, 5);
    }
  };
  const matches = (path) => pause && !paused && (pause.prefix ? String(path).startsWith(pause.path) : path === pause.path);
  fs.linkSync = (source, target) => {
    if (process.env.LEASE_TEST_COLLIDE === target) {
      attempts++;
      throw Object.assign(new Error('test collision'), {code:'EEXIST'});
    }
    if (matches(target) && pause.operation === 'before-link') hold();
    const result = originalLink(source, target);
    if (matches(target) && pause.operation === 'after-link') hold();
    return result;
  };
  fs.unlinkSync = (path) => {
    if (matches(path) && pause.operation === 'before-unlink') hold();
    return originalUnlink(path);
  };
  syncBuiltinESMExports();
  const mod = await import(${JSON.stringify(MODULE)});
  let lease;
  process.on('message', (message) => {
    try {
      if (message.command === 'pause') { pause = message.pause; paused = false; process.send({event:'paused-configured'}); return; }
      if (message.command === 'acquire') {
        lease = mod.acquireDataDirLeaseForProcess(process.env.LEASE_TEST_DATA_DIR);
        process.send({event:'acquired', pid:process.pid, delegated:lease.delegated, consumed:process.env[${JSON.stringify(PRIVATE_ENV)}] === undefined, ...seam});
      } else if (message.command === 'capability') {
        process.send({event:'capability', environment:lease.utilityServerLeaseEnvironment()});
      } else if (message.command === 'release') {
        process.send({event:'released', released:lease.release(), ...seam});
      } else if (message.command === 'inspect') {
        process.send({event:'inspect', result:{...mod.inspectDataDirLease(process.env.LEASE_TEST_DATA_DIR)}, ...seam});
      } else if (message.command === 'generic-child') {
        const result = spawnSync(process.execPath, ['--eval', 'process.stdout.write(process.env.${PRIVATE_ENV} === undefined ? "absent" : "present")'], {env:process.env,encoding:'utf8'});
        process.send({event:'generic-child', inherited:result.stdout !== 'absent'});
      } else if (message.command === 'exit') process.exit(0);
    } catch (error) {
      process.send({event:'error', code:error.code, message:error.message, hasCause:error.cause !== undefined, attempts, ...seam});
    }
  });
  process.send({event:'ready', pid:process.pid});
`;

function worker(f, environment = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER], {
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: f.root, USERPROFILE: f.root, LEASE_TEST_DATA_DIR: f.dataDir, ...environment },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages = [];
  let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const item = {
    child, messages, exited,
    async event(name) {
      await until(() => messages.some((message) => message.event === name) || child.exitCode !== null || child.signalCode !== null, `worker ${name}`);
      const index = messages.findIndex((message) => message.event === name);
      assert.notEqual(index, -1, `Worker exited before ${name}: ${stderr}`);
      return messages.splice(index, 1)[0];
    },
    async command(command) {
      child.send({ command });
      const event = command === "acquire" ? "acquired" : command === "release" ? "released" : command;
      await until(() => messages.some((message) => message.event === event || message.event === "error") || child.exitCode !== null || child.signalCode !== null, `command ${command}`);
      const index = messages.findIndex((message) => message.event === event || message.event === "error");
      if (index === -1) return { event: "error", code: "WORKER_EXITED" };
      return messages.splice(index, 1)[0];
    },
    async pause(operation, path, prefix = false) {
      const id = randomUUID();
      const stage = join(f.root, `${id}.stage`);
      const gate = join(f.root, `${id}.gate`);
      child.send({ command: "pause", pause: { operation, path, prefix, stage, gate } });
      await item.event("paused-configured");
      return { stage, gate, reached: () => until(() => existsSync(stage), "filesystem barrier"), resume: () => writeFileSync(gate, "continue") };
    },
  };
  workers.add(item);
  return item;
}

async function stop(item) {
  if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL");
  await item.exited;
  workers.delete(item);
}

async function deadPid() {
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("close", resolve));
  return pid;
}

// A live process on this machine that is not this one (the test runner that started this file): a record
// naming this process's own PID counts as live only while this process holds its token.
const LIVE_OTHER_PID = process.ppid;
const record = (pid, extra = {}) => ({ version: 1, pid, host: hostname(), token: randomUUID(), createdAt: Date.now() - 1000, ...extra });
const writeRecord = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const errorCode = (code) => (error) => error.name === "DataDirLeaseError" && error.code === code;

const sleepers = new Set();
test.afterEach(async () => {
  for (const item of [...workers]) await stop(item);
  for (const item of [...sleepers]) {
    if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL");
    await item.exited;
    sleepers.delete(item);
  }
  for (const root of roots.splice(0)) safeWipeSync(root);
});

test("stable sibling anchors do not create the installation or migrate legacy data", () => {
  const f = fixture();
  safeWipeSync(f.dataDir);
  const nested = join(f.root, "missing-parent", "new-data");
  const before = dataDirLeasePaths(nested);
  const lease = acquireDataDirLease(nested);
  assert.equal(existsSync(nested), false);
  assert.equal(dataDirLeasePaths(nested).leasePath, before.leasePath);
  assert.equal(dirname(before.leasePath), dirname(before.canonicalDataDir));
  assert.ok(relative(nested, before.leasePath).startsWith(".."));
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  mkdirSync(f.dataDir);
  writeFileSync(join(f.dataDir, "sentinel"), "keep");
  assert.throws(() => acquireDataDirLease(nested, { legacyDataDir: f.dataDir }), errorCode("MIGRATION_REQUIRED"));
  assert.equal(readFileSync(join(f.dataDir, "sentinel"), "utf8"), "keep");
  assert.equal(existsSync(nested), false);
  assert.throws(() => acquireDataDirLease(parse(f.root).root), errorCode("INVALID_DATA_DIR"));
});

test("renaming and replacing DATA_DIR does not move or release its owner", async () => {
  const f = fixture();
  const lease = acquireDataDirLease(f.dataDir);
  const original = readFileSync(f.leasePath, "utf8");
  renameSync(f.dataDir, `${f.dataDir}.retained`);
  mkdirSync(f.dataDir);
  const contender = worker(f);
  assert.equal((await contender.command("acquire")).code, "LEASE_BUSY");
  assert.equal(readFileSync(f.leasePath, "utf8"), original);
  assert.equal(dataDirLeasePaths(f.dataDir).leasePath, f.leasePath);
  lease.release();
});

test("canonical directory aliases share one anchor, including missing suffixes", () => {
  const f = fixture();
  const alias = join(f.root, "alias");
  symlinkSync(f.dataDir, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(dataDirLeasePaths(alias).leasePath, f.leasePath);
  assert.equal(dataDirLeasePaths(join(alias, "new", "data")).leasePath, dataDirLeasePaths(join(f.dataDir, "new", "data")).leasePath);
  const lease = acquireDataDirLease(f.dataDir);
  assert.throws(() => acquireDataDirLease(alias), errorCode("LEASE_BUSY"));
  lease.release();
  const file = join(f.root, "file");
  writeFileSync(file, "sentinel");
  assert.throws(() => acquireDataDirLease(join(file, "child")), errorCode("INVALID_DATA_DIR"));
  const dangling = join(f.root, "dangling");
  symlinkSync(join(f.root, "absent"), dangling, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => acquireDataDirLease(dangling), errorCode("INVALID_DATA_DIR"));
});

test("parent traversal is resolved after existing symlinks, never across a missing ancestor", () => {
  const f = fixture();
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(join(elsewhere, "child"), { recursive: true });
  mkdirSync(join(elsewhere, "data"));
  const alias = join(f.root, "link");
  symlinkSync(join(elsewhere, "child"), alias, process.platform === "win32" ? "junction" : "dir");
  // String construction is deliberate: path.join would erase '..' before
  // the filesystem gets to resolve the symlink.
  const traversed = `${alias}/../data`;
  assert.equal(dataDirLeasePaths(traversed).leasePath, dataDirLeasePaths(join(elsewhere, "data")).leasePath);
  const owner = acquireDataDirLease(join(elsewhere, "data"));
  assert.throws(() => acquireDataDirLease(traversed), errorCode("LEASE_BUSY"));
  owner.release();
  assert.throws(() => acquireDataDirLease(`${f.root}/missing/../data`), errorCode("INVALID_DATA_DIR"));
});

test("Windows case and namespace aliases share one anchor", { skip: process.platform !== "win32" }, async () => {
  const f = fixture("MixedCase");
  assert.equal(dataDirLeasePaths(f.dataDir.toUpperCase()).leasePath, f.leasePath);
  const { toNamespacedPath } = await import("node:path");
  const namespaced = toNamespacedPath(f.dataDir);
  assert.equal(dataDirLeasePaths(namespaced).leasePath, f.leasePath);
  for (const suffix of ["child.", "child ", "..", "NUL", "COM1.txt"]) {
    assert.throws(() => dataDirLeasePaths(`${namespaced}\\${suffix}`), errorCode("INVALID_DATA_DIR"));
  }
  const owner = acquireDataDirLease(f.dataDir);
  try {
    assert.throws(() => acquireDataDirLease(namespaced), errorCode("LEASE_BUSY"));
  } finally { owner.release(); }
});

test("Darwin missing-leaf case aliases cannot acquire two owners", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  const lower = join(f.dataDir, "new-installation");
  const upper = join(f.dataDir, "NEW-INSTALLATION");
  const owner = acquireDataDirLease(lower);
  assert.throws(() => acquireDataDirLease(upper), errorCode("LEASE_BUSY"));
  assert.equal(existsSync(lower), false);
  owner.release();
  const composed = join(f.dataDir, "caf\u00e9");
  const decomposed = join(f.dataDir, "cafe\u0301");
  const unicode = acquireDataDirLease(composed);
  assert.throws(() => acquireDataDirLease(decomposed), errorCode("LEASE_BUSY"));
  unicode.release();
});

for (const stale of ["fresh", "dead-pid", "prior-boot"]) {
  test(`real process contenders elect one ${stale} owner`, async () => {
    const f = fixture();
    if (stale === "dead-pid") writeRecord(f.leasePath, record(await deadPid()));
    if (stale === "prior-boot") writeRecord(f.leasePath, record(process.pid, { boot: null, uptime: Math.floor(uptime() * 1000) + 3_600_000 }));
    const contenders = Array.from({ length: 8 }, () => worker(f));
    await Promise.all(contenders.map((item) => item.event("ready")));
    const outcomes = await Promise.all(contenders.map((item) => item.command("acquire")));
    assert.equal(outcomes.filter((outcome) => outcome.event === "acquired").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.event === "error").length, 7);
    const winner = contenders[outcomes.findIndex((outcome) => outcome.event === "acquired")];
    assert.equal((await winner.command("release")).released, true);
    const next = acquireDataDirLease(f.dataDir);
    next.release();
  });
}

// Eight contenders on Windows: one read the record while another replaced it
// and failed LEASE_UNREADABLE / LEASE_INVALID instead of waiting its turn (CI
// 36323645974; 1 in 15 on the 0.1.61 Windows VM). A record that is replaced
// or removed while it is being read is someone else's election in progress.
test("a lease record replaced while it is read is another contender's turn, not a broken lease", async () => {
  for (const change of ["replaced", "removed"]) {
    const f = fixture();
    const dead = await sleeper(); const live = await sleeper();
    const deadRecord = record(dead.pid);
    writeRecord(f.leasePath, deadRecord);
    const deadExit = new Promise((resolve) => dead.once("close", resolve));
    dead.kill("SIGKILL"); await deadExit;
    const originalOpen = fs.openSync;
    let raced = false;
    fs.openSync = function (path, ...rest) {
      if (!raced && path === f.leasePath) {
        raced = true;
        rmSync(f.leasePath);
        if (change === "replaced") writeRecord(f.leasePath, record(live.pid));
      }
      return originalOpen.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    try {
      if (change === "replaced") assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
      else acquireDataDirLease(f.dataDir).release();
      assert.equal(raced, true);
    } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  }
});

test("a killed primary owner can be recovered from its complete nonce record", async () => {
  const f = fixture();
  const holder = worker(f);
  assert.equal((await holder.command("acquire")).event, "acquired");
  await stop(holder);
  const recovered = acquireDataDirLease(f.dataDir);
  assert.equal(recovered.ownerPid, process.pid);
  recovered.release();
});

test("delegation is consumed before generic children and permits only one live worker", async () => {
  const f = fixture();
  const parent = acquireDataDirLease(f.dataDir);
  const capability = parent.utilityServerLeaseEnvironment();
  const first = worker(f, capability);
  assert.deepEqual(await first.command("acquire"), { event: "acquired", pid: first.child.pid, delegated: true, consumed: true });
  assert.equal((await first.command("generic-child")).inherited, false);
  assert.throws(() => parent.release(), errorCode("LEASE_CHILD_BUSY"));
  const second = worker(f, capability);
  assert.equal((await second.command("acquire")).code, "LEASE_BUSY");
  await stop(first);
  // Reusing a parent capability for port fallback is safe only after the old
  // subordinate really exited; the stale child nonce is recovered here.
  const replacement = worker(f, capability);
  assert.equal((await replacement.command("acquire")).delegated, true);
  assert.equal((await replacement.command("release")).released, true);
  assert.equal(parent.release(), true);
});

test("simultaneous reuse of a primary capability elects exactly one subordinate", async () => {
  const f = fixture();
  const parent = acquireDataDirLease(f.dataDir);
  const capability = parent.utilityServerLeaseEnvironment();
  const contenders = Array.from({ length: 6 }, () => worker(f, capability));
  await Promise.all(contenders.map((item) => item.event("ready")));
  const outcomes = await Promise.all(contenders.map((item) => item.command("acquire")));
  assert.equal(outcomes.filter((outcome) => outcome.event === "acquired").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.event === "error").length, 5);
  const winner = contenders[outcomes.findIndex((outcome) => outcome.event === "acquired")];
  assert.equal((await winner.command("release")).released, true);
  parent.release();
});

test("a dead primary cannot be replaced while its real delegated process lives", async () => {
  const f = fixture();
  const parent = worker(f);
  await parent.command("acquire");
  const capability = (await parent.command("capability")).environment;
  const delegated = worker(f, capability);
  assert.equal((await delegated.command("acquire")).delegated, true);
  await stop(parent);
  const preserved = readFileSync(f.leasePath, "utf8");
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_CHILD_BUSY"));
  assert.equal(readFileSync(f.leasePath, "utf8"), preserved);
  await stop(delegated);
  const recovered = acquireDataDirLease(f.dataDir);
  recovered.release();
});

for (const operation of ["before-link", "after-link"]) {
  test(`parent death ${operation === "before-link" ? "before" : "after"} child publication refuses unvalidated startup`, async () => {
    const f = fixture();
    const parent = worker(f);
    await parent.command("acquire");
    const delegated = worker(f, (await parent.command("capability")).environment);
    const barrier = await delegated.pause(operation, f.childLeasePath);
    const outcome = delegated.command("acquire");
    await barrier.reached();
    await stop(parent);
    let successor;
    if (operation === "before-link") successor = acquireDataDirLease(f.dataDir);
    else assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_CHILD_BUSY"));
    barrier.resume();
    assert.equal((await outcome).code, "LEASE_DELEGATION_INVALID");
    assert.equal(existsSync(f.childLeasePath), false);
    successor ??= acquireDataDirLease(f.dataDir);
    successor.release();
  });
}

test("the parent's published closing seal rejects a concurrent child before admission", async () => {
  const f = fixture();
  const parent = worker(f);
  await parent.command("acquire");
  const capability = (await parent.command("capability")).environment;
  const barrier = await parent.pause("after-link", `${f.leasePath}.closing-`, true);
  const releasing = parent.command("release");
  await barrier.reached();
  const delegated = worker(f, capability);
  assert.equal((await delegated.command("acquire")).code, "LEASE_CLOSING");
  assert.equal(existsSync(f.childLeasePath), false);
  barrier.resume();
  assert.equal((await releasing).released, true);
  const replacement = acquireDataDirLease(f.dataDir);
  replacement.release();
});

test("a primary killed while sealing release leaves recoverable, nonce-scoped evidence", async () => {
  const f = fixture();
  const parent = worker(f);
  await parent.command("acquire");
  const barrier = await parent.pause("after-link", `${f.leasePath}.closing-`, true);
  // No command promise is left waiting after deliberately killing its owner.
  parent.child.send({ command: "release" });
  await barrier.reached();
  await stop(parent);
  assert.equal(readdirSync(f.root).filter((name) => name.includes(".closing-") && !name.includes("candidate-")).length, 1);
  const successor = acquireDataDirLease(f.dataDir);
  const delegated = worker(f, successor.utilityServerLeaseEnvironment());
  assert.equal((await delegated.command("acquire")).delegated, true);
  await delegated.command("release");
  successor.release();
});

for (const first of ["parent", "child"]) {
  test(`sealed release versus unpublished child: ${first} finishes first`, async () => {
    const f = fixture();
    const parent = worker(f);
    await parent.command("acquire");
    const delegated = worker(f, (await parent.command("capability")).environment);
    const childBarrier = await delegated.pause("before-link", f.childLeasePath);
    const starting = delegated.command("acquire");
    await childBarrier.reached();
    const parentBarrier = await parent.pause("before-unlink", f.leasePath);
    const releasing = parent.command("release");
    await parentBarrier.reached();
    if (first === "parent") {
      parentBarrier.resume();
      assert.equal((await releasing).released, true);
      childBarrier.resume();
      assert.equal((await starting).code, "LEASE_DELEGATION_INVALID");
    } else {
      childBarrier.resume();
      assert.equal((await starting).code, "LEASE_CLOSING");
      parentBarrier.resume();
      assert.equal((await releasing).released, true);
    }
    const replacement = acquireDataDirLease(f.dataDir);
    replacement.release();
  });
}

test("invalid delegation is removed before failure and errors never expose the token or parser cause", () => {
  const f = fixture();
  for (const value of ["private-secret-canary", "", null, false]) {
    const env = { [PRIVATE_ENV]: value };
    assert.throws(() => acquireDataDirLeaseForProcess(f.dataDir, env), (error) => {
      assert.equal(error.code, "LEASE_DELEGATION_INVALID");
      assert.equal(error.cause, undefined);
      assert.equal(inspect(error).includes("private-secret-canary"), false);
      return true;
    });
    assert.equal(Object.hasOwn(env, PRIVATE_ENV), false);
    assert.equal(existsSync(f.leasePath), false);
  }
  const immutable = Object.freeze({ [PRIVATE_ENV]: "private-secret-canary" });
  assert.throws(() => acquireDataDirLeaseForProcess(f.dataDir, immutable), errorCode("LEASE_DELEGATION_CONSUME"));
});

test("a valid capability is bound to its exact installation", async () => {
  const a = fixture("a");
  const b = fixture("b");
  const parent = acquireDataDirLease(a.dataDir);
  const other = worker(b, parent.utilityServerLeaseEnvironment());
  assert.equal((await other.command("acquire")).code, "LEASE_DELEGATION_INVALID");
  assert.equal(existsSync(b.leasePath), false);
  assert.equal(existsSync(b.childLeasePath), false);
  parent.release();
});

test("invalid, unreadable, symlink and special lease records remain untouched", () => {
  const f = fixture();
  for (const raw of ["secret-canary invalid json", "null", JSON.stringify({ ...record(process.pid), extra: "secret-canary" }), "x".repeat(4097)]) {
    writeFileSync(f.leasePath, raw, { mode: 0o600 });
    assert.throws(() => acquireDataDirLease(f.dataDir), (error) => {
      assert.equal(error.code, "LEASE_INVALID");
      assert.equal(error.cause, undefined);
      assert.equal(inspect(error).includes("secret-canary"), false);
      return true;
    });
    assert.equal(readFileSync(f.leasePath, "utf8"), raw);
    rmSync(f.leasePath);
  }
  writeRecord(f.leasePath, record(LIVE_OTHER_PID));
  if (process.platform === "win32") {
    // chmod's POSIX read bits cannot make a Windows file unreadable; the
    // current owner's readable record must still exclude another claimant.
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  } else {
    chmodSync(f.leasePath, 0o200);
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_UNREADABLE"));
    chmodSync(f.leasePath, 0o600);
  }
  rmSync(f.leasePath);
  const target = join(f.root, "external-record");
  writeRecord(target, record(process.pid));
  symlinkSync(target, f.leasePath, process.platform === "win32" ? "file" : undefined);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
  assert.equal(lstatSync(f.leasePath).isSymbolicLink(), true);
  rmSync(f.leasePath);
  symlinkSync(join(f.root, "absent-record"), f.leasePath, process.platform === "win32" ? "file" : undefined);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
  assert.equal(lstatSync(f.leasePath).isSymbolicLink(), true);
  rmSync(f.leasePath);
  mkdirSync(f.leasePath);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
  assert.equal(lstatSync(f.leasePath).isDirectory(), true);
});

test("a FIFO lease refuses without opening or waiting for a writer", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  execFileSync("mkfifo", [f.leasePath]);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
  assert.equal(lstatSync(f.leasePath).isFIFO(), true);
});

test("foreign primary, child and recovery owners are preserved", async () => {
  for (const kind of ["primary", "child", "reaper"]) {
    const f = fixture(kind);
    const owner = record(await deadPid());
    const foreign = record(await deadPid(), { host: "foreign-host.invalid" });
    let path = kind === "child" ? f.childLeasePath : f.leasePath;
    if (kind === "reaper") {
      writeRecord(f.leasePath, owner);
      path = `${f.leasePath}.reap-${owner.token}`;
      foreign.targetToken = owner.token;
    }
    writeRecord(path, foreign);
    const before = readFileSync(path, "utf8");
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_FOREIGN_HOST"));
    assert.equal(readFileSync(path, "utf8"), before);
    if (kind === "reaper") assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), owner);
  }
});

// upstream #2018 (MOCA-270): macOS renames the host when it joins another
// network. A lease a crash left on one network looked like another machine's on
// the next, and the app refused to start until the file was deleted by hand.
// The boot session id is random per boot, so it proves a record is this
// computer's whatever its hostname says.
const OLD_NAME = "old-network-name.local";

test("a lease this computer left under its old hostname is recovered", { skip: process.platform === "win32" }, async () => {
  for (const kind of ["primary", "child", "reaper"]) {
    const f = fixture(`renamed-${kind}`);
    const mine = currentRecord(f);
    assert.notEqual(mine.boot, null, "native boot identity must be available on this verification host");
    const stale = record(await deadPid(), { host: OLD_NAME, boot: mine.boot, uptime: mine.uptime });
    let path = kind === "child" ? f.childLeasePath : f.leasePath;
    if (kind === "reaper") {
      const owner = record(await deadPid(), { host: OLD_NAME, boot: mine.boot, uptime: mine.uptime });
      writeRecord(f.leasePath, owner);
      path = `${f.leasePath}.reap-${owner.token}`;
      stale.targetToken = owner.token;
    }
    writeRecord(path, stale);
    const lease = acquireDataDirLease(f.dataDir);
    assert.equal(JSON.parse(readFileSync(f.leasePath, "utf8")).host, hostname());
    assert.equal(lease.release(), true);
  }
});

test("a live owner under an old hostname on this boot is busy, not foreign", { skip: process.platform === "win32" }, () => {
  const f = fixture("renamed-live");
  const mine = currentRecord(f);
  assert.notEqual(mine.boot, null);
  writeRecord(f.leasePath, record(LIVE_OTHER_PID, { host: OLD_NAME, boot: mine.boot, uptime: mine.uptime }));
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  rmSync(f.leasePath); // the fixture cleanup refuses a folder whose lease names another live process
});

test("another hostname on another boot still fails closed", async () => {
  const f = fixture("renamed-other-boot");
  const mine = currentRecord(f);
  const other = record(await deadPid(), { host: OLD_NAME, boot: randomUUID(), uptime: mine.uptime });
  writeRecord(f.leasePath, other);
  const before = readFileSync(f.leasePath, "utf8");
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_FOREIGN_HOST"));
  assert.equal(readFileSync(f.leasePath, "utf8"), before);
});

test("inspection reports foreign claims without leaking or changing records", async () => {
  for (const kind of ["primary", "child", "reaper"]) {
    const f = fixture(kind);
    const primary = record(await deadPid());
    const foreign = record(process.pid, { host: "foreign-host.invalid" });
    let path = kind === "child" ? f.childLeasePath : f.leasePath;
    if (kind === "reaper") {
      writeRecord(f.leasePath, primary);
      path = `${f.leasePath}.reap-${primary.token}`;
      foreign.targetToken = primary.token;
    }
    writeRecord(path, foreign);
    const before = readFileSync(path, "utf8"), names = readdirSync(f.root);
    const result = inspectDataDirLease(f.dataDir);
    assert.deepEqual(result, { status: "blocked", code: "LEASE_FOREIGN_HOST", claimKind: kind, recordedHost: foreign.host, currentHost: hostname() });
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(f.root), names);
    assert.equal(JSON.stringify(result).includes(foreign.token), false);
    assert.equal(JSON.stringify(result).includes(f.root), false);
    assert.equal(Object.hasOwn(result, "pid"), false);
  }
});

test("inspection creates no missing directories or lease anchors", () => {
  const f = fixture();
  const nested = join(f.root, "absent-parent", "new-installation");
  const names = readdirSync(f.root);
  assert.deepEqual(inspectDataDirLease(nested), { status: "available", code: null, claimKind: null, recordedHost: null, currentHost: hostname() });
  assert.equal(existsSync(dirname(nested)), false);
  assert.deepEqual(readdirSync(f.root), names);
});

test("inspection preserves malformed records and redacts unsafe host strings", () => {
  const f = fixture();
  const invalid = "secret-canary invalid JSON";
  writeFileSync(f.leasePath, invalid);
  assert.deepEqual(inspectDataDirLease(f.dataDir), { status: "error", code: "LEASE_INVALID", claimKind: "primary", recordedHost: null, currentHost: hostname() });
  assert.equal(readFileSync(f.leasePath, "utf8"), invalid);
  writeRecord(f.leasePath, record(process.pid, { host: "<img src=/secret-canary>" }));
  const result = inspectDataDirLease(f.dataDir);
  assert.equal(result.code, "LEASE_FOREIGN_HOST");
  assert.equal(result.recordedHost, null);
  assert.equal(JSON.stringify(result).includes("secret-canary"), false);
});

test("inspection refuses a symlink lease without following or changing it", { skip: process.platform === "win32" }, () => {
  const f = fixture(), target = join(f.root, "secret-target");
  const bytes = "secret-canary target";
  writeFileSync(target, bytes);
  symlinkSync(target, f.leasePath);
  const result = inspectDataDirLease(f.dataDir);
  assert.equal(result.code, "LEASE_INVALID");
  assert.equal(result.status, "error");
  assert.equal(lstatSync(f.leasePath).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), bytes);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("inspection follows acquisition order and immutable reaper successors", async () => {
  const f = fixture(), dead = await deadPid();
  const primary = record(dead), oldReaper = record(dead, { targetToken: primary.token });
  writeRecord(f.leasePath, primary);
  const path = `${f.leasePath}.reap-${primary.token}`;
  writeRecord(path, oldReaper);
  const successor = `${path}-${createHash("sha256").update(oldReaper.token).digest("hex").slice(0, 32)}`;
  writeRecord(successor, record(dead, { host: "foreign-successor.invalid", targetToken: primary.token }));
  assert.equal(inspectDataDirLease(f.dataDir).recordedHost, "foreign-successor.invalid");
  writeRecord(f.childLeasePath, record(LIVE_OTHER_PID));
  assert.equal(inspectDataDirLease(f.dataDir).code, "LEASE_CHILD_BUSY");
  rmSync(f.childLeasePath);
  writeRecord(f.leasePath, record(LIVE_OTHER_PID));
  assert.equal(inspectDataDirLease(f.dataDir).code, "LEASE_BUSY");
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(oldReaper)}\n`);
  rmSync(f.leasePath); // the fixture cleanup refuses a folder whose lease names another live process
});

test("interrupted stale reapers are succeeded, with a bounded immutable chain", async () => {
  const f = fixture();
  const owner = record(await deadPid());
  const reaper = record(await deadPid(), { targetToken: owner.token });
  writeRecord(f.leasePath, owner);
  writeRecord(`${f.leasePath}.reap-${owner.token}`, reaper);
  const next = acquireDataDirLease(f.dataDir);
  const digest = createHash("sha256").update(reaper.token).digest("hex").slice(0, 32);
  assert.equal(JSON.parse(readFileSync(`${f.leasePath}.reap-${owner.token}-${digest}`, "utf8")).pid, process.pid);
  next.release();
  const blocked = fixture("chain");
  const dead = await deadPid();
  const stale = record(dead);
  writeRecord(blocked.leasePath, stale);
  let path = `${blocked.leasePath}.reap-${stale.token}`;
  for (let generation = 0; generation < 128; generation++) {
    const entry = record(dead, { targetToken: stale.token });
    writeRecord(path, entry);
    path = `${blocked.leasePath}.reap-${stale.token}-${createHash("sha256").update(entry.token).digest("hex").slice(0, 32)}`;
  }
  assert.throws(() => acquireDataDirLease(blocked.dataDir), errorCode("LEASE_RECOVERY_LIMIT"));
  assert.deepEqual(JSON.parse(readFileSync(blocked.leasePath, "utf8")), stale);
});

test("a live reaper and malformed recovery claim are never replaced", async () => {
  const f = fixture();
  const stale = record(await deadPid());
  writeRecord(f.leasePath, stale);
  const path = `${f.leasePath}.reap-${stale.token}`;
  const active = record(LIVE_OTHER_PID, { targetToken: stale.token });
  writeRecord(path, active);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_RECOVERY_BUSY"));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), active);
  writeFileSync(path, "malformed-secret-canary", { mode: 0o600 });
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
  assert.equal(readFileSync(path, "utf8"), "malformed-secret-canary");
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), stale);
});

test("acquisition retries are bounded even if a filesystem repeatedly reports disappearing claims", async () => {
  const f = fixture();
  const contender = worker(f, { LEASE_TEST_COLLIDE: f.leasePath });
  const outcome = await contender.command("acquire");
  assert.equal(outcome.code, "LEASE_RECOVERY_LIMIT");
  assert.equal(outcome.attempts, 32);
  assert.equal(readdirSync(f.root).some((name) => name.includes("candidate-")), false);
});

test("changed ownership cannot be released by a stale handle", () => {
  const f = fixture();
  const lease = acquireDataDirLease(f.dataDir);
  const foreignNonce = record(process.pid);
  rmSync(f.leasePath);
  writeRecord(f.leasePath, foreignNonce);
  assert.throws(() => lease.release(), errorCode("LEASE_NOT_OWNED"));
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), foreignNonce);
});

function currentRecord(f) {
  const lease = acquireDataDirLease(f.dataDir);
  const owner = JSON.parse(readFileSync(f.leasePath, "utf8"));
  lease.release();
  return owner;
}

test("new records carry boot metadata while legacy live owners remain excluded", () => {
  const f = fixture();
  const owner = currentRecord(f);
  assert.deepEqual(Object.keys(owner).sort(), ["boot", "createdAt", "host", "pid", "token", "uptime", "version"]);
  assert.ok(owner.boot === null || /^[0-9A-Za-z:_.-]{1,128}$/.test(owner.boot));
  assert.ok(Number.isSafeInteger(owner.uptime) && owner.uptime >= 0);
  // (another live process's record: one naming this process is live only while it holds that token)
  writeRecord(f.leasePath, { ...owner, pid: LIVE_OTHER_PID });
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  const legacy = record(LIVE_OTHER_PID);
  writeRecord(f.leasePath, legacy);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), legacy);
  rmSync(f.leasePath); // the fixture cleanup refuses a folder whose lease names another live process
});

test("prior-boot primary and reaper with live reused PIDs recover via immutable successor", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const owner = currentRecord(f);
  assert.notEqual(owner.boot, null, "native boot identity must be available on this verification host");
  const stale = { ...owner, boot: randomUUID() };
  const reaper = { ...stale, token: randomUUID(), targetToken: stale.token };
  writeRecord(f.leasePath, stale);
  const reaperPath = `${f.leasePath}.reap-${stale.token}`;
  writeRecord(reaperPath, reaper);
  const lease = acquireDataDirLease(f.dataDir);
  const digest = createHash("sha256").update(reaper.token).digest("hex").slice(0, 32);
  assert.equal(JSON.parse(readFileSync(`${reaperPath}-${digest}`, "utf8")).boot, owner.boot);
  assert.deepEqual(JSON.parse(readFileSync(reaperPath, "utf8")), reaper);
  lease.release();
});

test("prior-boot child can be replaced and prior-boot parent cannot delegate", () => {
  const f = fixture();
  const stale = { ...currentRecord(f), boot: null, uptime: Math.floor(uptime() * 1000) + 3_600_000 };
  writeRecord(f.leasePath, stale);
  assert.throws(() => acquireDataDirLeaseForProcess(f.dataDir, { [PRIVATE_ENV]: `v1:${stale.pid}:${stale.token}` }), errorCode("LEASE_DELEGATION_INVALID"));
  assert.equal(existsSync(f.childLeasePath), false);
  writeRecord(f.childLeasePath, stale);
  const parent = acquireDataDirLease(f.dataDir);
  const child = acquireDataDirLeaseForProcess(f.dataDir, { ...parent.utilityServerLeaseEnvironment() });
  assert.equal(child.delegated, true);
  assert.throws(() => parent.release(), errorCode("LEASE_CHILD_BUSY"));
  child.release();
  parent.release();
});

for (const scenario of [
  { name: "missing boot and throwing uptime", boot: "throw", uptime: "throw", acquired: false },
  { name: "malformed boot and NaN uptime", boot: "bad boot", uptime: "NaN", acquired: false },
  { name: "missing boot and negative uptime", boot: "throw", uptime: "-1", acquired: false },
  { name: "missing boot and infinite uptime", boot: "throw", uptime: "Infinity", acquired: false },
  { name: "missing boot and unsafe uptime", boot: "throw", uptime: "1e20", acquired: false },
  { name: "missing boot and increasing uptime", boot: "throw", uptime: "61", acquired: false },
  { name: "missing boot and backwards uptime", boot: "throw", uptime: "1", acquired: true },
  { name: "same boot overrides backwards uptime", boot: "fixture-boot", uptime: "1", acquired: false, needsBoot: true },
  { name: "different boot overrides unavailable uptime", boot: "next-boot", uptime: "throw", acquired: true, needsBoot: true },
]) {
  test(`boot probes fail closed: ${scenario.name}`, { skip: scenario.needsBoot && process.platform === "win32" }, async () => {
    const f = fixture();
    const planted = record(process.pid, { boot: "fixture-boot", uptime: 60_000 });
    writeRecord(f.leasePath, planted);
    const contender = worker(f, { LEASE_TEST_BOOT: scenario.boot, LEASE_TEST_UPTIME: scenario.uptime, LEASE_TEST_PID_EPERM: "1" });
    const outcome = await contender.command("acquire");
    if (scenario.acquired) {
      assert.equal(outcome.event, "acquired");
      assert.equal((await contender.command("release")).released, true);
    } else {
      assert.equal(outcome.code, "LEASE_BUSY");
      assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), planted);
    }
  });
}

test("invalid boot metadata is rejected without changing the record", () => {
  const f = fixture();
  for (const extra of [{ boot: "" }, { boot: "bad boot" }, { boot: "x".repeat(129) }, { boot: 2 }, { uptime: -1 }, { uptime: 1.5 }, { uptime: Number.MAX_SAFE_INTEGER + 1 }]) {
    const planted = record(process.pid, extra);
    writeRecord(f.leasePath, planted);
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_INVALID"));
    assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), planted);
  }
});

test("unknown optional identity cannot evict a live owner", () => {
  const f = fixture();
  for (const extra of [{ boot: null, uptime: null }, { boot: null }, { uptime: null }]) {
    writeRecord(f.leasePath, record(LIVE_OTHER_PID, extra));
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  }
  rmSync(f.leasePath); // the fixture cleanup refuses a folder whose lease names another live process
});

test("changed boot metadata invalidates an old release handle", () => {
  const f = fixture();
  const lease = acquireDataDirLease(f.dataDir);
  const changed = { ...JSON.parse(readFileSync(f.leasePath, "utf8")), boot: randomUUID() };
  writeRecord(f.leasePath, changed);
  assert.throws(() => lease.release(), errorCode("LEASE_NOT_OWNED"));
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), changed);
});

// ---- Windows same-boot PID reuse (creation identity), simulated on any host ----
// A disposable worker reports win32 and answers only its native creation-time probe.
// The "reused" PID always belongs to a sleeper this test spawned itself.
const SYSTEM_ROOT = "C:\\Windows";
// A simulated-win32 worker case-folds the data directory before hashing its
// lease name, as Windows does; this POSIX parent does not. On a case-sensitive
// host a mixed-case temp name would give the two different lease paths, so
// these cases use a lowercase root (Darwin folds too; real Windows matches).
function windowsFixture(name = "data") {
  const base = tmpdir();
  const parent = base === base.toLowerCase() || ["darwin", "win32"].includes(process.platform) ? base : "/tmp";
  const root = join(parent, `murage-data-lease-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  roots.push(root);
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, ...dataDirLeasePaths(dataDir) };
}
const windows = (f, answers, extra = {}) => worker(f, { LEASE_TEST_WIN32: "1", SystemRoot: SYSTEM_ROOT, LEASE_TEST_PS: JSON.stringify(answers), ...extra });
const heldOf = (recordPath, owner) => `${recordPath}.alive-${owner.token}`;
// A held identity whose file no live process holds: the owner is gone.
const writeHeldIdentity = (recordPath, owner) => {
  const value = { version: 2, pid: owner.pid, token: owner.token };
  writeFileSync(heldOf(recordPath, owner), "", { mode: 0o600 });
  writeFileSync(identityOf(recordPath, owner), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return value;
};
const heldProbes = (outcome, mode) => outcome.probes.filter((probe) => probe.mode === mode);
const identityOf = (recordPath, owner) => `${recordPath}.identity-${owner.token}`;
const writeIdentity = (recordPath, owner, start, extra = {}) => {
  const value = { version: 1, pid: owner.pid, token: owner.token, start, ...extra };
  writeFileSync(identityOf(recordPath, owner), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return value;
};
const syncProbes = (outcome) => outcome.probes.filter((probe) => probe.mode === "sync");

// Only this test-owned child is ever signalled, by the shared afterEach.
async function sleeper() {
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("close", resolve));
  sleepers.add({ child, exited });
  await until(() => Boolean(child.pid), "sleeper pid");
  return child;
}
const stillRunning = (child) => child.exitCode === null && child.signalCode === null && (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })();

test("Windows identity: a live true owner with matching creation identity stays exclusive", async () => {
  const f = windowsFixture();
  const holder = await sleeper();
  const owner = record(holder.pid);
  writeRecord(f.leasePath, owner);
  const identity = writeIdentity(f.leasePath, owner, "133712345678901234");
  const contender = windows(f, { [holder.pid]: `${holder.pid}:133712345678901234` });
  const outcome = await contender.command("acquire");
  assert.equal(outcome.code, "LEASE_BUSY");
  const probes = syncProbes(outcome);
  assert.ok(probes.length >= 1);
  for (const probe of probes) assert.equal(probe.pid, holder.pid);
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), owner);
  assert.deepEqual(JSON.parse(readFileSync(identityOf(f.leasePath, owner), "utf8")), identity);
  assert.equal(stillRunning(holder), true);
});

test("Windows identity: a dead owner is reclaimed without any creation-time probe", async () => {
  const f = windowsFixture();
  const owner = record(await deadPid());
  writeRecord(f.leasePath, owner);
  writeIdentity(f.leasePath, owner, "133712345678901234");
  const contender = windows(f, {});
  const outcome = await contender.command("acquire");
  assert.equal(outcome.event, "acquired");
  assert.equal(syncProbes(outcome).length, 0);
  assert.equal(existsSync(identityOf(f.leasePath, owner)), false);
  assert.equal((await contender.command("release")).released, true);
});

test("Windows identity: a same-boot reused PID is reclaimed without touching the unrelated process", async () => {
  const f = windowsFixture();
  const unrelated = await sleeper();
  const stale = record(unrelated.pid);
  writeRecord(f.leasePath, stale);
  writeIdentity(f.leasePath, stale, "133700000000000001");
  const contender = windows(f, { [unrelated.pid]: `${unrelated.pid}:133700000000000002` });
  const ready = await contender.event("ready");
  const outcome = await contender.command("acquire");
  assert.equal(outcome.event, "acquired");
  // One real query; the proven mismatch is reused by the retirement recheck.
  assert.equal(syncProbes(outcome).length, 1);
  const current = JSON.parse(readFileSync(f.leasePath, "utf8"));
  assert.equal(current.pid, ready.pid);
  assert.notEqual(current.token, stale.token);
  assert.equal(existsSync(identityOf(f.leasePath, stale)), false);
  assert.equal(stillRunning(unrelated), true);
  assert.equal((await contender.command("release")).released, true);
  assert.equal(stillRunning(unrelated), true);
});

for (const [name, reply] of [
  ["probe throws or times out", "throw"],
  ["probe prints nothing", ""],
  ["probe prints garbage", "Access is denied."],
  ["probe answers another PID", "PID+1:133700000000000002"],
  ["probe value has a leading zero", "PID:0133700000000000002"],
  ["probe value exceeds FILETIME", "PID:99999999999999999999"],
  ["probe output exceeds its bound", `PID:133700000000000002${" ".repeat(80)}`],
]) {
  test(`Windows identity fails closed when the ${name}`, async () => {
    const f = windowsFixture();
    const holder = await sleeper();
    const owner = record(holder.pid);
    writeRecord(f.leasePath, owner);
    const identity = writeIdentity(f.leasePath, owner, "133700000000000001");
    const answer = reply === "throw" ? "throw" : reply.replace("PID+1", String(holder.pid + 1)).replace("PID", String(holder.pid));
    const contender = windows(f, { [holder.pid]: answer });
    const outcome = await contender.command("acquire");
    assert.equal(outcome.code, "LEASE_BUSY");
    assert.ok(syncProbes(outcome).length >= 1);
    assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), owner);
    assert.deepEqual(JSON.parse(readFileSync(identityOf(f.leasePath, owner), "utf8")), identity);
    assert.equal(stillRunning(holder), true);
  });
}

test("Windows identity: legacy and invalid identities keep PID exclusion without probing", async () => {
  const f = windowsFixture();
  const holder = await sleeper();
  const answers = { [holder.pid]: `${holder.pid}:133700000000000002` };
  const owner = record(holder.pid);
  writeRecord(f.leasePath, owner);
  const legacy = windows(f, answers);
  const outcome = await legacy.command("acquire");
  assert.equal(outcome.code, "LEASE_BUSY");
  assert.equal(syncProbes(outcome).length, 0);
  const path = identityOf(f.leasePath, owner);
  const valid = { version: 1, pid: holder.pid, token: owner.token, start: "133700000000000001" };
  const external = join(f.root, "external-identity");
  writeFileSync(external, JSON.stringify(valid), { mode: 0o600 });
  for (const plant of [
    () => writeFileSync(path, JSON.stringify({ ...valid, token: randomUUID() })),
    () => writeFileSync(path, JSON.stringify({ ...valid, pid: holder.pid + 1 })),
    () => writeFileSync(path, JSON.stringify({ ...valid, start: "0" })),
    () => writeFileSync(path, JSON.stringify({ ...valid, start: Number(valid.start) })),
    () => writeFileSync(path, JSON.stringify({ ...valid, extra: true })),
    () => writeFileSync(path, "not json"),
    () => writeFileSync(path, " ".repeat(4097)),
    () => symlinkSync(external, path, process.platform === "win32" ? "file" : undefined),
  ]) {
    rmSync(path, { force: true });
    plant();
    const before = lstatSync(path);
    const planted = before.isSymbolicLink() ? null : readFileSync(path, "utf8");
    const contender = windows(f, answers);
    const result = await contender.command("acquire");
    assert.equal(result.code, "LEASE_BUSY");
    assert.equal(syncProbes(result).length, 0);
    if (planted === null) assert.equal(lstatSync(path).isSymbolicLink(), true);
    else assert.equal(readFileSync(path, "utf8"), planted);
    assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), owner);
    await stop(contender);
  }
  assert.equal(stillRunning(holder), true);
});

test("Windows identity: FILETIME values are compared exactly beyond double precision", async () => {
  const f = windowsFixture();
  const holder = await sleeper();
  const owner = record(holder.pid);
  writeRecord(f.leasePath, owner);
  writeIdentity(f.leasePath, owner, "9223372036854775807");
  const same = windows(f, { [holder.pid]: `${holder.pid}:9223372036854775807` });
  assert.equal((await same.command("acquire")).code, "LEASE_BUSY");
  rmSync(identityOf(f.leasePath, owner));
  // 2^53 + 1 and 2^53 are equal as JavaScript numbers but are different processes.
  writeIdentity(f.leasePath, owner, "9007199254740993");
  const reused = windows(f, { [holder.pid]: `${holder.pid}:9007199254740992` });
  assert.equal((await reused.command("acquire")).event, "acquired");
  assert.equal((await reused.command("release")).released, true);
  assert.equal(stillRunning(holder), true);
});

test("Windows identity: owners hold a share-none file and publish its identity without PowerShell, and remove both on release", async () => {
  const f = windowsFixture();
  const holder = windows(f, {});
  const ready = await holder.event("ready");
  const acquired = await holder.command("acquire");
  assert.equal(acquired.event, "acquired");
  assert.equal(syncProbes(acquired).length, 0);
  assert.equal(heldProbes(acquired, "held-open").length, 1);
  const owner = JSON.parse(readFileSync(f.leasePath, "utf8"));
  // The primary record format is unchanged, so older readers stay compatible.
  assert.deepEqual(Object.keys(owner).sort(), ["boot", "createdAt", "host", "pid", "token", "uptime", "version"]);
  assert.equal(owner.pid, ready.pid);
  // Published before acquisition returns: nothing is left to race.
  assert.deepEqual(JSON.parse(readFileSync(identityOf(f.leasePath, owner), "utf8")), { version: 2, pid: ready.pid, token: owner.token });
  assert.equal(existsSync(heldOf(f.leasePath, owner)), true);
  // The owner still holds its file, so a contender stays out, with no PowerShell at all.
  const contender = windows(f, {});
  const refused = await contender.command("acquire");
  assert.equal(refused.code, "LEASE_BUSY");
  assert.equal(syncProbes(refused).length, 0);
  assert.ok(heldProbes(refused, "held-check").length >= 1);
  const released = await holder.command("release");
  assert.equal(released.released, true);
  assert.equal(existsSync(f.leasePath), false);
  assert.equal(existsSync(identityOf(f.leasePath, owner)), false);
  assert.equal(existsSync(heldOf(f.leasePath, owner)), false);
  // murage-releases #1: holding a lease never starts PowerShell.
  assert.equal(released.probes.filter((probe) => probe.mode === "async" || probe.mode === "sync").length, 0);
});

test("Windows identity: a hard-killed owner is reclaimed even though its PID was reused, without PowerShell", async () => {
  const f = windowsFixture();
  const killed = windows(f, {});
  assert.equal((await killed.command("acquire")).event, "acquired");
  const owner = JSON.parse(readFileSync(f.leasePath, "utf8"));
  await stop(killed);
  // A live unrelated process now has the dead owner's PID.
  const unrelated = await sleeper();
  const reused = { ...owner, pid: unrelated.pid };
  writeRecord(f.leasePath, reused);
  writeFileSync(identityOf(f.leasePath, reused), `${JSON.stringify({ version: 2, pid: unrelated.pid, token: owner.token })}\n`, { mode: 0o600 });
  const contender = windows(f, {});
  const outcome = await contender.command("acquire");
  assert.equal(outcome.event, "acquired");
  assert.equal(syncProbes(outcome).length, 0);
  assert.equal(existsSync(identityOf(f.leasePath, reused)), false);
  assert.equal(existsSync(heldOf(f.leasePath, reused)), false);
  assert.equal((await contender.command("release")).released, true);
  assert.equal(stillRunning(unrelated), true);
});

for (const [name, prepare] of [
  ["file is busy for any other reason", (f, owner) => { writeFileSync(heldOf(f.leasePath, owner), ""); writeFileSync(`${heldOf(f.leasePath, owner)}.busy`, ""); }],
  ["file is missing", () => {}],
]) {
  test(`Windows identity: a held identity keeps exclusion when its ${name}`, async () => {
    const f = windowsFixture();
    const holder = await sleeper();
    const owner = record(holder.pid);
    writeRecord(f.leasePath, owner);
    const identity = { version: 2, pid: owner.pid, token: owner.token };
    writeFileSync(identityOf(f.leasePath, owner), `${JSON.stringify(identity)}\n`, { mode: 0o600 });
    prepare(f, owner);
    const outcome = await windows(f, {}).command("acquire");
    assert.equal(outcome.code, "LEASE_BUSY");
    assert.deepEqual(JSON.parse(readFileSync(identityOf(f.leasePath, owner), "utf8")), identity);
    assert.equal(stillRunning(holder), true);
  });
}

test("Windows identity: a dead held identity on a reused PID is disproved by the open alone", async () => {
  const f = windowsFixture();
  const unrelated = await sleeper();
  const stale = record(unrelated.pid);
  writeRecord(f.leasePath, stale);
  writeHeldIdentity(f.leasePath, stale);
  const outcome = await windows(f, {}).command("inspect");
  assert.equal(outcome.result.status, "available");
  assert.equal(syncProbes(outcome).length, 0);
  assert.equal(stillRunning(unrelated), true);
});

test("Windows identity: non-Windows owners neither probe nor publish identities", { skip: process.platform === "win32" }, async () => {
  const f = windowsFixture();
  const holder = worker(f, { LEASE_TEST_PS: JSON.stringify({ self: "SELF_PID:133711112222333344" }) });
  const acquired = await holder.command("acquire");
  assert.equal(acquired.event, "acquired");
  const released = await holder.command("release");
  assert.equal(released.released, true);
  assert.deepEqual(released.probes, []);
  assert.deepEqual(readdirSync(f.root).filter((name) => name.includes(".identity-")), []);
});

test("Windows identity: contenders against a reused-PID record elect exactly one owner", async () => {
  const f = windowsFixture();
  const unrelated = await sleeper();
  const stale = record(unrelated.pid);
  writeRecord(f.leasePath, stale);
  writeIdentity(f.leasePath, stale, "133700000000000001");
  const answers = { [unrelated.pid]: `${unrelated.pid}:133700000000000002`, self: "SELF_PID:133799999999999999" };
  const contenders = Array.from({ length: 8 }, () => windows(f, answers));
  await Promise.all(contenders.map((item) => item.event("ready")));
  const outcomes = await Promise.all(contenders.map((item) => item.command("acquire")));
  assert.equal(outcomes.filter((outcome) => outcome.event === "acquired").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.event === "error").length, 7);
  for (const outcome of outcomes.filter((item) => item.event === "error")) {
    assert.ok(["LEASE_BUSY", "LEASE_RECOVERY_BUSY"].includes(outcome.code), outcome.code);
  }
  const winner = contenders[outcomes.findIndex((outcome) => outcome.event === "acquired")];
  assert.equal((await winner.command("release")).released, true);
  assert.equal(stillRunning(unrelated), true);
});

test("Windows identity: a reused-PID child record no longer blocks the primary; delegation validation adds no probe", async () => {
  const f = windowsFixture();
  const unrelated = await sleeper();
  const staleChild = record(unrelated.pid);
  writeRecord(f.childLeasePath, staleChild);
  writeIdentity(f.childLeasePath, staleChild, "133700000000000001");
  const answers = { [unrelated.pid]: `${unrelated.pid}:133700000000000002`, self: "SELF_PID:133799999999999999" };
  const parent = windows(f, answers);
  const parentReady = await parent.event("ready");
  assert.equal((await parent.command("acquire")).event, "acquired");
  // The primary guard only disregards the disproved child; the next child claim retires it.
  assert.deepEqual(JSON.parse(readFileSync(f.childLeasePath, "utf8")), staleChild);
  const { environment } = await parent.command("capability");
  const child = windows(f, answers, environment);
  const delegated = await child.command("acquire");
  assert.equal(delegated.event, "acquired");
  assert.equal(delegated.delegated, true);
  assert.equal(syncProbes(delegated).some((probe) => probe.pid === parentReady.pid), false);
  assert.ok(syncProbes(delegated).every((probe) => probe.pid === unrelated.pid));
  assert.notEqual(JSON.parse(readFileSync(f.childLeasePath, "utf8")).token, staleChild.token);
  assert.equal(existsSync(identityOf(f.childLeasePath, staleChild)), false);
  assert.equal((await child.command("release")).released, true);
  assert.equal((await parent.command("release")).released, true);
  assert.equal(stillRunning(unrelated), true);
});

test("Windows identity: inspection mirrors acquisition without changing records", async () => {
  const f = windowsFixture();
  const holder = await sleeper();
  const owner = record(holder.pid);
  writeRecord(f.leasePath, owner);
  writeIdentity(f.leasePath, owner, "133700000000000001");
  const snapshot = () => readdirSync(f.root).sort().map((name) => [name, lstatSync(join(f.root, name)).isFile() ? readFileSync(join(f.root, name), "utf8") : null]);
  const before = snapshot();
  const matching = windows(f, { [holder.pid]: `${holder.pid}:133700000000000001` });
  const blocked = await matching.command("inspect");
  assert.equal(blocked.result.status, "blocked");
  assert.equal(blocked.result.code, "LEASE_BUSY");
  const reused = windows(f, { [holder.pid]: `${holder.pid}:133700000000000002` });
  const available = await reused.command("inspect");
  assert.equal(available.result.status, "available");
  assert.equal(syncProbes(available).length, 1);
  assert.deepEqual(snapshot(), before);
  assert.equal(stillRunning(holder), true);
});

test("parent release clears the record of a child it watched exit cleanly, and still refuses any other live holder", () => {
  const f = fixture();
  const parent = acquireDataDirLease(f.dataDir);
  const child = acquireDataDirLeaseForProcess(f.dataDir, { ...parent.utilityServerLeaseEnvironment() });
  assert.equal(child.delegated, true);
  // No observation, a different pid, or a non-clean exit: the live holder keeps the guard.
  assert.throws(() => parent.release(), errorCode("LEASE_CHILD_BUSY"));
  assert.throws(() => parent.release({ exitedChildren: [{ pid: process.pid + 1, code: 0 }] }), errorCode("LEASE_CHILD_BUSY"));
  assert.throws(() => parent.release({ exitedChildren: [{ pid: process.pid, code: 1 }] }), errorCode("LEASE_CHILD_BUSY"));
  assert.throws(() => parent.release({ exitedChildren: [{ pid: process.pid, code: null }] }), errorCode("LEASE_CHILD_BUSY"));
  assert.equal(existsSync(f.childLeasePath), true);
  // The parent saw exactly this child exit with code 0 before it could release.
  assert.equal(parent.release({ exitedChildren: [{ pid: process.pid, code: 0 }] }), true);
  assert.equal(existsSync(f.childLeasePath), false);
  assert.equal(existsSync(f.leasePath), false);
});

// Rehearsal 2 (1.0.3, Cloud): a container starts its server as the same PID on
// every restart and shares the host's boot id, so the lease the previous start
// left behind named a live PID (this one) on the current boot, and every
// restart refused with LEASE_BUSY. A record naming this process is its own
// only while it holds that record's token.
test("a stale record naming this process's own PID on this boot is taken over (a restarted container)", { skip: process.platform === "win32" }, () => {
  const f = fixture("same-pid-restart");
  const mine = currentRecord(f);
  const left = record(process.pid, { boot: mine.boot, uptime: mine.uptime });
  writeRecord(f.leasePath, left);
  const lease = acquireDataDirLease(f.dataDir);
  const now = JSON.parse(readFileSync(f.leasePath, "utf8"));
  assert.equal(now.pid, process.pid);
  assert.notEqual(now.token, left.token);
  assert.equal(inspectDataDirLease(f.dataDir).code, "LEASE_BUSY");
  assert.equal(lease.release(), true);
  // the same with no boot identity recorded (older records)
  writeRecord(f.leasePath, record(process.pid));
  acquireDataDirLease(f.dataDir).release();
});

test("a stale child record naming this process's own PID is taken over by the delegated server", async () => {
  const f = fixture("same-pid-child");
  const parent = await sleeper();
  const parentRecord = record(parent.pid);
  writeRecord(f.leasePath, parentRecord);
  writeRecord(f.childLeasePath, record(process.pid));
  const env = { MURAGE_INTERNAL_DATA_DIR_LEASE: `v1:${parent.pid}:${parentRecord.token}` };
  const child = acquireDataDirLeaseForProcess(f.dataDir, env);
  assert.equal(child.delegated, true);
  assert.equal(JSON.parse(readFileSync(f.childLeasePath, "utf8")).pid, process.pid);
  assert.equal(child.release(), true);
  rmSync(f.leasePath); // the planted parent's record
});

test("the lease stays strict: a held lease refuses this process again, and a live second process is refused", async () => {
  const f = fixture("same-pid-strict");
  const held = acquireDataDirLease(f.dataDir);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  const second = worker(f);
  await second.event("ready");
  assert.equal((await second.command("acquire")).code, "LEASE_BUSY");
  assert.equal(held.release(), true);
  // and the other way round: a live other server holds it, this one is refused
  assert.equal((await second.command("acquire")).event, "acquired");
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  assert.equal((await second.command("release")).released, true);
  // a token this process released no longer counts as live
  const again = acquireDataDirLease(f.dataDir);
  const released = JSON.parse(readFileSync(f.leasePath, "utf8"));
  assert.equal(again.release(), true);
  writeRecord(f.leasePath, released);
  acquireDataDirLease(f.dataDir).release();
});

// A thread of this process (the backup host's worker, the B21 test's isolated worker) cannot see the tokens the main thread holds: each
// thread has its own module copy. A record naming this PID is this running process there, so delegation from the main thread's live lease
// holds; only the thread that claims can tell its own stale record from a live one (the Cloud restart case above, on the main thread).
test("a worker thread of this process takes a delegated child lease from the lease its main thread holds", async () => {
  const { Worker } = await import("node:worker_threads");
  const f = fixture();
  const parent = acquireDataDirLease(f.dataDir);
  try {
    const environment = parent.utilityServerLeaseEnvironment();
    const moduleUrl = new URL("./data-dir-lease.mjs", import.meta.url).href;
    const code = `const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.moduleUrl).then(({ acquireDataDirLeaseForProcess }) => {
        try { const lease = acquireDataDirLeaseForProcess(workerData.dataDir, { ...workerData.environment }); lease.release(); parentPort.postMessage({ ok: true }); }
        catch (error) { parentPort.postMessage({ ok: false, code: error?.code ?? String(error) }); }
      });`;
    const worker = new Worker(code, { eval: true, workerData: { moduleUrl, dataDir: f.dataDir, environment } });
    const message = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    await worker.terminate();
    assert.deepEqual(message, { ok: true });
  } finally { parent.release(); }
});

// A handle that finds its record taken over refuses to release it, and still lets go of what is its own: on Windows the share-none
// file it holds open (and that file's identity). Kept open, the handle pinned the file for the life of the process, so its folder
// could never be removed (EPERM) and the identity kept claiming an owner that no longer was one.
test("Windows identity: a stale handle refused its release still lets go of its own held file and identity", async () => {
  const f = windowsFixture();
  const holder = windows(f, {});
  assert.equal((await holder.command("acquire")).event, "acquired");
  const owner = JSON.parse(readFileSync(f.leasePath, "utf8"));
  assert.equal(existsSync(identityOf(f.leasePath, owner)), true);
  const foreign = record(LIVE_OTHER_PID);
  writeRecord(f.leasePath, foreign);
  const refused = await holder.command("release");
  assert.equal(refused.code, "LEASE_NOT_OWNED");
  assert.equal(existsSync(heldOf(f.leasePath, owner)), false);
  assert.equal(existsSync(identityOf(f.leasePath, owner)), false);
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), foreign);
  rmSync(f.leasePath); // the foreign record names a live process; the fixture folder is wiped after
});

// A parent that clears the record of a child it watched exit cleanly clears that child's identity and held file with it (the
// child's process is gone; its leftovers are its own, token-scoped).
test("parent release that clears an exited child's record also clears the child's identity and held file", () => {
  const f = fixture();
  const parent = acquireDataDirLease(f.dataDir);
  const child = acquireDataDirLeaseForProcess(f.dataDir, { ...parent.utilityServerLeaseEnvironment() });
  const childOwner = JSON.parse(readFileSync(f.childLeasePath, "utf8"));
  if (process.platform !== "win32") {
    writeFileSync(heldOf(f.childLeasePath, childOwner), "", { mode: 0o600 });
    writeFileSync(identityOf(f.childLeasePath, childOwner), `${JSON.stringify({ version: 2, pid: childOwner.pid, token: childOwner.token })}\n`, { mode: 0o600 });
  }
  assert.equal(existsSync(identityOf(f.childLeasePath, childOwner)), true);
  assert.equal(parent.release({ exitedChildren: [{ pid: process.pid, code: 0 }] }), true);
  assert.equal(existsSync(f.childLeasePath), false);
  assert.equal(existsSync(identityOf(f.childLeasePath, childOwner)), false);
  assert.equal(existsSync(heldOf(f.childLeasePath, childOwner)), false);
  // the in-process child handle finds its record cleared by the parent
  assert.throws(() => child.release(), errorCode("LEASE_NOT_OWNED"));
});
