// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writer and installer for the `murage-exec` Claude shell prefix
// (APP-GRANT-DESIGN Rule 69f / 74b). The wrapper text is the file
// server/drivers/murage-exec beside this one (packaging must ship it, as it
// ships the permission proxy), and its W5 shape list the file
// server/drivers/murage-exec.shapes. The installed wrapper and the per-turn
// environment file are sensitive rows: an engine that could rewrite either
// would rewrite what every command runs under.

import { writeFileSync } from "../counted-fs.ts";
import { closeSync, fstatSync, openSync, opendirSync, readSync, statSync, watch, type FSWatcher, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wipeGuardShimDirectory } from "../env-path.ts";
import { readFlagHead } from "../shell-proof.ts";

/** Names the wrapper reads from the file itself; never part of the command's environment. */
export const EXEC_CWD = "MURAGE_EXEC_CWD";
export const EXEC_SHELL = "MURAGE_EXEC_SHELL";
/** X3: the third reserved entry. "1": a call whose setup does not conform is refused; "0": the thread is on the floor. */
export const EXEC_PROVEN = "MURAGE_EXEC_PROVEN";
/** The environment map the wrapper reads. */
export const EXEC_ENV_FILE = "MURAGE_EXEC_ENV_FILE";
/** X3 r4.5 B1: the per-spawn reference an MCP stanza's KEEP head must match. Only ever in the CLI's spawn env and the
 *  overlay (plus the mcp-config markers), never in the turn's environment file. */
export const EXEC_NONCE = "MURAGE_EXEC_NONCE";

// Each sibling is read by a literal path, so scripts/bundle-server-runtime-files.test.mjs sees both readers.
export const WRAPPER_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "murage-exec"), "utf8");
/** W5: the listed shapes, installed beside the wrapper as `<wrapper>.shapes`. */
export const SHAPES_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "murage-exec.shapes"), "utf8");

let installDir: string | null = null;
/** A private (0700) folder made for this process; removed at exit. */
function privateDir(): string {
  if (!installDir || !existsSync(installDir)) {
    installDir = mkdtempSync(join(tmpdir(), "murage-exec-"));
    const dir = installDir;
    chmodSync(dir, 0o700);
    process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return installDir;
}

/** Existing private process directory; the callback creates its own turn subdir. */
export function wipeGuardPrivateDirectory(): string { return privateDir(); }

/** Private executable copy: packaged resources may be read-only. Additional
 * mkfs variants get aliases without modifying the installed application. */
export function installWipeGuardShim(realTools: Readonly<Record<string, string>>, source = wipeGuardShimDirectory()): string {
  const target = join(privateDir(), "wipe-guard", "shim");
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, { recursive: true, dereference: true });
    chmodSync(target, 0o700);
    for (const name of readdirSync(target)) chmodSync(join(target, name), 0o755);
  }
  for (const tool of Object.keys(realTools)) {
    if (!/^mkfs\.[a-zA-Z0-9_-]+$/.test(tool) || existsSync(join(target, tool))) continue;
    copyFileSync(join(target, "guard.sh"), join(target, tool));
    chmodSync(join(target, tool), 0o755);
  }
  return target;
}

function writeOnce(path: string, text: string, mode: number): void {
  if (existsSync(path)) return;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, text, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/** Install the wrapper (0755) with its shape list beside it (0644) and return the wrapper's path. Named by the hash of
 *  both, written once; the list is written first, so a wrapper never runs without its own list. */
export function installMurageExec(noLimits: boolean = false): string {
  // Bind the effective level into the selected program. Managed Claude settings
  // outrank the launch environment and must not change this policy boundary.
  const source = noLimits ? WRAPPER_SOURCE.replace("\nmurage_exec_no_limits=0\n", "\nmurage_exec_no_limits=1\n") : WRAPPER_SOURCE;
  const hash = createHash("sha256").update(source).update("\0").update(SHAPES_SOURCE).digest("hex").slice(0, 16);
  const path = join(privateDir(), `murage-exec-${hash}`);
  writeOnce(`${path}.shapes`, SHAPES_SOURCE, 0o644);
  writeOnce(path, source, 0o755);
  return path;
}

/** The value Claude is handed as `CLAUDE_CODE_SHELL_PREFIX`. On Windows Claude puts it into a Git Bash command line, so
 *  the path is spelled with forward slashes (a backslash there is an escape). */
export function murageExecPrefix(platform: NodeJS.Platform = process.platform, noLimits: boolean = false): string {
  const path = installMurageExec(noLimits);
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}

const isExecName = (name: string): boolean => name.toUpperCase().startsWith("MURAGE_EXEC_");

/** The environment file text: NUL-separated name=value, the three reserved entries first. r4.5 B5: no other MURAGE_EXEC_*
 *  name is ever written (the wrapper refuses a file that holds one). */
export function execEnvFileText(env: Readonly<Record<string, string>>, cwd: string, shell: string, proven: boolean = false): string {
  const pairs = [`${EXEC_CWD}=${cwd}`, `${EXEC_SHELL}=${shell}`, `${EXEC_PROVEN}=${proven ? "1" : "0"}`];
  for (const [name, value] of Object.entries(env)) {
    if (name.includes("=") || name.includes("\0") || value.includes("\0") || isExecName(name)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.map((pair) => `${pair}\0`).join("");
}

/** The path of one thread's environment file (24 hex characters under the private folder's env/). */
export function execEnvFilePath(key: string): string {
  return join(privateDir(), "env", createHash("sha256").update(key).digest("hex").slice(0, 24));
}

/** Write (or rewrite) one thread's environment file, 0600, and return its path. */
export function writeExecEnvFile(key: string, env: Readonly<Record<string, string>>, cwd: string, shell: string, proven: boolean = false): string {
  const dir = join(privateDir(), "env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = execEnvFilePath(key);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, execEnvFileText(env, cwd, shell, proven), { mode: 0o600 });
  renameSync(temp, path);
  return path;
}

/** The thread's flag file (the wrapper's value-free refusal lines) and its diagnostic file (keep-mismatch lines, read only
 *  by the engine check's counters). */
export const execFlagPath = (envFile: string): string => `${envFile}.flag`;
export const execDiagPath = (envFile: string): string => `${envFile}.flag.diag`;

export type ExecFlag = { reason: string; shape: string };
/** The first refusal line of a thread's flag file, or null when there is none. Values are fixed tokens and a checksum. */
export function readExecFlag(envFile: string): ExecFlag | null {
  const head = readFlagHead(execFlagPath(envFile));
  if (!head) return null;
  const match = /^reason=([a-z-]{1,32}) shape=([0-9]{1,12})$/m.exec(head.text);
  // The first refusal line is at the head; a longer file whose head holds none is still flagged (fail closed).
  return match ? { reason: match[1]!, shape: match[2]! } : head.more ? { reason: "unreadable", shape: "0" } : null;
}

/** r4.5 A5: one PATH entry in the form a bash snapshot spells it. Windows entries (C:\x\y) become MSYS (/c/x/y), compared
 * case-blind; POSIX entries are compared exactly. A trailing slash is ignored. */
function pathEntryKey(entry: string, platform: NodeJS.Platform): string {
  let key = entry.replace(/[\\/]+$/, "") || entry;
  if (platform !== "win32") return key;
  key = key.replace(/\\/g, "/").replace(/^([A-Za-z]):(?=\/|$)/, (_m, drive: string) => `/${drive.toLowerCase()}`);
  return key.toLowerCase();
}

/** r4.5 A5: how many entries of a Claude shell snapshot's last `export PATH=` line are missing from the bot PATH, or null
 * when the snapshot exports no PATH. A count only: no entry is ever logged. The bot PATH is the turn map's (`;` on
 * Windows); the snapshot is bash, so its separator is `:`. */
export function snapshotPathMissing(snapshot: string, botPath: string, platform: NodeJS.Platform = process.platform): number | null {
  const lines = [...snapshot.matchAll(/^export PATH=(.*)$/gm)];
  if (!lines.length) return null;
  let value = lines[lines.length - 1]![1]!.trim();
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) value = value.slice(1, -1);
  const bot = new Set(botPath.split(platform === "win32" ? ";" : ":").filter(Boolean).map((entry) => pathEntryKey(entry, platform)));
  return value.split(":").filter(Boolean).filter((entry) => !bot.has(pathEntryKey(entry, platform))).length;
}

/** The one value-free log line for a snapshot PATH check, or null when there is nothing to say (no snapshot PATH, or nothing missing). */
export function pathMissingLine(threadId: string, missing: number | null): string | null {
  // 0 missing is the healthy answer (every snapshot entry is on the bot PATH): no line
  return missing === null || missing === 0 ? null : `claude exec path-missing thread=${threadId} entries=${missing}`;
}

// Diagnostics are optional and have fixed work budgets on the dispatch path.
const DIAGNOSTIC_BYTES = 65_536;
const SNAPSHOT_ENTRIES = 64;

/** Read at most one bounded file window; oversized snapshots have no diagnostic. */
function diagnosticText(path: string, tail: boolean): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (!tail && size > DIAGNOSTIC_BYTES) return null;
    const start = tail ? Math.max(0, size - DIAGNOSTIC_BYTES) : 0;
    const buffer = Buffer.alloc(Math.min(size, DIAGNOSTIC_BYTES));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, bytes);
    // Drop a possibly partial first line of a suffix window.
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** r4.5 A5: newest snapshot in a completely scanned folder of at most 64 entries.
 * Larger folders or files over 64 KiB yield no diagnostic, never a partial "newest". */
export function newestShellSnapshot(configDir: string): string | null {
  const dir = join(configDir, "shell-snapshots");
  let best: { path: string; at: number } | null = null;
  let listing: ReturnType<typeof opendirSync> | undefined;
  try {
    listing = opendirSync(dir);
    for (let count = 0; ; count++) {
      const entry = listing.readSync();
      if (!entry) break;
      if (count >= SNAPSHOT_ENTRIES) return null;
      if (!/^snapshot-.*\.sh$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const at = statSync(path).mtimeMs;
      if (!best || at > best.at) best = { path, at };
    }
    return best ? diagnosticText(best.path, false) : null;
  } catch { return null; }
  finally { listing?.closeSync(); }
}

/** r4.5 A5/B3: keep-mismatch lines in the latest 64 KiB (0 when absent).
 * Small logs retain their exact historical count; work never grows with history. */
export function execDiagCount(envFile: string): number {
  return (diagnosticText(execDiagPath(envFile), true) ?? "").split("\n").filter(line => line === "keep-mismatch").length;
}

/** r4.5 B1: a fresh per-spawn nonce, 16 random bytes as 32 lower-case hex characters. */
export function newExecNonce(): string {
  return randomBytes(16).toString("hex");
}

const watchers = new Map<string, { watcher: FSWatcher; listeners: Map<string, () => void> }>();
/** r2 section 2: call `onFlag` at once when the thread's flag file gets its first line (not at turn end). One watcher per
 *  folder, unref'd; returns the function that stops listening. A missed event is caught by the next spawn's readExecFlag. */
export function watchExecFlag(envFile: string, onFlag: (flag: ExecFlag) => void): () => void {
  const dir = dirname(envFile);
  const name = basename(execFlagPath(envFile));
  let entry = watchers.get(dir);
  if (!entry) {
    const listeners = new Map<string, () => void>();
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, file) => {
        if (file) { listeners.get(String(file))?.(); return; }
        for (const listener of [...listeners.values()]) listener();
      });
    } catch {
      return () => {};
    }
    watcher.on("error", () => { /* the next spawn reads the flag */ });
    entry = { watcher, listeners };
    watchers.set(dir, entry);
  }
  let fired = false;
  const check = () => {
    if (fired) return;
    const flag = readExecFlag(envFile);
    if (!flag) return;
    fired = true;
    onFlag(flag);
  };
  entry.listeners.set(name, check);
  check();
  const current = entry;
  return () => {
    if (current.listeners.get(name) === check) current.listeners.delete(name);
    if (current.listeners.size === 0) { current.watcher.close(); if (watchers.get(dir) === current) watchers.delete(dir); }
  };
}

/** Set on every MCP server stanza's own env in the mcp.json. r4.5 B2: `mcp:<nonce>:<names>`, names the comma list of the
 *  stanza's keepable names (possibly empty). Claude starts each stdio server through the shell prefix with that env on the
 *  prefix process; the wrapper treats the call as an MCP server only when the head carries the CLI process's own nonce,
 *  and then carries exactly these names over its `env -i`. Pinned "" in Claude's own environment (the overlay). */
export const EXEC_KEEP = "MURAGE_EXEC_KEEP";
const KEEPABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The `mcp:<nonce>:` head of a KEEP value. */
export const execKeepHead = (nonce: string): string => `mcp:${nonce}:`;

/** The same servers with MURAGE_EXEC_KEEP=mcp:<nonce>:<names> on EVERY stanza with a string `command`: env absent, `{}`,
 *  only unkeepable names, or set (its ELECTRON_RUN_AS_NODE, its credential-file names, an owner server's own variables). */
export function withExecKeep(servers: Record<string, unknown>, nonce: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const stanza = server as { command?: unknown; env?: unknown } | null;
    if (!stanza || typeof stanza !== "object" || typeof stanza.command !== "string") {
      out[name] = server;
      continue;
    }
    const env = { ...((stanza.env && typeof stanza.env === "object" ? stanza.env : {}) as Record<string, string>) };
    for (const key of Object.keys(env)) if (isExecName(key)) delete env[key];
    const names = Object.keys(env).filter((key) => KEEPABLE_NAME.test(key));
    out[name] = { ...stanza, env: { ...env, [EXEC_KEEP]: `${execKeepHead(nonce)}${names.join(",")}` } };
  }
  return out;
}
