// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-seanclean (owner of this file and of server/memory-reset-hidden-rules.ts). Imported by electron/main.mjs right after
// the Sentinel trampoline, before any other module of the app is evaluated. A launch of the installed executable with
//   --memory-reset-hidden-rules [--data-dir <folder>] [--finish-minutes <n>] [--dry-run] [--no-check]
// runs the bundled one-time memory clean-up as Node (this same executable, ELECTRON_RUN_AS_NODE=1), waits for it and exits
// with its code. It never opens a window, takes the single-instance lock or starts the server. Every other launch passes
// through. The command refuses while the app holds the data folder (its lease), so it is run with the app closed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withHideInherit } from "../shared/win-hide-child-process.mjs";

export const MEMORY_RESET_FLAG = "--memory-reset-hidden-rules";
export const MEMORY_RESET_ENTRY = "memory-reset-hidden-rules.js";
export const MEMORY_RESET_USAGE_EXIT = 64;
const ALONE = new Set(["--dry-run", "--no-check"]);
const WITH_VALUE = new Set(["--data-dir", "--finish-minutes"]);

/** True when this launch asked for the clean-up (the flag is the first argument after the executable). */
export const isMemoryResetLaunch = (argv = process.argv) => Array.isArray(argv) && argv[1] === MEMORY_RESET_FLAG;

/** The arguments passed on to the command: only its own, each value checked for shape. Null when anything else is there. */
export function memoryResetArguments(argv) {
  if (!isMemoryResetLaunch(argv)) return null;
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (ALONE.has(arg)) { out.push(arg); continue; }
    if (!WITH_VALUE.has(arg)) return null;
    const value = argv[++i];
    if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("--") || /[\0\r\n]/.test(value)) return null;
    if (arg === "--finish-minutes" && !/^[0-9]{1,4}$/.test(value)) return null;
    out.push(arg, value);
  }
  return out;
}

/** The bundled command: beside the packaged server (Resources/server), or dist-server in a source tree. */
export function memoryResetEntry({ resourcesPath = process.resourcesPath, exists = existsSync, here = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const candidates = [
    ...(typeof resourcesPath === "string" && resourcesPath ? [path.join(resourcesPath, "server", MEMORY_RESET_ENTRY)] : []),
    path.join(here, "..", "dist-server", MEMORY_RESET_ENTRY),
  ];
  return candidates.find(candidate => exists(candidate)) ?? null;
}

export function runMemoryReset({ argv = process.argv, execPath = process.execPath, env = process.env, spawn = spawnSync, entry = memoryResetEntry(), write = text => process.stderr.write(text) } = {}) {
  const args = memoryResetArguments(argv);
  if (!args) { write(`usage: ${MEMORY_RESET_FLAG} [--data-dir <folder>] [--finish-minutes <n>] [--dry-run] [--no-check]\n`); return MEMORY_RESET_USAGE_EXIT; }
  if (!entry) { write("memory clean-up: this build does not carry the command\n"); return 1; }
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  delete childEnv.NODE_OPTIONS;
  const done = spawn(execPath, [entry, ...args], withHideInherit({ env: childEnv, stdio: "inherit" }));
  if (done.error) { write("memory clean-up: the command could not be started\n"); return 1; }
  return typeof done.status === "number" ? done.status : 1;
}

if (isMemoryResetLaunch(process.argv) && !process.env.ELECTRON_RUN_AS_NODE) process.exit(runMemoryReset());
