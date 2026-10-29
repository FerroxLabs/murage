// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows Sentinel trampoline (1.0.9, GAP-SENTINEL-109 section 10.1). Task Scheduler cannot give a task an
// environment, and the installed executable only runs a script as Node with ELECTRON_RUN_AS_NODE=1. So the Windows task
// runs `Murage.exe --murage-sentinel-scan <entry> <descriptor> --once`; electron/sentinel-trampoline-entry.mjs (the
// FIRST import of electron/main.mjs, so nothing else of the app is evaluated) sees exactly that shape, starts
// `<this executable> <entry> <descriptor> --once` with an allowlisted environment plus ELECTRON_RUN_AS_NODE=1, waits for
// it (bounded), and exits with its code. It runs only the entry its descriptor names for THIS executable, with the
// digest recorded there, so a signed Murage binary never becomes a launcher for an arbitrary script. It never opens a
// window, takes the single-instance lock or touches app data.
// Anything that only resembles the shape is refused with a usage exit, never started as the app.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SENTINEL_TRAMPOLINE_FLAG = "--murage-sentinel-scan";
/** The scanner's own exit codes (server/sentinel/supervisor.ts EXIT): usage. */
export const TRAMPOLINE_USAGE_EXIT = 2;
export const TRAMPOLINE_FAILED_EXIT = 1;
/** Below the task's 1 minute ExecutionTimeLimit; the scanner's own supervisor kills a scan at 5 s. */
export const TRAMPOLINE_TIMEOUT_MS = 50_000;
/** The same allowlist as the scanner supervisor (server/sentinel/supervisor.ts ENV_ALLOWLIST). */
export const TRAMPOLINE_ENV_ALLOWLIST = Object.freeze(["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_STATE_HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "TZ"]);

const ENTRY_NAME = /^cli-[0-9a-f]{16}\.js$/;
const ID = /^[0-9a-f]{16,64}$/;

/** True when this launch asked for the trampoline at all (the flag is the first argument after the executable). */
export const isTrampolineLaunch = (argv = process.argv) => Array.isArray(argv) && argv[1] === SENTINEL_TRAMPOLINE_FLAG;

/** Validates `<exe> --murage-sentinel-scan <entry> <descriptor> --once`: the descriptor is
 *  <...>\MurageSentinel\<id>\descriptor.json and the entry is <that folder>\runtime\cli-<16 hex>.js. Null when refused. */
export function parseTrampolineArguments(argv, platform = process.platform) {
  if (!isTrampolineLaunch(argv) || argv.length !== 5 || argv[4] !== "--once") return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  const [entry, descriptor] = [argv[2], argv[3]];
  for (const value of [entry, descriptor]) {
    if (typeof value !== "string" || value.length > 1024 || /[\0\r\n]/.test(value) || !p.isAbsolute(value) || p.normalize(value) !== value) return null;
    if (platform === "win32" && !/^[A-Za-z]:\\/.test(value)) return null;
  }
  const outputRoot = p.dirname(descriptor);
  if (p.basename(descriptor) !== "descriptor.json" || !ID.test(p.basename(outputRoot)) || p.basename(p.dirname(outputRoot)) !== "MurageSentinel") return null;
  if (!ENTRY_NAME.test(p.basename(entry)) || p.dirname(entry) !== p.join(outputRoot, "runtime")) return null;
  return { entry, descriptor };
}

export function trampolineEnvironment(env = process.env) {
  const out = {};
  for (const key of TRAMPOLINE_ENV_ALLOWLIST) { const value = env[key]; if (typeof value === "string" && value.length <= 4096 && !value.includes("\0")) out[key] = value; }
  out.ELECTRON_RUN_AS_NODE = "1";
  return out;
}

const fold = (value, platform) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);

/** The descriptor must name this executable and exactly this entry, and the entry's bytes must match its digest. */
export function trampolineDescriptorMatches({ entry, descriptor }, { execPath = process.execPath, platform = process.platform, read = readFileSync, size = file => statSync(file).size } = {}) {
  try {
    if (size(descriptor) > 8 * 1024 || size(entry) > 16 * 1024 * 1024) return false;
    const value = JSON.parse(read(descriptor, "utf8"));
    const exe = value?.executable;
    if (!exe || exe.entry !== entry || typeof exe.path !== "string" || fold(exe.path, platform) !== fold(execPath, platform)) return false;
    if (typeof exe.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(exe.sha256)) return false;
    return createHash("sha256").update(read(entry)).digest("hex") === exe.sha256;
  } catch { return false; }
}

/** Runs the scanner once through this executable and answers the exit code for the task. */
export function runTrampoline({ argv = process.argv, env = process.env, execPath = process.execPath, platform = process.platform, spawn = spawnSync, read, size } = {}) {
  const parsed = parseTrampolineArguments(argv, platform);
  if (!parsed) return TRAMPOLINE_USAGE_EXIT;
  if (!trampolineDescriptorMatches(parsed, { execPath, platform, ...(read ? { read } : {}), ...(size ? { size } : {}) })) return TRAMPOLINE_USAGE_EXIT;
  let result;
  try {
    result = spawn(execPath, [parsed.entry, parsed.descriptor, "--once"], { env: trampolineEnvironment(env), stdio: "ignore", windowsHide: true, timeout: TRAMPOLINE_TIMEOUT_MS, shell: false });
  } catch { return TRAMPOLINE_FAILED_EXIT; }
  return Number.isInteger(result?.status) ? result.status : TRAMPOLINE_FAILED_EXIT;
}
