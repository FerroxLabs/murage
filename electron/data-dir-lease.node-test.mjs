// SPDX-License-Identifier: Apache-2.0
// Protocol cases adapted from OpenMausBot v0.1.54; see data-dir-lease.mjs.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { acquireDataDirLease, acquireDataDirLeaseForProcess, dataDirLeasePaths, inspectDataDirLease } from "./data-dir-lease.mjs";

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
  import cp from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
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
        process.send({event:'acquired', pid:process.pid, delegated:lease.delegated, consumed:process.env[${JSON.stringify(PRIVATE_ENV)}] === undefined});
      } else if (message.command === 'capability') {
        process.send({event:'capability', environment:lease.utilityServerLeaseEnvironment()});
      } else if (message.command === 'release') {
        process.send({event:'released', released:lease.release()});
      } else if (message.command === 'generic-child') {
        const result = spawnSync(process.execPath, ['--eval', 'process.stdout.write(process.env.${PRIVATE_ENV} === undefined ? "absent" : "present")'], {env:process.env,encoding:'utf8'});
        process.send({event:'generic-child', inherited:result.stdout !== 'absent'});
      } else if (message.command === 'exit') process.exit(0);
    } catch (error) {
      process.send({event:'error', code:error.code, message:error.message, hasCause:error.cause !== undefined, attempts});
    }
  });
  process.send({event:'ready'});
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

const record = (pid, extra = {}) => ({ version: 1, pid, host: hostname(), token: randomUUID(), createdAt: Date.now() - 1000, ...extra });
const writeRecord = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const errorCode = (code) => (error) => error.name === "DataDirLeaseError" && error.code === code;

test.afterEach(async () => {
  for (const item of [...workers]) await stop(item);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("stable sibling anchors do not create the installation or migrate legacy data", () => {
  const f = fixture();
  rmSync(f.dataDir, { recursive: true });
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
  writeRecord(f.leasePath, record(process.pid));
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
  writeRecord(f.childLeasePath, record(process.pid));
  assert.equal(inspectDataDirLease(f.dataDir).code, "LEASE_CHILD_BUSY");
  rmSync(f.childLeasePath);
  writeRecord(f.leasePath, record(process.pid));
  assert.equal(inspectDataDirLease(f.dataDir).code, "LEASE_BUSY");
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(oldReaper)}\n`);
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
  const active = record(process.pid, { targetToken: stale.token });
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
  writeRecord(f.leasePath, owner);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  const legacy = record(process.pid);
  writeRecord(f.leasePath, legacy);
  assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), legacy);
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
    writeRecord(f.leasePath, record(process.pid, extra));
    assert.throws(() => acquireDataDirLease(f.dataDir), errorCode("LEASE_BUSY"));
  }
});

test("changed boot metadata invalidates an old release handle", () => {
  const f = fixture();
  const lease = acquireDataDirLease(f.dataDir);
  const changed = { ...JSON.parse(readFileSync(f.leasePath, "utf8")), boot: randomUUID() };
  writeRecord(f.leasePath, changed);
  assert.throws(() => lease.release(), errorCode("LEASE_NOT_OWNED"));
  assert.deepEqual(JSON.parse(readFileSync(f.leasePath, "utf8")), changed);
});
