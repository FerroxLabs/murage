import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { openBlankTerminal } from "./terminal-launch.mjs";

function launcher(outcomes) {
  const calls = [];
  const run = (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    const outcome = outcomes.shift() ?? "spawn";
    queueMicrotask(() => {
      if (outcome === "throw") child.emit("error", new Error("missing terminal"));
      else child.emit("spawn");
      callback?.(outcome === "throw" ? new Error("launch failed") : null);
    });
    return child;
  };
  return { calls, run };
}

describe("blank terminal launcher", () => {
  it("opens Terminal on macOS without a command argument", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("darwin", fake.run)).resolves.toBe(true);
    expect(fake.calls).toEqual([{ executable: "open", args: ["-a", "Terminal"], options: { timeout: 15_000 } }]);
  });

  it("reports failure on macOS when Terminal did not open, not success on spawn", async () => {
    // `open` exits non-zero when Launch Services cannot open Terminal
    const run = (_executable, _args, _options, callback) => callback(new Error("exit 1"));
    await expect(openBlankTerminal("darwin", run)).resolves.toBe(false);
  });

  const WIN_ENV = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\Sam\\AppData\\Local", USERPROFILE: "C:\\Users\\Sam" };
  it("opens Windows Terminal on Windows first, with the person's own environment", async () => {
    const fake = launcher(["spawn"]);
    const wt = "C:\\Users\\Sam\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { windowsTerminalLaunches } = await import("./terminal-launch.mjs");
    expect(windowsTerminalLaunches(WIN_ENV, (file) => file === wt)[0]).toEqual([wt, [], { timeout: 15_000, env: WIN_ENV }, "wt"]);
    await expect(openBlankTerminal("win32", fake.run, WIN_ENV, () => { throw new Error("no fallback needed"); }, (file) => file === wt)).resolves.toBe(true);
    expect(fake.calls.map((call) => call.executable)).toEqual([wt]);
    for (const call of fake.calls) expect(JSON.stringify(call)).not.toMatch(/powershell|pwsh/i);
  });

  // MurageMain ruling (nops round 3, C): without wt.exe, a PowerShell console window, never cmd.
  const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  it("falls back to a PowerShell window whose argv is exactly powershell.exe -NoExit, in the home folder", async () => {
    const { windowsTerminalLaunches } = await import("./terminal-launch.mjs");
    const launches = windowsTerminalLaunches(WIN_ENV, () => false);
    expect(launches).toEqual([["C:\\Windows\\System32\\cmd.exe", ["/d", "/c", `start "" "${PS}" -NoExit`], { windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore", env: WIN_ENV, cwd: "C:\\Users\\Sam" }, "user_terminal"]]);
    // what start runs: the quoted program and exactly one argument, -NoExit; no command, file, encoded command or script text
    const started = /^start "" "([^"]+)" (.*)$/.exec(launches[0][1][2]);
    expect(started?.[1]).toBe(PS);
    expect(started?.[2].split(" ")).toEqual(["-NoExit"]);
    expect(launches[0][1].join(" ")).not.toMatch(/-(?:Command|File|EncodedCommand|c|e|ec|f)\b/i);
    // a SystemRoot, LOCALAPPDATA or USERPROFILE holding cmd syntax is never put in a command line
    const odd = windowsTerminalLaunches({ SystemRoot: 'C:\\W" & calc', LOCALAPPDATA: "C:\\x&y", USERPROFILE: "C:\\a&b" }, () => true);
    expect(odd).toHaveLength(1);
    expect(odd[0][1][2]).toBe(`start "" "${PS}" -NoExit`);
    expect(odd[0][2].cwd).toBeUndefined();
  });

  it("the PowerShell window gets the person's environment without Murage's own names, tokens or handed secrets", async () => {
    const { windowsTerminalLaunches, userTerminalEnv } = await import("./terminal-launch.mjs");
    const env = { ...WIN_ENV, Path: "C:\\Windows", MURAGE_SURFACE_SECRET: "s", MURAGE_RESOURCES_PATH: "r", murage_lower: "x", OMB_RESOURCES_PATH: "o", ELECTRON_RUN_AS_NODE: "1", CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", GITHUB_TOKEN: "the person's own" };
    const options = windowsTerminalLaunches(env, () => false)[0][2];
    expect(Object.keys(options.env).filter((name) => /^(?:MURAGE_|OMB_|ELECTRON_|CUA_DRIVER_RS_)/i.test(name))).toEqual([]);
    expect(options.env).toEqual({ ...WIN_ENV, Path: "C:\\Windows", GITHUB_TOKEN: "the person's own" });
    expect(userTerminalEnv({ MURAGE_X: "1", A: "b" })).toEqual({ A: "b" });
  });

  it("the fallback shell is the shell the shown commands are written for", async () => {
    const { WINDOWS_FALLBACK_SHELL, windowsTerminalLaunches } = await import("./terminal-launch.mjs");
    const { readFileSync } = await import("node:fs");
    // server/claude-accounts.ts labels the pasted sign-in command's shell on Windows
    expect(readFileSync(new URL("../server/claude-accounts.ts", import.meta.url), "utf8")).toMatch(/signInShell:process\.platform==="win32"\?"powershell" as const/);
    expect(WINDOWS_FALLBACK_SHELL).toBe("powershell");
    expect(windowsTerminalLaunches(WIN_ENV, () => false)[0][1][2]).toContain(`\\${WINDOWS_FALLBACK_SHELL}.exe"`);
  });

  it("awaits the PowerShell window's launcher exit, through spawn with no pipes held", async () => {
    const started = [];
    const start = (executable, args, options) => { started.push({ executable, args, options }); const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; };
    await expect(openBlankTerminal("win32", () => { throw new Error("wt is missing"); }, WIN_ENV, start, () => false)).resolves.toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0].options.stdio).toBe("ignore");
    const failing = (executable, args, options) => { const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 1)); return child; };
    await expect(openBlankTerminal("win32", () => {}, WIN_ENV, failing, () => false)).resolves.toBe(false);
  });

  it("the PowerShell window is reachable only from the person's own Open terminal actions", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("./", import.meta.url);
    const callers = [];
    for (const name of readdirSync(dir)) {
      if (!/\.(?:mjs|cjs|js)$/.test(name) || /\.(?:test|node-test)\./.test(name) || name === "terminal-launch.mjs") continue;
      const text = readFileSync(new URL(name, dir), "utf8");
      for (const line of text.split("\n")) if (/\b(?:openBlankTerminal|windowsTerminalLaunches)\(/.test(line)) callers.push(`${name}: ${line.trim()}`);
    }
    expect(callers).toEqual([
      "main.mjs: return openBlankTerminal();",
      "main.mjs: return openBlankTerminal();",
      "updater.mjs: return { command, terminalOpened: await openBlankTerminal() };",
    ]);
    const main = readFileSync(new URL("main.mjs", dir), "utf8");
    // the two main-process callers are the engine Open terminal buttons (an IPC call from the window, never a timer or startup)
    const handlers = [...main.matchAll(/ipcMain\.handle\("(engine:open(?:-setup)?-terminal)"[\s\S]*?\n\}\);/g)].map((match) => [match[1], match[0].includes("openBlankTerminal()")]);
    expect(handlers).toEqual([["engine:open-terminal", true], ["engine:open-setup-terminal", true]]);
  });

  it("waits for the Windows launcher result instead of its spawn event", async () => {
    let finish;
    let settled = false;
    const child = new EventEmitter();
    const result = openBlankTerminal("win32", (_exe, _args, _options, callback) => {
      finish = callback;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }, { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\Sam\\AppData\\Local" }, () => { throw new Error("fallback refused"); }, () => true).then((ok) => { settled = true; return ok; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(new Error("start failed"));
    await expect(result).resolves.toBe(false);
  });

  it("tries the next Linux terminal after an asynchronous launch error", async () => {
    const fake = launcher(["throw", "spawn"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(true);
    expect(fake.calls.map((call) => call.executable)).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
    ]);
    expect(fake.calls.every((call) => call.args.length === 0)).toBe(true);
  });

  it("returns false when no Linux terminal launches", async () => {
    const fake = launcher(["throw", "throw", "throw", "throw"]);
    await expect(openBlankTerminal("linux", fake.run)).resolves.toBe(false);
  });

  it("returns false when the launcher throws synchronously", async () => {
    const run = () => {
      throw new Error("launch failed");
    };
    await expect(openBlankTerminal("darwin", run)).resolves.toBe(false);
  });
});
