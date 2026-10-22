// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A sidecar a crashed desktop left behind is stopped on the next start. The
// only process ever stopped is the one the OS reports listening on the port,
// and only when it answers the token the last launch recorded. A recorded pid
// on its own never gets anything killed: pids are reused.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SIDECAR_PID_FILE, forgetSidecar, listeningPid, procListeningPids, recordSidecar, safeStorageSeal, stopStaleSidecar } from "./companion-stale.mjs";

const TOKEN = "k".repeat(43);
const OTHER_TOKEN = "z".repeat(43);
const dirs = [];
const children = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
});
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "murage-stale-")); dirs.push(dir); return dir; };
/** A stand-in for the credential store: reversible, and never the plain text. */
const SEAL = {
  available: async () => true,
  encrypt: async (text) => Buffer.from(`sealed:${Buffer.from(text).toString("base64").split("").reverse().join("")}`),
  decrypt: async (bytes) => {
    const text = bytes.toString();
    if (!text.startsWith("sealed:")) throw new Error("not sealed");
    return Buffer.from(text.slice(7).split("").reverse().join(""), "base64").toString();
  },
};
const NO_SEAL = { available: async () => false, encrypt: async () => { throw new Error("must not encrypt"); }, decrypt: async () => { throw new Error("must not decrypt"); } };
const record = async (dir, pid, recoveryToken = TOKEN) => writeFileSync(path.join(dir, SIDECAR_PID_FILE), await SEAL.encrypt(JSON.stringify({ pid, recoveryToken })));

const freePort = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

/** A real process on the control port that answers the recovery secret the
 * way control.ts does: GET /state gives its pid, POST /recovery/stop answers
 * 202 and exits (unless `stubborn`, which agrees and stays), anything else 403. */
async function sidecarStandIn(port, token, { stubborn = false } = {}) {
  const script = `
    const token = ${JSON.stringify(token)};
    require("node:http").createServer((q, s) => {
      const ok = q.headers["x-murage-recovery-token"] === token;
      const send = (status, body) => { s.writeHead(status, { "content-type": "application/json" }); s.end(JSON.stringify(body)); };
      if (ok && q.method === "GET" && q.url === "/state") return send(200, { pid: process.pid });
      if (ok && q.method === "POST" && q.url === "/recovery/stop") { send(202, { stopping: true }); if (!${stubborn}) setTimeout(() => process.exit(0), 50); return; }
      send(403, { error: "forbidden" });
    }).listen(${port}, "127.0.0.1", () => process.stdout.write("up\\n"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", () => reject(new Error("stand-in exited early")));
  });
  return child;
}

/** An unrelated long-lived process, standing in for a recycled pid. */
function stranger() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104",
  "  TCP    127.0.0.1:8811         0.0.0.0:0              LISTENING       7340",
  "  TCP    127.0.0.1:8811         127.0.0.1:50321        ESTABLISHED     7340",
  "  TCP    127.0.0.1:50321        127.0.0.1:8811         ESTABLISHED     9001",
  "  TCP    [::]:445               [::]:0                 LISTENING       4",
  "",
].join("\r\n");
describe("a sidecar a crashed desktop left behind", () => {
  it("asks our left-behind sidecar to stop itself, and kills nothing", async () => {
    const dir = tempDir();
    const port = await freePort();
    const ours = await sidecarStandIn(port, TOKEN);
    expect(await recordSidecar(dir, { pid: ours.pid, recoveryToken: TOKEN }, SEAL)).toBe("recorded");
    const exited = new Promise((resolve) => ours.once("exit", resolve));
    const outcome = await stopStaleSidecar({ dir, controlPort: port, seal: SEAL, kill: () => { throw new Error("must not kill"); } });
    expect(outcome).toBe("stopped-itself");
    await exited;
    expect(existsSync(path.join(dir, SIDECAR_PID_FILE))).toBe(false);
    expect(await fetch(`http://127.0.0.1:${port}/state`).then(() => true, () => false)).toBe(false);
  });

  it("falls back to stopping the OS-reported listener when it does not stop itself", async () => {
    const dir = tempDir();
    const port = await freePort();
    const ours = await sidecarStandIn(port, TOKEN, { stubborn: true });
    expect(await recordSidecar(dir, { pid: ours.pid, recoveryToken: TOKEN }, SEAL)).toBe("recorded");
    const exited = new Promise((resolve) => ours.once("exit", resolve));
    // The real OS lookup, not a mock.
    const outcome = await stopStaleSidecar({ dir, controlPort: port, seal: SEAL });
    expect(outcome).toBe("stopped");
    await exited;
    expect(existsSync(path.join(dir, SIDECAR_PID_FILE))).toBe(false);
    expect(await fetch(`http://127.0.0.1:${port}/state`).then(() => true, () => false)).toBe(false);
  });

  it("kills nothing when the recorded pid is alive but is not the listener", async () => {
    const dir = tempDir();
    const port = await freePort();
    // agrees to stop but stays, so the fallback has to decide
    const listener = await sidecarStandIn(port, TOKEN, { stubborn: true });
    const recycled = stranger();
    await record(dir, recycled.pid);
    const kills = [];
    // The OS names a different process on the port than the one the sidecar
    // reports: not provably ours, so nothing happens.
    const outcome = await stopStaleSidecar({ dir, controlPort: port, seal: SEAL, portOwner: async () => recycled.pid, kill: (pid, signal) => kills.push([pid, signal]) });
    expect(outcome).toBe("not-ours");
    expect(kills).toEqual([]);
    expect(alive(recycled.pid)).toBe(true);
    expect(alive(listener.pid)).toBe(true);
    expect(existsSync(path.join(dir, SIDECAR_PID_FILE))).toBe(false);
  });

  it("never stops a foreign listener that does not answer our token", async () => {
    const dir = tempDir();
    const port = await freePort();
    const foreign = await sidecarStandIn(port, OTHER_TOKEN);
    await record(dir, foreign.pid);
    const kills = [];
    const outcome = await stopStaleSidecar({ dir, controlPort: port, seal: SEAL, portOwner: async () => foreign.pid, kill: (pid, signal) => kills.push([pid, signal]) });
    expect(outcome).toBe("not-ours");
    expect(kills).toEqual([]);
    expect(alive(foreign.pid)).toBe(true);
  });

  it("kills nothing when the port is free, even with a live recorded pid", async () => {
    const dir = tempDir();
    const recycled = stranger();
    await record(dir, recycled.pid);
    const outcome = await stopStaleSidecar({ dir, controlPort: await freePort(), seal: SEAL, kill: () => { throw new Error("must not kill"); } });
    expect(outcome).toBe("not-ours");
    expect(alive(recycled.pid)).toBe(true);
  });

  it("does nothing with no record, and drops a malformed one untouched", async () => {
    const dir = tempDir();
    expect(await stopStaleSidecar({ dir, controlPort: 1, seal: SEAL })).toBe("none");
    // a plain-text record (an older build, or written by anything else) is never trusted
    const plain = [Buffer.from(JSON.stringify({ pid: 4242, recoveryToken: TOKEN }))];
    for (const text of ["", "4242", "{\"pid\":4242}", JSON.stringify({ pid: 1, recoveryToken: TOKEN }), JSON.stringify({ pid: 4242, recoveryToken: "short" })]) plain.push(await SEAL.encrypt(text));
    for (const bad of plain) {
      writeFileSync(path.join(dir, SIDECAR_PID_FILE), bad);
      expect(await stopStaleSidecar({ dir, controlPort: 1, seal: SEAL, probe: async () => { throw new Error("must not probe"); }, kill: () => { throw new Error("must not kill"); } })).toBe("not-ours");
      expect(existsSync(path.join(dir, SIDECAR_PID_FILE))).toBe(false);
    }
  });

  it("escalates when the sidecar ignores the polite stop, and stops only the listener", async () => {
    const dir = tempDir();
    await record(dir, 4242);
    const signals = [];
    let up = true;
    const outcome = await stopStaleSidecar({
      dir, controlPort: 1, seal: SEAL, probe: async () => ({ status: 200, pid: 5555 }), requestStop: async () => false, portOwner: async () => 5555,
      isAlive: () => up, sleep: async () => {},
      kill: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL") up = false; },
    });
    expect(outcome).toBe("stopped");
    expect(signals).toEqual([[5555, "SIGTERM"], [5555, "SIGKILL"]]);
  });

  it("records the pid and token encrypted and owner-only, and a clean exit forgets only its own", async () => {
    const dir = tempDir();
    expect(await recordSidecar(dir, { pid: 5150, recoveryToken: TOKEN }, SEAL)).toBe("recorded");
    const file = path.join(dir, SIDECAR_PID_FILE);
    const bytes = readFileSync(file);
    expect(bytes.toString()).not.toContain(TOKEN);
    expect(bytes.toString()).not.toContain("5150");
    expect(JSON.parse(await SEAL.decrypt(bytes))).toEqual({ pid: 5150, recoveryToken: TOKEN });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    await forgetSidecar(dir, 9999, SEAL);
    expect(existsSync(file)).toBe(true);
    await forgetSidecar(dir, 5150, SEAL);
    expect(existsSync(file)).toBe(false);
    expect(await recordSidecar(dir, { pid: 5150, recoveryToken: "short" }, SEAL)).toBe("unsealed");
    expect(existsSync(file)).toBe(false);
  });

  it("without the credential store: no token on disk, no recovery, nothing killed", async () => {
    const dir = tempDir();
    const file = path.join(dir, SIDECAR_PID_FILE);
    for (const seal of [NO_SEAL, null, undefined]) {
      // an older record is removed rather than left readable
      writeFileSync(file, "left over");
      expect(await recordSidecar(dir, { pid: 5150, recoveryToken: TOKEN }, seal)).toBe("unsealed");
      expect(existsSync(file)).toBe(false);
      await record(dir, 4242);
      expect(await stopStaleSidecar({
        dir, controlPort: 1, seal,
        probe: async () => { throw new Error("must not probe"); },
        portOwner: async () => { throw new Error("must not look up"); },
        kill: () => { throw new Error("must not kill"); },
      })).toBe("unsealed");
      expect(existsSync(file)).toBe(false);
    }
  });

  it("uses Electron safeStorage only where it truly encrypts, never a plain-text fallback", async () => {
    const calls = [];
    const store = (backend, available = true) => ({
      getSelectedStorageBackend: () => backend,
      isAsyncEncryptionAvailable: async () => available,
      encryptStringAsync: async (text) => { calls.push(text); return Buffer.from("x"); },
      decryptStringAsync: async () => ({ result: "{}" }),
    });
    expect(await safeStorageSeal(store("keychain"), "darwin").available()).toBe(true);
    expect(await safeStorageSeal(store("gnome_libsecret"), "linux").available()).toBe(true);
    expect(await safeStorageSeal(store("basic_text"), "linux").available()).toBe(false);
    expect(await safeStorageSeal(store("keychain", false), "darwin").available()).toBe(false);
    expect(await safeStorageSeal(undefined, "darwin").available()).toBe(false);
    // the person's own plain-text opt-in for keys does not reach this record
    const before = process.env.MURAGE_ALLOW_PLAINTEXT_SECRETS;
    process.env.MURAGE_ALLOW_PLAINTEXT_SECRETS = "1";
    try {
      expect(await safeStorageSeal(store("basic_text"), "linux").available()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.MURAGE_ALLOW_PLAINTEXT_SECRETS; else process.env.MURAGE_ALLOW_PLAINTEXT_SECRETS = before;
    }
    expect(await safeStorageSeal(store("keychain"), "darwin").decrypt(Buffer.from("x"))).toBe("{}");
  });
});

describe("the port owner lookup", () => {
  it.skipIf(process.platform === "win32")("finds the real listener's pid with the OS tools on this machine", async () => {
    const port = await freePort();
    const listener = await sidecarStandIn(port, TOKEN);
    expect(await listeningPid(port)).toBe(listener.pid);
    if (process.platform === "linux") expect([...procListeningPids(port)]).toEqual([listener.pid]);
    // and nothing for a port nobody listens on
    expect(await listeningPid(await freePort())).toBeNull();
  });

  it("with no lookup tool and no /proc, names no one, so nothing is stopped", async () => {
    const missing = async () => "";
    const noProc = { readFile: () => { throw new Error("ENOENT"); }, readdir: () => { throw new Error("ENOENT"); }, readlink: () => { throw new Error("ENOENT"); } };
    for (const platform of ["linux", "darwin"]) expect(await listeningPid(8811, platform, missing, noProc)).toBeNull();
    const dir = tempDir();
    await record(dir, 4242);
    expect(await stopStaleSidecar({
      dir, controlPort: 8811, seal: SEAL, probe: async () => ({ status: 200, pid: 4242 }), requestStop: async () => false,
      portOwner: (port) => listeningPid(port, "linux", missing, noProc),
      kill: () => { throw new Error("must not kill"); },
    })).toBe("not-ours");
  });

  it("on Windows asks netstat.exe (no PowerShell) and takes the single owning pid of the listening row", async () => {
    const calls = [];
    const pid = await listeningPid(8811, "win32", async (command, args) => { calls.push([command, args.join(" ")]); return NETSTAT; });
    expect(pid).toBe(7340);
    expect(calls[0][0]).toMatch(/System32.netstat\.exe$/);
    expect(calls[0][1]).toBe("-ano -p tcp");
  });

  it("on Windows a Windows listener is replaced only through that lookup", async () => {
    const dir = tempDir();
    await record(dir, 4242);
    const kills = [];
    const portOwner = (port) => listeningPid(port, "win32", async () => NETSTAT);
    expect(await stopStaleSidecar({ dir, controlPort: 8811, seal: SEAL, probe: async () => ({ status: 200, pid: 7340 }), requestStop: async () => false, portOwner, isAlive: () => false, kill: (p, s) => kills.push([p, s]) })).toBe("stopped");
    expect(kills).toEqual([[7340, "SIGTERM"]]);
    await record(dir, 4242);
    kills.length = 0;
    // the recorded pid answers nothing on its own: the listener differs from what the sidecar reports
    expect(await stopStaleSidecar({ dir, controlPort: 8811, seal: SEAL, probe: async () => ({ status: 200, pid: 4242 }), requestStop: async () => false, portOwner, kill: (p, s) => kills.push([p, s]) })).toBe("not-ours");
    expect(kills).toEqual([]);
  });

  it("gives no answer when the OS names no listener or more than one", async () => {
    expect(await listeningPid(8811, "win32", async () => "")).toBeNull();
    expect(await listeningPid(8811, "win32", async () => NETSTAT + "  TCP    0.0.0.0:8811           0.0.0.0:0              LISTENING       11\r\n")).toBeNull();
    expect(await listeningPid(8811, "darwin", async () => "")).toBeNull();
    expect(await listeningPid(8811, "darwin", async () => "321\n")).toBe(321);
    expect(await listeningPid(8811, "linux", async (command) => command === "ss" ? "LISTEN 0 511 127.0.0.1:8811 0.0.0.0:* users:((\"node\",pid=999,fd=21))" : "")).toBe(999);
  });
});
