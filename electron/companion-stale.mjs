// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A companion sidecar left running by a desktop that crashed.
//
// The control port only answers the token of the launch that started it, so a
// new desktop cannot drive a sidecar the last one left behind. Without this,
// the person would see "port 8811 is already serving another companion" and
// have to find and stop it by hand.
//
// Each start gives the sidecar a random per-launch RECOVERY secret, separate
// from the control token, and records {pid, recoveryToken} in a file in the
// app's own folder, encrypted with the operating system's credential store
// (Electron safeStorage); a clean exit removes it. The recovery secret opens
// only two routes on the sidecar (companion/src/control.ts): GET /state,
// which answers with the pid alone, and POST /recovery/stop. It never opens
// pairing, devices or pairing data, so even a stolen copy cannot pair a phone.
// Where the credential store is not available (or on Linux is only the
// obfuscating "basic_text" backend), nothing is recorded and recovery is
// skipped: the person sees the plain "stop it and try again" message.
//
// On the next start: the port holder counts as ours only when GET /state
// answers 200 for the recorded secret. It is then asked to stop itself. Only
// if it does not, the process the operating system reports listening on the
// port, which must also be the pid the sidecar named, is stopped. The recorded
// pid is never killed on its own say-so: a pid can be reused after a crash.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { secretWriteRefusal } from "./secret-storage-policy.mjs";

export const SIDECAR_PID_FILE = "companion-sidecar.pid";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** The credential store, as this module uses it. `available` says whether a
 * record may be written: never with a plain-text fallback, whatever the
 * person allowed for their own keys. */
export function safeStorageSeal(safeStorage, platform = process.platform) {
  return {
    async available() {
      if (!safeStorage) return false;
      try {
        return (await secretWriteRefusal({ safeStorage, platform, env: {} })) === null;
      } catch {
        return false;
      }
    },
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    async decrypt(buffer) {
      const decrypted = await safeStorage.decryptStringAsync(buffer);
      return typeof decrypted === "string" ? decrypted : decrypted?.result;
    },
  };
}

async function sealAvailable(seal) {
  try {
    return Boolean(seal) && (await seal.available()) === true;
  } catch {
    return false;
  }
}

function removeRecord(file, fsImpl) {
  try { fsImpl.unlinkSync(file); } catch { /* already gone */ }
}

/** Note the sidecar this desktop just started, and the token it answers to,
 * encrypted. Resolves "recorded", or "unsealed" when the credential store
 * cannot take it, in which case nothing is on disk. */
export async function recordSidecar(dir, { pid, recoveryToken }, seal, fsImpl = fs) {
  const file = path.join(dir, SIDECAR_PID_FILE);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !TOKEN_SHAPE.test(recoveryToken ?? "")) return "unsealed";
  if (!(await sealAvailable(seal))) {
    removeRecord(file, fsImpl);
    return "unsealed";
  }
  try {
    const sealed = await seal.encrypt(JSON.stringify({ pid, recoveryToken }));
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(file, sealed, { mode: 0o600 });
    fsImpl.chmodSync?.(file, 0o600);
    return "recorded";
  } catch {
    removeRecord(file, fsImpl);
    return "unsealed";
  }
}

/** The decrypted record, null when there is none, or { invalid } when it
 * cannot be opened or does not hold a pid and token. */
async function readRecord(file, seal, fsImpl) {
  let bytes;
  try {
    bytes = fsImpl.readFileSync(file);
  } catch (error) {
    return error?.code === "ENOENT" ? null : { invalid: true };
  }
  if (!(await sealAvailable(seal))) return { invalid: true };
  try {
    const parsed = JSON.parse(await seal.decrypt(bytes));
    if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 1 && TOKEN_SHAPE.test(parsed?.recoveryToken ?? "")) return parsed;
  } catch { /* unreadable */ }
  return { invalid: true };
}

/** Forget the record, but only if it still names this pid (or cannot be read). */
export async function forgetSidecar(dir, pid, seal, fsImpl = fs) {
  const file = path.join(dir, SIDECAR_PID_FILE);
  const record = await readRecord(file, seal, fsImpl);
  if (!record || (!record.invalid && record.pid !== pid)) return;
  removeRecord(file, fsImpl);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

/** Linux without lsof or ss: the listening socket's inode from /proc/net/tcp
 * and tcp6, then the process holding that inode among the ones this user can
 * see (a sidecar this desktop started is always one of them). */
export function procListeningPids(port, procfs = {
  readFile: (file) => fs.readFileSync(file, "utf8"),
  readdir: (dir) => fs.readdirSync(dir),
  readlink: (link) => fs.readlinkSync(link),
}) {
  const inodes = new Set();
  const hexPort = Number(port).toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = procfs.readFile(table); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // local_address is HEXIP:HEXPORT, st 0A is LISTEN, inode is field 9
      if (fields.length > 9 && fields[1]?.split(":").pop()?.toUpperCase() === hexPort && fields[3] === "0A" && fields[9] !== "0") inodes.add(fields[9]);
    }
  }
  const pids = new Set();
  if (!inodes.size) return pids;
  let entries = [];
  try { entries = procfs.readdir("/proc"); } catch { return pids; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds = [];
    try { fds = procfs.readdir(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target = "";
      try { target = procfs.readlink(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) { pids.add(Number(entry)); break; }
    }
  }
  return pids;
}

/** The pid the operating system reports as listening on this loopback TCP
 * port, or null when it cannot say (no lookup tool and no /proc), or says
 * more than one. Null always means: stop nothing. */
export async function listeningPid(port, platform = process.platform, runCommand = run, procfs = undefined) {
  const pids = new Set();
  if (platform === "win32") {
    // netstat.exe is a plain program: a listening socket is the row whose foreign address is port 0 (the state word is translated
    // on a non-English Windows, so it is not read). Local address ends in :<port>, the last column is the owning pid.
    const system = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const out = await runCommand(`${system}\\System32\\netstat.exe`, ["-ano", "-p", "tcp"]);
    for (const line of out.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 5 && /^TCP$/i.test(fields[0]) && /:0$/.test(fields[2]) && fields[1].endsWith(`:${Number(port)}`) && /^\d+$/.test(fields.at(-1))) pids.add(Number(fields.at(-1)));
    }
  } else {
    const out = await runCommand("lsof", ["-nP", `-tiTCP:${Number(port)}`, "-sTCP:LISTEN"]);
    for (const line of out.split(/\n/)) if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
    if (!pids.size && platform === "linux") {
      const ss = await runCommand("ss", ["-ltnpH", `sport = :${Number(port)}`]);
      for (const match of ss.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    }
    if (!pids.size && platform === "linux") for (const pid of procListeningPids(port, procfs)) pids.add(pid);
  }
  return pids.size === 1 ? [...pids][0] : null;
}

export const RECOVERY_TOKEN_HEADER = "x-murage-recovery-token";

/** GET /state with the recorded recovery secret: the status and the pid. */
async function probeWithSecret(port, secret) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { [RECOVERY_TOKEN_HEADER]: secret },
      signal: AbortSignal.timeout(1_500),
    });
    const body = res.status === 200 ? await res.json().catch(() => null) : null;
    return { status: res.status, pid: Number.isSafeInteger(body?.pid) ? body.pid : null };
  } catch {
    return null;
  }
}

/** POST /recovery/stop with the secret: did the sidecar agree to stop? */
async function askToStop(port, secret) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/recovery/stop`, {
      method: "POST",
      headers: { [RECOVERY_TOKEN_HEADER]: secret },
      signal: AbortSignal.timeout(1_500),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * Stop a sidecar a previous desktop launch started and left behind.
 * Resolves with what it found: "unsealed", "none", "not-ours",
 * "stopped-itself" or "stopped" (the fallback).
 */
export async function stopStaleSidecar({
  dir,
  controlPort,
  seal,
  fsImpl = fs,
  probe = probeWithSecret,
  requestStop = askToStop,
  portOwner = (port) => listeningPid(port),
  isAlive = processAlive,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log,
}) {
  const file = path.join(dir, SIDECAR_PID_FILE);
  // Without the credential store there is no token to prove anything with:
  // recover nothing, and leave the plain message to the normal start path.
  if (!(await sealAvailable(seal))) {
    removeRecord(file, fsImpl);
    return "unsealed";
  }
  const record = await readRecord(file, seal, fsImpl);
  if (!record) return "none";
  const drop = (outcome) => {
    try { fsImpl.unlinkSync(file); } catch { /* already gone */ }
    return outcome;
  };
  if (record.invalid) return drop("not-ours");
  // Ours only if the port holder answers the secret our last launch held.
  const answer = await probe(controlPort, record.recoveryToken);
  if (!answer || answer.status !== 200 || answer.pid === null) return drop("not-ours");
  // First, ask it to stop itself: the gentlest way, and it needs no OS lookup.
  if (await requestStop(controlPort, record.recoveryToken)) {
    log?.(`companion: the sidecar a previous launch left running is stopping (pid ${answer.pid})`);
    for (let waited = 0; waited < 3_000; waited += 100) {
      if (!isAlive(answer.pid) && (await probe(controlPort, record.recoveryToken)) === null) return drop("stopped-itself");
      await sleep(100);
    }
  }
  // And only the process the OS says is listening, which must be the one the
  // sidecar names as itself. Never the recorded pid on its own.
  const listener = await portOwner(controlPort);
  if (listener === null || listener <= 1 || listener === process.pid || listener !== answer.pid) return drop("not-ours");
  log?.(`companion: stopping the sidecar a previous launch left running (pid ${listener})`);
  try { kill(listener, "SIGTERM"); } catch { return drop("stopped"); }
  for (let waited = 0; waited < 3_000 && isAlive(listener); waited += 100) await sleep(100);
  if (isAlive(listener)) {
    try { kill(listener, "SIGKILL"); } catch { /* exited between the check and the kill */ }
    for (let waited = 0; waited < 1_000 && isAlive(listener); waited += 100) await sleep(100);
  }
  return drop("stopped");
}
