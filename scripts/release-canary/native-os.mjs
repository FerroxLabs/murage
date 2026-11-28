// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const mac = process.platform === "darwin";
export const win = process.platform === "win32";
const psFile = fileURLToPath(new URL("./windows-native.ps1", import.meta.url));

export function command(bin, args, env = process.env) {
  try {
    return execFileSync(bin, args, {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }).trim();
  } catch {
    throw Error("NATIVE_COMMAND");
  }
}

const powershell = (probe, file, port) => JSON.parse(command("powershell.exe",
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", psFile, probe],
  { ...process.env, CANARY_PROBE_FILE: file ?? "", CANARY_PROBE_PORT: String(port ?? "") }));

const fold = value => win ? value?.toLowerCase() : value;

export function inside(base, child) {
  const path = relative(base, child);
  return Boolean(path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function underCanaryHome(path) {
  const real = realpathSync(path);
  if (!inside(realpathSync(homedir()), real)) throw Error("ISOLATION");
  return real;
}

export function nativeSession(expected, background) {
  if (!(mac || win) || userInfo().username.toLowerCase() !== "canary") throw Error("NOT_CANARY_ACCOUNT");
  if (mac) {
    const id = String(process.getuid());
    if (id === "0" || id !== expected) throw Error("NOT_CANARY_ACCOUNT");
    if (command("/bin/launchctl", ["managername"]) !== "Aqua") throw Error("OFFLINE");
    const foreground = command("/usr/bin/stat", ["-f", "%u", "/dev/console"]);
    if (background && (!/^\d+$/.test(foreground) || foreground === "0" || foreground === id)) {
      throw Error("NO_BACKGROUND_SESSION");
    }
    return { id, mode: "fast-user-switched" };
  }
  const { id, session, disconnected } = powershell("session");
  if (id !== expected) throw Error("NOT_CANARY_ACCOUNT");
  if (!(session > 0)) throw Error("OFFLINE");
  if (background && !disconnected) throw Error("NO_BACKGROUND_SESSION");
  return { id, session, mode: "disconnected" };
}

export function processRows(exe) {
  if (win) return powershell("processes", exe);
  return command("/bin/ps", ["-ww", "-axo", "pid=,ppid=,uid=,lstart=,command="]).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(line);
    if (!match) return [];
    const [, pid, parent, id, started, command] = match;
    return [{ pid: Number(pid), parent: Number(parent), id, started, command,
      exe: command === exe || command.startsWith(`${exe} `) ? exe : null }];
  });
}

export function mainProcess(rows, exe, session) {
  const all = rows.filter(row => row.id === session.id && row.session === session.session && fold(row.exe) === fold(exe) &&
    !/(?:^|\s)--type[=\s]/.test(row.command ?? ""));
  if (all.length > 1) throw Error("IDENTITY");
  return all[0];
}

export function listeningOnlyOnLoopback(pid, port) {
  if (win) {
    const rows = powershell("listener", undefined, port);
    if (!rows.length) return false;
    if (rows.some(row => row.pid !== pid || row.address !== "127.0.0.1")) throw Error("CDP_LISTENER");
    return true;
  }
  let sockets;
  try {
    sockets = command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
  } catch { return false; }
  const entries = sockets.split("\n").filter(line => line.startsWith("n"));
  if (entries.some(line => line !== `n127.0.0.1:${port}`)) throw Error("CDP_LISTENER");
  return entries.length > 0;
}

export function signedIdentity(exe, app) {
  if (win) {
    const { valid, signer, version } = powershell("signature", exe);
    if (!valid || !signer || !version) throw Error("SIGNATURE");
    return { signer: signer.toLowerCase(), version };
  }
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  // codesign --display writes its identity to stderr even on success.
  let signature;
  try {
    const { stderr, status } = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", app], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    if (status !== 0) throw Error("codesign");
    signature = stderr;
  } catch { throw Error("SIGNATURE"); }
  const cdhash = /^CDHash=([0-9a-f]+)$/m.exec(signature)?.[1];
  const signer = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature)?.[1];
  if (!cdhash || !signer) throw Error("SIGNATURE");
  const version = command("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", `${app}/Contents/Info.plist`]);
  return { signer, version, cdhash };
}

export function sameProcess(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.started === b.started);
}

export function treeOf(rows, root) {
  const tree = [root];
  for (const row of tree) {
    for (const candidate of rows) {
      if (candidate.parent === row.pid && !tree.some(entry => entry.pid === candidate.pid)) tree.push(candidate);
    }
  }
  return tree;
}

export function quitNative(pid) {
  if (win) command("taskkill.exe", ["/PID", String(pid)]);
  else process.kill(pid, "SIGTERM");
}
