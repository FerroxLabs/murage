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
    expect(fake.calls).toEqual([
      {
        executable: "osascript",
        args: ["-e", 'tell application "Terminal" to activate'],
        options: undefined,
      },
    ]);
  });

  it("opens a blank PowerShell window on Windows", async () => {
    const fake = launcher(["spawn"]);
    await expect(openBlankTerminal("win32", fake.run)).resolves.toBe(true);
    expect(fake.calls[0]).toMatchObject({ executable: "powershell.exe", options: { windowsHide: true, timeout: 15_000 } });
    expect(fake.calls[0].args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(fake.calls[0].args[4]).toContain("Start-Process");
    expect(fake.calls[0].args[4]).toContain("-WindowStyle Normal -ErrorAction Stop");
  });

  it("waits for the Windows bootstrap result instead of its spawn event", async () => {
    let finish;
    let settled = false;
    const child = new EventEmitter();
    const result = openBlankTerminal("win32", (_exe, _args, _options, callback) => {
      finish = callback;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }).then((ok) => { settled = true; return ok; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(new Error("Start-Process failed"));
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
