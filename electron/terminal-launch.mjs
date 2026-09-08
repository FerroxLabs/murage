import { execFile } from "node:child_process";

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
export async function openBlankTerminal(platform = process.platform, run = execFile) {
  if (platform === "darwin") {
    return launch(
      "osascript",
      ["-e", 'tell application "Terminal" to activate'],
      undefined,
      run,
    );
  }
  if (platform === "win32") {
    // execFile uses pipes, so -NoExit alone can leave PowerShell without an
    // interactive console. A short hidden bootstrap creates the real window;
    // await its exit so a failed Start-Process cannot report success on spawn.
    return new Promise((resolve) => {
      try {
        run(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo','-NoProfile','-NoExit' -WindowStyle Normal -ErrorAction Stop"],
          { windowsHide: true, timeout: 15_000 },
          (error) => resolve(!error),
        );
      } catch {
        resolve(false);
      }
    });
  }
  if (platform === "linux") {
    for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
      if (await launch(terminal, [], undefined, run)) return true;
    }
  }
  return false;
}
