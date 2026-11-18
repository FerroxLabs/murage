import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opens a server recipe in a real terminal (1.0.14, ENGINE-SIGNIN-SIMPLE, Terminal fallback), for the engines whose sign-in
// needs one and for any engine whose browser did not open. Runs in Electron MAIN only. Takes a recipe from the local server,
// never text from a renderer. It runs the recipe's argv on the owner's own environment (userTerminalEnv), so a proxy works
// there, with only the recipe's account keys pinned on top. Each launcher keeps a supervisor pid so quitting ends the sign-in.
//   Mac      a generated .command in a private folder, which writes its own pid first. Terminal gives it the owner's
//            environment, so the file names the account keys alone. It holds no secret and is removed.
//   Windows  cmd's `start`, the same way terminal-launch.mjs opens a window: it gives the executable a console of its own with real
//            input and output, which a spawned child with ignored stdio never has. Quoted word by word, and any word cmd would read
//            refuses the launch. No PowerShell.
//   Linux    the first emulator from a fixed absolute list, else the plain "Finish in your terminal" line.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

import { systemRootOf, userTerminalEnv } from "./terminal-launch.mjs";

/** Fixed and absolute (G4). `wait` keeps an emulator that hands off to a server in the foreground, so its pid is the supervisor. */
export const LINUX_TERMINALS = Object.freeze([
  { file: "/usr/bin/x-terminal-emulator", args: ["-e"] },
  { file: "/usr/bin/gnome-terminal", args: ["--wait", "--"] },
  { file: "/usr/bin/konsole", args: ["-e"] },
  { file: "/usr/bin/xfce4-terminal", args: ["--disable-server", "-x"] },
  { file: "/usr/bin/xterm", args: ["-e"] },
]);
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const printable = (value) => typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/.test(value);

const validArgv = (recipe) => Array.isArray(recipe?.argv) && recipe.argv.length > 0 && recipe.argv.every(printable);
/** The account keys as NAME=value words, or null when any would not be a single word. */
function accountWords(recipe) {
  const names = Object.keys(recipe?.accountEnv ?? {});
  if (!names.every((name) => VALID_ENV_NAME.test(name) && printable(recipe.accountEnv[name]))) return null;
  return names.map((name) => `${name}=${recipe.accountEnv[name]}`);
}

/** The owner's environment for a terminal, with the recipe's account keys on top. */
export function terminalEnv(recipe, env = process.env) {
  return { ...userTerminalEnv(env), ...(recipe?.accountEnv ?? {}) };
}

/** The generated .command, or null. Removes itself as its first act and writes its pid so main can end it on quit. */
export function macCommandFile(recipe, pidFile) {
  const words = accountWords(recipe);
  if (!words || !validArgv(recipe) || !printable(pidFile)) return null;
  return ["#!/bin/bash", `/bin/rm -f -- "$0"`, `echo $$ > ${shellQuote(pidFile)}`, `exec ${["/usr/bin/env", ...words, ...recipe.argv].map(shellQuote).join(" ")}`, ""].join("\n");
}

export function linuxTerminalLaunch(recipe, { exists = existsSync, env = process.env } = {}) {
  if (!validArgv(recipe) || !accountWords(recipe)) return null;
  const terminal = LINUX_TERMINALS.find((candidate) => exists(candidate.file));
  if (!terminal) return null;
  return { file: terminal.file, args: [...terminal.args, ...recipe.argv], options: { env: terminalEnv(recipe, env), stdio: "ignore", detached: true } };
}

/** The cmd line that opens the recipe in its own console, or null when a word holds something cmd would read inside quotes. */
export function windowsConsoleLine(recipe) {
  if (!validArgv(recipe) || !accountWords(recipe) || recipe.argv.some((word) => /["%]/.test(word))) return null;
  return `/d /c start "Murage sign-in" /wait ${recipe.argv.map((word) => `"${word}"`).join(" ")}`;
}

const MAC_PID_WAIT_MS = 30_000;
const MAC_STOP_WAIT_MS = 3_000;
const MAC_PID_POLL_MS = 500;

/**
 * Starts the recipe. `{ ok: true, supervisor }` where supervisor is { alive(): boolean, stop(): Promise<void> }, or
 * `{ ok: false, code: "no-terminal" | "failed" }`. A launch that failed never reports a window.
 */
export async function launchRecipeTerminal(recipe, { platform = process.platform, start = spawn, exists = existsSync, env = process.env, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), kill = process.kill.bind(process), fs = { chmod, mkdtemp, readFile, rm, writeFile }, temp = tmpdir() } = {}) {
  const waitForSpawn = (child) => new Promise((resolve) => { child.once("spawn", () => resolve(true)); child.once("error", () => resolve(false)); });
  const pidAlive = (pid) => { try { kill(pid, 0); return true; } catch { return false; } };
  if (platform === "linux") {
    const launch = linuxTerminalLaunch(recipe, { exists, env });
    if (!launch) return { ok: false, code: "no-terminal" };
    let child;
    try { child = start(launch.file, [...launch.args], withHideInherit(launch.options)); } catch { return { ok: false, code: "failed" }; }
    if (!(await waitForSpawn(child))) return { ok: false, code: "failed" };
    let closed = false;
    child.once("exit", () => { closed = true; });
    child.unref?.();
    return { ok: true, supervisor: { alive: () => !closed, stop: async () => { try { kill(-child.pid, "SIGTERM"); } catch { /* gone */ } } } };
  }
  if (platform === "win32") {
    const line = windowsConsoleLine(recipe);
    if (!line) return { ok: false, code: "failed" };
    let child;
    // `/wait` keeps cmd alive for as long as the console, so its pid is the supervisor and taskkill /T reaches the sign-in.
    try { child = start(win32.join(systemRootOf(env), "System32", "cmd.exe"), [line], withHideInherit({ env: terminalEnv(recipe, env), stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, shell: false })); } catch { return { ok: false, code: "failed" }; }
    if (!(await waitForSpawn(child))) return { ok: false, code: "failed" };
    let closed = false;
    child.once("exit", () => { closed = true; });
    child.unref?.();
    return { ok: true, supervisor: { alive: () => !closed, stop: async () => {
      await new Promise((resolve) => { try { const killer = start("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", shell: false }); killer.once("exit", resolve); killer.once("error", resolve); } catch { resolve(); } });
    } } };
  }
  if (platform === "darwin") {
    let folder;
    try { folder = await fs.mkdtemp(posix.join(temp, "murage-engine-signin-")); await fs.chmod(folder, 0o700); }
    catch { return { ok: false, code: "failed" }; }
    const removeFolder = () => fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    const file = posix.join(folder, "Sign in.command");
    const pidFile = posix.join(folder, "pid");
    const text = macCommandFile(recipe, pidFile);
    if (!text) { await removeFolder(); return { ok: false, code: "failed" }; }
    try { await fs.writeFile(file, text, { mode: 0o700 }); } catch { await removeFolder(); return { ok: false, code: "failed" }; }
    const opened = await new Promise((resolve) => {
      let child;
      try { child = start("/usr/bin/open", ["-a", "Terminal", file], { stdio: "ignore" }); } catch { resolve(false); return; }
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
    if (!opened) { await removeFolder(); return { ok: false, code: "failed" }; }
    let pid = null;
    for (let waited = 0; waited < MAC_PID_WAIT_MS && pid === null; waited += MAC_PID_POLL_MS) {
      await wait(MAC_PID_POLL_MS);
      const read = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (/^\d{1,9}\s*$/.test(read)) pid = Number.parseInt(read, 10);
    }
    await removeFolder();
    if (pid === null || pid < 2) return { ok: false, code: "failed" };
    // The script execs the sign-in, so this pid is the sign-in. Stopping waits for it to leave, so the next attempt finds its port free.
    return { ok: true, supervisor: { alive: () => pidAlive(pid), stop: async () => {
      try { kill(pid, "SIGTERM"); } catch { return; }
      for (let waited = 0; waited < MAC_STOP_WAIT_MS && pidAlive(pid); waited += MAC_PID_POLL_MS) await wait(MAC_PID_POLL_MS);
      if (pidAlive(pid)) { try { kill(pid, "SIGKILL"); } catch { /* gone */ } }
    } } };
  }
  return { ok: false, code: "no-terminal" };
}
