import { execFile, spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_ROOT = /^[A-Za-z]:\\[^"%!^&|<>\x00-\x1f]*$/;
/** Windows Terminal's App Execution Alias, when this account has one (an lstat: the alias is a reparse point, not a regular file). */
export function windowsTerminalAlias(env = process.env, exists = (file) => { try { lstatSync(file); return true; } catch { return false; } }) {
  const local = env.LOCALAPPDATA;
  if (typeof local !== "string" || !WINDOWS_ROOT.test(local)) return null;
  const file = win32.join(local, "Microsoft", "WindowsApps", "wt.exe");
  return exists(file) ? file : null;
}
/** The shell the Windows fallback window runs: the commands Murage shows for pasting on Windows are written for PowerShell
 * (server/claude-accounts.ts signInShell), so the window that is opened for them is PowerShell too, never cmd. */
export const WINDOWS_FALLBACK_SHELL = "powershell";
// Names Murage itself puts in its environment, or hands an engine: never in the person's own terminal.
const MURAGE_ONLY_NAME = /^(?:MURAGE_|OMB_|ELECTRON_|CUA_DRIVER_RS_)/i;
/** The person's own environment for the terminal window, without Murage's own names. */
export function userTerminalEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && !MURAGE_ONLY_NAME.test(name)));
}
const systemRootOf = (env) => typeof env.SystemRoot === "string" && WINDOWS_ROOT.test(env.SystemRoot) ? env.SystemRoot.replace(/\\+$/, "") : "C:\\Windows";
/** The launch for a new terminal window: [executable, args, options, kind], Windows Terminal first, else a PowerShell console window.
 * kind "wt" is awaited through its exit callback; kind "user_terminal" is the PowerShell fallback (see openWindowsTerminal). */
export function windowsTerminalLaunches(env = process.env, exists) {
  const out = [];
  const clean = userTerminalEnv(env);
  const wt = windowsTerminalAlias(env, exists);
  if (wt) out.push([wt, [], { timeout: 15_000, env: clean }, "wt"]);
  const root = systemRootOf(env);
  const cmd = win32.join(root, "System32", "cmd.exe");
  const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const profile = typeof env.USERPROFILE === "string" && WINDOWS_ROOT.test(env.USERPROFILE) ? env.USERPROFILE : undefined;
  // user_terminal (server/no-powershell-spawn.allowlist.json): the ONE place Murage opens PowerShell, and only when the person asked
  // for a terminal (Open terminal) and Windows Terminal is missing. cmd's `start` gives it a console window of its own (conhost); its
  // argv is exactly powershell.exe -NoExit: no -Command, -File, -EncodedCommand or script text. It starts in the person's home folder
  // (the spawn cwd, which start passes on) with their own environment. The paths are checked above to hold no character cmd would
  // read as syntax.
  out.push([cmd, ["/d", "/c", `start "" "${powershell}" -NoExit`], { windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore", env: clean, ...(profile ? { cwd: profile } : {}) }, "user_terminal"]);
  return out;
}
/** Awaits each launch: Windows Terminal through its exit callback, the PowerShell window through cmd's exit (its stdio is ignored, so
 * the window it starts holds no pipe of ours open). */
async function openWindowsTerminal(env, run, start, exists) {
  for (const [executable, args, options, kind] of windowsTerminalLaunches(env, exists)) {
    const ok = await new Promise((resolve) => {
      if (kind === "user_terminal") {
        let child;
        try { child = start(executable, args, options); } catch { resolve(false); return; }
        const timer = setTimeout(() => resolve(false), 15_000);
        child.once("error", () => { clearTimeout(timer); resolve(false); });
        child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
        child.unref?.();
        return;
      }
      try { run(executable, args, options, (error) => resolve(!error)); } catch { resolve(false); }
    });
    if (ok) return true;
  }
  return false;
}

/** Resolve only after the launcher really spawns or reports an error. */
function launch(executable, args, options, run = execFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(executable, args, options);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) child.unref?.();
      resolve(ok);
    };
    child.once("spawn", () => finish(true));
    child.once("error", () => finish(false));
  });
}

/** Open a blank terminal. Installer text is deliberately not accepted here,
 * so renderer-controlled input can never become a process argument. */
export async function openBlankTerminal(platform = process.platform, run = execFile, env = process.env, start = spawn, exists = undefined) {
  if (platform === "darwin") {
    // `open -a` goes through Launch Services: no Automation permission to be
    // refused (an AppleScript "activate" needed one and failed silently in a
    // build without it), and it brings up a window even when Terminal is
    // running with none. Await its exit, as on Windows: a process that merely
    // spawned is not a Terminal the owner can see.
    return new Promise((resolve) => {
      try {
        run("open", ["-a", "Terminal"], { timeout: 15_000 }, (error) => resolve(!error));
      } catch {
        resolve(false);
      }
    });
  }
  if (platform === "win32") {
    // Murage starts no PowerShell by itself (murage-releases #1); this is the person's own Open terminal. Windows Terminal (wt.exe,
    // the App Execution Alias every Windows 11 and a current Windows 10 has) opens their default profile in a new window, PowerShell
    // on a stock install. Without it, a PowerShell console window (MurageMain: the shown commands are PowerShell, so never cmd).
    // Both are awaited, so a launcher that failed is not reported as a window.
    return openWindowsTerminal(env, run, start, exists);
  }
  if (platform === "linux") {
    for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
      if (await launch(terminal, [], undefined, run)) return true;
    }
  }
  return false;
}
