// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (c) of APP-GRANT-FIXPLAN-r6 (Rules 35, 74a, 74d): an approved write to a startup file is recognized by the
// file's RESOLVED identity, never by its spelling, and moves the environment generation (server/env-path.ts).

import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PinRun } from "../shared/arg-vocabulary.ts";
import { handEnv, noteStartupFileEvent } from "./engine-env.ts";

/** The pin probes answered as on a machine with no ssh and no git config. */
const noRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });
import { envGeneration } from "./env-path.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
let home: string;
let seq = 0;

beforeEach(() => {
  // the native real path: on Windows it reads an 8.3 short name (RUNNER~1) as its long name, as the product's placement does
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "startup-files-")));
  home = join(dir, "h");
  mkdirSync(home, { recursive: true });
});
afterEach(() => removeTempDirSync(dir));

/** The owner map as captured, before the pins; the hand pins ZDOTDIR and removes BASH_ENV, ENV and CLAUDE_ENV_FILE. */
async function hand(extraOwner: Record<string, string> = {}) {
  return handEnv(
    { env: { PATH: "/usr/bin:/bin", HOME: home, ...extraOwner }, capture: "session" },
    { platform: "linux", run: noRun, extra: { CLAUDE_CODE_SHELL_PREFIX: join(dir, "mx", "murage-exec-0123abcd"), MURAGE_EXEC_ENV_FILE: join(dir, "mx", "env", "f1") } },
  );
}

/** One permission ask, then its allow; true when the environment generation moved. */
function approve(ask: Record<string, unknown>): boolean {
  const requestId = `sf-${++seq}`;
  const before = envGeneration();
  noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t-sf", requestId, ...ask } as never);
  noteStartupFileEvent({ type: "request.resolved", threadId: "t-sf", requestId, behavior: "allow" });
  return envGeneration() > before;
}

const shellAsk = (command: string, cwd = dir) => ({ toolCall: { name: "shell", input: { command, cwd } }, execEnv: { env: {}, absent: [], cwd, shell: ["/bin/sh", "-c"], capture: "session" } });
const fileAsk = (path: string, cwd = dir) => ({ filePaths: [path], execEnv: { env: {}, absent: [], cwd, shell: ["/bin/sh", "-c"], capture: "session" } });

/** On Windows the POSIX system startup files (/etc/profile, ...) are rooted paths with no drive, which cannot be placed, so
 *  the startup set is unreadable and every file ask counts as touching: an approved write re-captures (fails closed). */
const fileAskFailsClosed = process.platform === "win32";

describe("startup files by resolved identity", () => {
  it("handEnv keeps the owner's startup names from before the pins beside the pinned map", async () => {
    const handed = await hand({ ZDOTDIR: join(dir, "o", "zd"), BASH_ENV: join(dir, "startup") });
    expect(handed.env.ZDOTDIR).toBe("/dev/null");
    expect(handed.env.BASH_ENV).toBeUndefined();
    expect((handed as unknown as { ownerStartup: Record<string, string> }).ownerStartup).toMatchObject({ HOME: home, ZDOTDIR: join(dir, "o", "zd"), BASH_ENV: join(dir, "startup") });
  });

  it("each Rule 74d entry bumps the generation", async () => {
    const zd = join(dir, "o", "zd");
    await hand({ ZDOTDIR: zd, BASH_ENV: join(dir, "bash-env"), ENV: join(dir, "sh-env"), PSQLRC: join(dir, "psqlrc-file"), CLAUDE_ENV_FILE: join(dir, "claude-env") });
    const homeNames = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bash_profile", ".bash_login", ".bashrc", ".profile", ".bash_logout", ".config/fish/config.fish", ".config/fish/conf.d/extra.fish", ".psqlrc"];
    const zdNames = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
    const etc = ["/etc/profile", "/etc/profile.d/extra.sh", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zshenv", "/etc/zsh/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin"];
    const named = [join(dir, "bash-env"), join(dir, "sh-env"), join(dir, "psqlrc-file"), join(dir, "claude-env")];
    const own = [join(dir, "mx", "murage-exec-0123abcd"), join(dir, "mx", "env", "f1")];
    const all = [...homeNames.map((name) => join(home, name)), ...zdNames.map((name) => join(zd, name)), ...etc, ...named, ...own];
    for (const path of all) expect([path, approve(fileAsk(path))]).toEqual([path, true]);
    // the .envrc of the command's directory
    expect(approve(fileAsk(".envrc", dir))).toBe(true);
    // cmd's AutoRun stays a text row
    expect(approve(shellAsk(String.raw`reg add "HKCU\Software\Microsoft\Command Processor" /v AutoRun /d x /f`))).toBe(true);
  });

  it("a symlink and a hard link to ~/.zlogin, and link/../.zshrc, bump the generation", async () => {
    await hand();
    writeFileSync(join(home, ".zlogin"), "");
    symlinkSync(join(home, ".zlogin"), join(dir, "soft"));
    linkSync(join(home, ".zlogin"), join(dir, "hard"));
    mkdirSync(join(home, "sub"));
    symlinkSync(join(home, "sub"), join(dir, "link"));
    expect(approve(fileAsk(join(dir, "soft")))).toBe(true);
    expect(approve(fileAsk(join(dir, "hard")))).toBe(true);
    expect(approve(fileAsk("link/../.zshrc", dir))).toBe(true);
    expect(approve(shellAsk(`echo x >> ${join(dir, "hard")}`))).toBe(true);
  });

  it("an owner ZDOTDIR is a startup folder after the pinned hand", async () => {
    const zd = join(dir, "o", "zd");
    mkdirSync(zd, { recursive: true });
    const handed = await hand({ ZDOTDIR: zd });
    expect(handed.env.ZDOTDIR).toBe("/dev/null");
    expect(approve(fileAsk(join(zd, ".zshrc")))).toBe(true);
  });

  it("the file the owner's BASH_ENV names bumps the generation and another file does not", async () => {
    await hand({ BASH_ENV: join(dir, "startup") });
    expect(approve(shellAsk(`echo >> ${join(dir, "startup")}`))).toBe(true);
    expect(approve(fileAsk(join(dir, "startup")))).toBe(true);
    expect(approve(fileAsk(join(dir, "other")))).toBe(fileAskFailsClosed);
  });

  it("a destination a copy derives from a folder operand is a target (Astra r6 item 5)", async () => {
    await hand();
    mkdirSync(join(dir, "src", "fish", "conf.d"), { recursive: true });
    writeFileSync(join(dir, "src", ".zlogin"), "");
    writeFileSync(join(dir, "src", "plain"), "");
    // `cp /tmp/.zlogin /home/owner` writes /home/owner/.zlogin
    for (const command of [`cp ${join(dir, "src", ".zlogin")} ${home}`, `cp ${join(dir, "src", ".zlogin")} ${home}/`, `mv ${join(dir, "src", ".zlogin")} ${home}`,
      `install -m 600 ${join(dir, "src", ".zlogin")} ${home}`, `cp -t ${home} ${join(dir, "src", ".zlogin")}`, `cp --target-directory=${home} ${join(dir, "src", ".zlogin")}`,
      `ln -s ${join(dir, "src", ".zlogin")} ${home}`, `cp ${join(dir, "src", ".zlogin")} .`]) {
      expect([command, approve(shellAsk(command, command.endsWith(" .") ? home : dir))]).toEqual([command, true]);
    }
    expect(approve({ toolCall: { name: "shell", input: { command: ["cp", join(dir, "src", ".zlogin"), home], cwd: dir } } })).toBe(true);
    // a folder copied into ~/.config writes the fish conf.d under it
    mkdirSync(join(home, ".config"), { recursive: true });
    expect(approve(shellAsk(`cp -r ${join(dir, "src", "fish")} ${join(home, ".config")}`))).toBe(true);
    // a file copy that names no startup file does not
    expect(approve({ filePaths: [join(home, "plain")] })).toBe(fileAskFailsClosed);
  });

  it("a target that cannot be placed, or a command that cannot be read whole, counts as touching", async () => {
    await hand();
    expect(approve(fileAsk("~nobody/x"))).toBe(true);
    expect(approve(shellAsk("bash -c 'echo >> ~/.zshrc'"))).toBe(true);
    expect(approve(shellAsk(`echo $X >> ${join(dir, "other")}`))).toBe(true);
  });

  // Astra build r8, item 2 (interim until the walker-based targetsOf lands): a command's targets are not read whole, so every
  // approved command counts as touching and re-captures; only a file ask is placed by identity.
  it("every approved command re-captures, whatever it names (Astra r8 item 2, interim)", async () => {
    await hand();
    mkdirSync(join(dir, "dotfiles"), { recursive: true });
    writeFileSync(join(dir, "dotfiles", ".zshrc"), "");
    for (const command of [`cp -R ${join(dir, "dotfiles")}/. ${home}`, `cp -a ${join(dir, "dotfiles")}/. ${home}/`, `rsync -a ${join(dir, "dotfiles")}/ ${home}/`,
      `tar -xf ${join(dir, "d.tar")} -C ${home}`, `cd ${home} && cp ${join(dir, "dotfiles")}/.zshrc .`, `echo >> ${join(dir, "other")}`, "ls", "git status"]) {
      expect([command, approve(shellAsk(command))]).toEqual([command, true]);
    }
    expect(approve({ toolCall: { name: "shell", input: { command: ["cp", "-R", `${join(dir, "dotfiles")}/.`, home], cwd: dir } } })).toBe(true);
    expect(approve({ toolCall: { name: "exec_command", input: { cmd: "ls" } } })).toBe(true);
    expect(approve({ toolCall: { name: "bash", input: {} } })).toBe(true);
    // Astra r9 item 4: every key the shared command reader knows counts, whatever the tool is called
    expect(approve({ toolCall: { name: "mcp__local__run", input: { script: `cp -R ${join(dir, "dotfiles")}/. ${home}` } } })).toBe(true);
    expect(approve({ toolCall: { name: "mcp__local__run", input: { code: "ls" } } })).toBe(true);
    expect(approve({ toolCall: { name: "mcp__local__run", input: { cmd: ["ls", "-a"] } } })).toBe(true);
    expect(approve({ toolCall: { name: "mcp__local__run", input: { script: "" } } })).toBe(true);
    // a denied command does not
    const requestId = `sf-${++seq}`;
    const before = envGeneration();
    noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t-sf", requestId, ...shellAsk("ls") } as never);
    noteStartupFileEvent({ type: "request.resolved", threadId: "t-sf", requestId, behavior: "deny" });
    expect(envGeneration()).toBe(before);
    // a file ask is still placed by identity
    expect(approve(fileAsk(join(dir, "other")))).toBe(fileAskFailsClosed);
    expect(approve({ toolCall: { name: "edit", input: { file_path: join(dir, "src", "app.ts") } } })).toBe(fileAskFailsClosed);
  });

  it("startupSet lists resolved identities: an existing file carries its device and inode, a missing one is its real parent and name", async () => {
    const { startupSet } = await import("./startup-files.ts");
    writeFileSync(join(home, ".zshrc"), "");
    symlinkSync(home, join(dir, "home-link"));
    const handed = await handEnv({ env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home-link") }, capture: "session" }, { platform: "linux", run: noRun });
    const set = startupSet(handed, { BASH_ENV: join(dir, "per-command") });
    const zshrc = set.entries.find((entry) => entry.real === join(home, ".zshrc"));
    expect(zshrc?.devIno).toBeTruthy();
    const zlogin = set.entries.find((entry) => entry.real === join(home, ".zlogin"));
    expect(zlogin).toBeTruthy();
    expect(zlogin?.devIno).toBeUndefined();
    expect(set.entries.some((entry) => entry.real === join(dir, "per-command"))).toBe(true);
  });

  it("engine-env.ts names no row id and holds no RegExp; its note asks only askTouchesStartup", () => {
    const source = readFileSync(join(import.meta.dirname, "engine-env.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    expect(code).not.toMatch(/shell-rc|cmd-autorun|SENSITIVE_PATHS|SENSITIVE_TEXT|STARTUP_ROWS|RegExp/);
    // no regex literal: a slash opening an expression after `(`, `,`, `=`, `:` or `[`
    expect(code).not.toMatch(/[(,=:[!&|?]\s*\/(?![/*])[^/\n]+\/[dgimsuy]*/);
    const note = code.slice(code.indexOf("export function noteStartupFileEvent"));
    expect(note).toContain("askTouchesStartup(");
    expect(note).toContain("invalidateEnvCapture(");
  });
});
