// SPDX-License-Identifier: Apache-2.0
// 1.0.19 Macs stuck on "Restore or recover Murage": a lock left by an unclean
// end (an interrupted update, a force quit) and then a restart on another
// network carries an old host name and an old boot, so it read as another
// computer's at every start (LEASE_FOREIGN_HOST). Each owner and checker here
// is a real, disposable Node process running the real lock module; only what
// the Mac would answer (its name, Bonjour name, hardware UUID, boot session)
// is supplied, before the module loads. The dead owners are SIGKILLed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const MODULE = process.env.MURAGE_LEASE_MODULE_UNDER_TEST ?? new URL("./data-dir-lease.mjs", import.meta.url).href;
// The released 1.0.18 lock module may write the older record (evidence runs); by default this one, with no hardware UUID, writes the same bytes.
const LEGACY_WRITER = process.env.MURAGE_LEASE_LEGACY_WRITER ?? MODULE;
const MAC_A = "4C4C4544-0042-3510-8030-B4C04F4D3132";
const MAC_B = "564D2A1E-7C7F-4B1A-9E2B-8F2D0C6A1B77";
const BOOT_1 = "6f1d2c3b-4a59-4e6f-8a7b-1c2d3e4f5a61";
const BOOT_2 = "0a9b8c7d-6e5f-4a3b-9c1d-2e3f4a5b6c72";
const roots = [];

// One Mac as the module sees it. ioreg null: the hardware UUID can't be read
// (as on 1.0.18 and 1.0.19, which never asked for it).
const studioAtHome = { hostname: "studio-mac.local", localHostName: "studio-mac", ioreg: MAC_A, boot: BOOT_1 };
const studioAtWork = { hostname: "dhcp-17.corp.invalid", localHostName: "studio-mac", ioreg: MAC_A, boot: BOOT_2 };
const otherMac = { hostname: "other-mac.local", localHostName: "other-mac", ioreg: MAC_B, boot: BOOT_2 };

const WORKER = `
const [moduleUrl, dataDir, action, macJson] = process.argv.slice(1);
const mac = JSON.parse(macJson);
const os = await import("node:os");
const childProcess = await import("node:child_process");
const { syncBuiltinESMExports } = await import("node:module");
Object.defineProperty(process, "platform", { value: mac.platform ?? "darwin" });
os.default.hostname = () => mac.hostname;
const realExec = childProcess.default.execFileSync;
childProcess.default.execFileSync = (file, args, options) => {
  if (file === "/usr/sbin/sysctl" && args.join(" ") === "-n kern.bootsessionuuid") return mac.boot + "\\n";
  if (file === "/usr/sbin/scutil" && args[0] === "--get") {
    const value = args[1] === "LocalHostName" ? mac.localHostName : args[1] === "HostName" ? mac.hostName : undefined;
    if (value) return value + "\\n";
    throw Object.assign(new Error(args[1] + ": not set"), { status: 1 });
  }
  if (file === "/usr/sbin/ioreg") {
    if (!mac.ioreg) throw Object.assign(new Error("ioreg unavailable"), { status: 1 });
    return '+-o J314sAP  <class IOPlatformExpertDevice>\\n    "IOPlatformSerialNumber" = "FIXTURE0001"\\n    "IOPlatformUUID" = "' + mac.ioreg + '"\\n';
  }
  return realExec(file, args, options);
};
syncBuiltinESMExports();
const lease = await import(moduleUrl);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
try {
  if (action === "own-and-die") {
    lease.acquireDataDirLease(dataDir);
    out({ ok: true });
    process.kill(process.pid, "SIGKILL");
  } else if (action === "own-with-child-and-die") {
    const primary = lease.acquireDataDirLease(dataDir);
    const env = { ...primary.utilityServerLeaseEnvironment() };
    lease.acquireDataDirLeaseForProcess(dataDir, env);
    out({ ok: true });
    process.kill(process.pid, "SIGKILL");
  } else if (action === "own-and-hold") {
    lease.acquireDataDirLease(dataDir);
    out({ ok: true, pid: process.pid });
    setInterval(() => {}, 1000);
  } else if (action === "start-with-child-and-release") {
    // A normal start: the shell takes the lock, its server child takes the child lock, both let go.
    const primary = lease.acquireDataDirLease(dataDir);
    const child = lease.acquireDataDirLeaseForProcess(dataDir, { ...primary.utilityServerLeaseEnvironment() });
    out({ ok: true, released: child.release() && primary.release() });
  } else if (action === "acquire-and-release") {
    const owner = lease.acquireDataDirLease(dataDir);
    out({ ok: true, released: owner.release() });
  } else if (action === "acquire-and-die") {
    lease.acquireDataDirLease(dataDir);
    out({ ok: true });
    process.kill(process.pid, "SIGKILL");
  } else if (action === "inspect") {
    out({ ok: true, inspection: lease.inspectDataDirLease(dataDir) });
  } else throw new Error("unknown action");
} catch (error) { out({ ok: false, code: error?.code ?? String(error) }); }
`;

function run(dataDir, action, mac, module = MODULE) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", WORKER, module, dataDir, action, JSON.stringify(mac)], { encoding: "utf8", timeout: 20_000 });
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, `worker ${action} printed nothing: ${result.stderr}`);
  return JSON.parse(line);
}

// A data folder shaped like a 1.0.18 install that 1.0.19 opened once.
function installation(name) {
  const root = mkdtempSync(join(tmpdir(), "murage-lease-stuck-"));
  roots.push(root);
  const dataDir = join(root, name);
  mkdirSync(join(dataDir, "workspaces", "fixture-bot"), { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ version: 1, instances: {} }));
  writeFileSync(join(dataDir, "messages.db"), Buffer.alloc(8192, 7));
  writeFileSync(join(dataDir, "memory-upgrade-status.json"), "{}");
  writeFileSync(join(dataDir, "workspaces", "fixture-bot", "notes.md"), "kept\n");
  return { root, dataDir };
}
const digestTree = (dir) => {
  const hash = createHash("sha256");
  const walk = (at) => { for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(at, entry.name); hash.update(full.slice(dir.length));
    if (entry.isDirectory()) walk(full); else hash.update(readFileSync(full));
  } };
  walk(dir);
  return hash.digest("hex");
};
const lockFiles = (dataDir) => readdirSync(dirname(dataDir)).filter((name) => name.startsWith(".murage-data-owner-")).sort();
const snapshot = (dataDir) => Object.fromEntries(lockFiles(dataDir).map((name) => [name, readFileSync(join(dirname(dataDir), name), "utf8")]));
const primaryRecord = (dataDir) => {
  const name = lockFiles(dataDir).find((file) => file.endsWith(".lease"));
  return name ? JSON.parse(readFileSync(join(dirname(dataDir), name), "utf8")) : null;
};

test.after(() => { for (const root of roots) safeWipeSync(root); });

test("same Mac, renamed by another network after a restart: the lock an update left is cleared and Murage starts", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-with-child-and-die", studioAtWork).ok, true);
  const stale = primaryRecord(dataDir);
  assert.equal(stale.host, "dhcp-17.corp.invalid");
  const before = digestTree(dataDir);
  const back = { ...studioAtHome, boot: "9e8d7c6b-5a49-4f3e-8d2c-1b0a9f8e7d63" };
  const result = run(dataDir, "start-with-child-and-release", back);
  assert.deepEqual(result, { ok: true, released: true });
  assert.deepEqual(lockFiles(dataDir).filter((name) => !name.includes(".reap-")), [], "the dead owner's lock, child lock and notes are gone");
  assert.equal(digestTree(dataDir), before, "nothing inside the data folder changed");
});

test("a lock from before the machine note (1.0.18/1.0.19) under this Mac's own Bonjour name is cleared", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-and-die", { ...studioAtHome, ioreg: null }, LEGACY_WRITER).ok, true);
  assert.ok(!lockFiles(dataDir).some((name) => name.includes(".machine-")), "an older owner leaves no note");
  const before = digestTree(dataDir);
  assert.deepEqual(run(dataDir, "acquire-and-release", studioAtWork), { ok: true, released: true });
  assert.equal(digestTree(dataDir), before);
});

test("another computer's lock still shows recovery and is left exactly as it was", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-and-die", studioAtHome).ok, true);
  const before = snapshot(dataDir);
  assert.deepEqual(run(dataDir, "acquire-and-release", otherMac), { ok: false, code: "LEASE_FOREIGN_HOST" });
  assert.equal(run(dataDir, "inspect", otherMac).inspection.code, "LEASE_FOREIGN_HOST");
  assert.deepEqual(snapshot(dataDir), before);
});

test("another computer that copied this Mac's name but not its hardware still fails closed", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-and-die", studioAtHome).ok, true);
  const before = snapshot(dataDir);
  const lookalike = { ...otherMac, localHostName: "studio-mac", hostname: "dhcp-40.corp.invalid", boot: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b94" };
  assert.deepEqual(run(dataDir, "acquire-and-release", lookalike), { ok: false, code: "LEASE_FOREIGN_HOST" });
  assert.deepEqual(snapshot(dataDir), before);
});

test("an older lock under a name that is not this Mac's still fails closed", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-and-die", { ...studioAtWork, ioreg: null }, LEGACY_WRITER).ok, true);
  const before = snapshot(dataDir);
  assert.deepEqual(run(dataDir, "acquire-and-release", { ...studioAtHome, boot: BOOT_1 }), { ok: false, code: "LEASE_FOREIGN_HOST" });
  assert.deepEqual(snapshot(dataDir), before);
});

test("a note naming this Mac never makes a live owner's lock free", async () => {
  const { dataDir } = installation("data");
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", WORKER, MODULE, dataDir, "own-and-hold", JSON.stringify(studioAtWork)], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const first = await new Promise((resolve, reject) => {
      holder.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk).trim().split("\n")[0])));
      holder.once("exit", () => reject(new Error("holder exited")));
    });
    assert.equal(first.ok, true);
    const before = snapshot(dataDir);
    // Same boot (so no restart proves it dead), another network name.
    assert.deepEqual(run(dataDir, "acquire-and-release", { ...studioAtHome, boot: BOOT_2 }), { ok: false, code: "LEASE_BUSY" });
    assert.deepEqual(snapshot(dataDir), before);
  } finally {
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.exitCode !== null || holder.signalCode !== null ? resolve() : holder.once("exit", resolve));
  }
});

test("the recovery window's inspection agrees: this Mac's renamed lock reads as available", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "own-and-die", studioAtWork).ok, true);
  const inspection = run(dataDir, "inspect", { ...studioAtHome, boot: BOOT_1 }).inspection;
  assert.equal(inspection.status, "available");
  assert.equal(inspection.code, null);
});

test("a clean release leaves no machine note behind, and a new owner writes one", () => {
  const { dataDir } = installation("data");
  assert.deepEqual(run(dataDir, "acquire-and-release", studioAtHome), { ok: true, released: true });
  assert.deepEqual(lockFiles(dataDir), []);
  assert.equal(run(dataDir, "acquire-and-die", studioAtHome).ok, true);
  const notes = lockFiles(dataDir).filter((name) => name.includes(".machine-"));
  assert.equal(notes.length, 1);
  const note = JSON.parse(readFileSync(join(dirname(dataDir), notes[0]), "utf8"));
  assert.deepEqual(Object.keys(note).sort(), ["machine", "token", "version"]);
  assert.equal(note.token, primaryRecord(dataDir).token);
  assert.ok(!readFileSync(join(dirname(dataDir), notes[0]), "utf8").toLowerCase().includes(MAC_A.toLowerCase()), "only a hash of the hardware UUID is stored");
  assert.equal(basename(notes[0]).startsWith(".murage-data-owner-"), true);
  assert.equal(existsSync(dataDir), true);
});

test("Linux writes no machine note: one container image can carry the same machine-id onto many computers", () => {
  const { dataDir } = installation("data");
  assert.equal(run(dataDir, "acquire-and-die", { ...studioAtHome, platform: "linux" }).ok, true);
  assert.deepEqual(lockFiles(dataDir).filter((name) => name.includes(".machine-")), []);
});
