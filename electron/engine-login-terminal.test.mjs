// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The trusted terminal launcher (ENGINE-SIGNIN-SIMPLE-1014, Terminal fallback): the recipe argv on the owner's own environment, account keys pinned, a supervisor, no command text from a window.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { launchRecipeTerminal, LINUX_TERMINALS, linuxTerminalLaunch, macCommandFile, terminalEnv, windowsConsoleLine } from "./engine-login-terminal.mjs";

const recipe = { argv: ["/opt/my tools/cline", "auth"], env: { PATH: "/p", HOME: "/h" }, accountEnv: { CLINE_DIR: "/acct/cline" } };
const spawned = (event = "spawn", extra = {}) => vi.fn(() => { const child = new EventEmitter(); child.pid = 77; child.unref = () => {}; Object.assign(child, extra); queueMicrotask(() => child.emit(event, event === "exit" ? 0 : undefined)); return child; });

describe("the environment", () => {
  it("is the owner's own, proxy included, with Murage's names out and the account keys on top", () => {
    expect(terminalEnv(recipe, { HTTPS_PROXY: "http://proxy", PATH: "/owner", MURAGE_X: "1", ELECTRON_RUN_AS_NODE: "1", CLINE_DIR: "/other" })).toEqual({ HTTPS_PROXY: "http://proxy", PATH: "/owner", CLINE_DIR: "/acct/cline" });
  });
});

describe("Mac", () => {
  it("writes a script that quotes every word, removes itself, and writes its pid", () => {
    const text = macCommandFile({ argv: ["/opt/it's/cline", "auth"], env: { PATH: "/p", OPENAI_API_KEY: "x" }, accountEnv: { CLINE_DIR: "/acct" } }, "/tmp/x/pid");
    expect(text.split("\n").slice(0, 3)).toEqual(["#!/bin/bash", '/bin/rm -f -- "$0"', "echo $$ > '/tmp/x/pid'"]);
    expect(text).toContain(`'/opt/it'"'"'s/cline' 'auth'`);
    expect(text).toContain("exec '/usr/bin/env' 'CLINE_DIR=/acct' '/opt/it'");
    expect(text).not.toContain("'-i'");
    expect(text).not.toContain("OPENAI_API_KEY");
    expect(text).not.toContain("PATH=");
  });
  it("is null for a line break, a bad name or an empty argv", () => {
    expect(macCommandFile({ argv: ["/a\nb"], env: {} }, "/p")).toBeNull();
    expect(macCommandFile({ argv: ["/a"], env: {}, accountEnv: { "A;B": "x" } }, "/p")).toBeNull();
    expect(macCommandFile({ argv: [], env: {} }, "/p")).toBeNull();
    expect(macCommandFile({ argv: ["/a"], env: {}, accountEnv: { A: "x\ny" } }, "/p")).toBeNull();
  });
  it("opens it, reads the pid, removes the folder, and the supervisor stops that pid", async () => {
    const files = new Map();
    const removed = [];
    const fs = { mkdtemp: async (prefix) => `${prefix}abc`, chmod: async () => {}, writeFile: async (file, text, options) => { files.set(file, { text, options }); }, readFile: async () => "4321\n", rm: async (path) => { removed.push(path); } };
    const killed = [];
    const start = spawned("exit");
    const result = await launchRecipeTerminal(recipe, { platform: "darwin", start, fs, temp: "/private", wait: async () => {}, kill: (pid, signal) => { killed.push([pid, signal]); } });
    expect(result.ok).toBe(true);
    const [file, args] = start.mock.calls[0];
    expect(file).toBe("/usr/bin/open");
    expect(args.slice(0, 2)).toEqual(["-a", "Terminal"]);
    expect(args[2]).toMatch(/Sign in\.command$/);
    expect([...files.values()][0].options.mode).toBe(0o700);
    expect(removed).toEqual(["/private/murage-engine-signin-abc"]);
    await result.supervisor.stop();
    expect(killed).toContainEqual([4321, "SIGTERM"]);
    expect(killed).toContainEqual([4321, "SIGKILL"]);
  });
  it("reports a window that never opened, and leaves no folder", async () => {
    const removed = [];
    const fs = { mkdtemp: async (prefix) => `${prefix}abc`, chmod: async () => {}, writeFile: async () => {}, readFile: async () => "", rm: async (path) => { removed.push(path); } };
    const start = vi.fn(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 1)); return child; });
    expect(await launchRecipeTerminal(recipe, { platform: "darwin", start, fs, temp: "/private", wait: async () => {} })).toEqual({ ok: false, code: "failed" });
    expect(removed).toHaveLength(1);
  });
});

describe("Linux", () => {
  it("uses a fixed absolute list", () => {
    for (const terminal of LINUX_TERMINALS) expect(terminal.file.startsWith("/usr/bin/")).toBe(true);
  });
  it("takes the first that exists, and runs the recipe argv on the owner's environment", () => {
    const launch = linuxTerminalLaunch(recipe, { exists: (file) => file === "/usr/bin/gnome-terminal", env: { DISPLAY: ":0", HTTPS_PROXY: "http://proxy", MURAGE_X: "1", HOME: "/h" } });
    expect(launch.file).toBe("/usr/bin/gnome-terminal");
    expect(launch.args).toEqual(["--wait", "--", "/opt/my tools/cline", "auth"]);
    expect(launch.options.env).toEqual({ DISPLAY: ":0", HTTPS_PROXY: "http://proxy", HOME: "/h", CLINE_DIR: "/acct/cline" });
  });
  it('is the "Finish in your terminal" case when none exists', async () => {
    expect(await launchRecipeTerminal(recipe, { platform: "linux", exists: () => false, start: spawned() })).toEqual({ ok: false, code: "no-terminal" });
  });
  it("keeps the emulator's pid as the supervisor, and ends its group", async () => {
    const killed = [];
    const result = await launchRecipeTerminal(recipe, { platform: "linux", exists: () => true, start: spawned(), kill: (pid, signal) => { killed.push([pid, signal]); } });
    expect(result.supervisor.alive()).toBe(true);
    await result.supervisor.stop();
    expect(killed).toEqual([[-77, "SIGTERM"]]);
  });
  it("reports an emulator that failed to start", async () => {
    expect(await launchRecipeTerminal(recipe, { platform: "linux", exists: () => true, start: spawned("error") })).toEqual({ ok: false, code: "failed" });
  });
});

describe("Windows", () => {
  it("opens the recipe through cmd's start, so it has a real console, with the owner's env and every word quoted", async () => {
    const start = spawned();
    const windows = { argv: ["C:\\nodejs\\node.exe", "C:\\npm\\cli.js", "auth"], env: {}, accountEnv: { CODEX_HOME: "C:\\acct" } };
    const result = await launchRecipeTerminal(windows, { platform: "win32", start, env: { Path: "C:\\bin", MURAGE_X: "1", SystemRoot: "C:\\Windows" } });
    expect(result.ok).toBe(true);
    const [file, args, options] = start.mock.calls[0];
    expect(file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(args).toEqual(['/d /c start "Murage sign-in" /wait "C:\\nodejs\\node.exe" "C:\\npm\\cli.js" "auth"']);
    expect(options).toEqual({ env: { Path: "C:\\bin", SystemRoot: "C:\\Windows", CODEX_HOME: "C:\\acct" }, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, shell: false });
  });
  it("a word cmd would read refuses the launch, and & stays inside its quotes", async () => {
    for (const word of ['C:\\a"b.exe', "C:\\%PATH%\\x.exe"]) {
      const start = spawned();
      expect(await launchRecipeTerminal({ argv: [word], env: {} }, { platform: "win32", start, env: {} })).toEqual({ ok: false, code: "failed" });
      expect(start).not.toHaveBeenCalled();
    }
    expect(windowsConsoleLine({ argv: ["C:\\Tom&Jerry\\x.exe"], env: {} })).toBe('/d /c start "Murage sign-in" /wait "C:\\Tom&Jerry\\x.exe"');
  });
});
