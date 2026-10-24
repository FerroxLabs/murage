// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: Fuigo starts on Windows from every install shape. Found on the Windows gate box (U24 lane record): npm's
// `fuigo.cmd` shim names an extensionless node script (`node_modules\fuigo\bin\fuigo`), which the shim parser could not
// turn into a spawn, so it handed back the `.cmd` itself and Node refused it (EINVAL: a .cmd needs a shell). And the
// shim won even where Murage had chosen another engine: the Windows lookup only searched Murage's own PATH, where npm's
// folder (%APPDATA%\npm, or the user's own npm prefix) comes before ~/.fuigo/bin and the bundled engine's folder.
//
// Shapes covered: the shipped (bundled) engine with npm's shim also installed, before the npm copy ever ran; an npm
// install whose first run put fuigo.exe in ~/.fuigo/bin; an npm install with nothing else (a user prefix, no bundle).
// Each composes the real chain a turn uses: the Fuigo driver's env step (reachBundledFuigo), the launch file
// (engineLaunchFile, on that env's PATH) and the spawn resolution (resolveCli). The platform is stubbed, so every OS
// runs these; on Windows the stub is the real platform and the resolved node script is also executed.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { augmentedPath, resetPathCacheForTests, restrictInstallScanDirsForTests } from "./env-path.ts";
import { reachBundledFuigo } from "./drivers/acp/fuigo.ts";
import { engineLaunchFile } from "./drivers/isolation-cache.ts";
import { resolveCli } from "./procs.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// The exact bytes npm 11 wrote for `npm install -g fuigo@1.0.31` on the gate box (C:\mm-fuigo-win, 2026-10-24).
const FUIGO_NPM_SHIM = `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fuigo\\bin\\fuigo" %*\r
`;
// fuigo@1.0.31's bin entry starts like this; the body here prints its argv so the Windows run can prove what started.
const FUIGO_BIN_ENTRY = "#!/usr/bin/env node\n// On Unix npm installs, the first run (fuigo-install.js) replaces this entry with a symlink to\n" +
  "console.log(JSON.stringify(process.argv.slice(2)));\n";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const saved: Record<string, string | undefined> = {};
let root: string;
let npmDir: string;

/** An npm install of fuigo into `prefix`: the .cmd shim, the POSIX sh shim beside it, and the package's bin entry. */
function npmInstall(prefix: string): string {
  mkdirSync(join(prefix, "node_modules", "fuigo", "bin"), { recursive: true });
  writeFileSync(join(prefix, "fuigo.cmd"), FUIGO_NPM_SHIM);
  writeFileSync(join(prefix, "fuigo"), "#!/bin/sh\nexec node \"$basedir/node_modules/fuigo/bin/fuigo\" \"$@\"\n");
  const entry = shimTarget(prefix);
  writeFileSync(entry, FUIGO_BIN_ENTRY);
  return entry;
}
/** Where the shim's `%dp0%\node_modules\fuigo\bin\fuigo` lands: join() of that Windows path. On Windows it is the
 *  package's bin file; on a POSIX file system (the stubbed runs) the backslashes are part of one file name, so the
 *  fixture writes its entry exactly there. */
function shimTarget(prefix: string): string {
  return join(prefix, "node_modules\\fuigo\\bin\\fuigo");
}
function exe(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "fuigo.exe");
  writeFileSync(file, "MZ-not-really");
  chmodSync(file, 0o755);
  return file;
}
/** What a Fuigo turn spawns: the driver's env, then the launch file on that env's PATH, then the spawn resolution. */
function fuigoTurnSpawn(): { command: string; args: string[] } {
  const env: Record<string, string | undefined> = { PATH: augmentedPath(), MURAGE_FUIGO_DIR: process.env.MURAGE_FUIGO_DIR };
  reachBundledFuigo(env);
  return resolveCli(engineLaunchFile("fuigo", { PATH: env.PATH }), ["agent", "--no-leader", "stdio"]);
}

describe("Fuigo starts on Windows from every install shape (1.0.5)", () => {
  beforeEach(() => {
    for (const key of ["PATH", "PATHEXT", "MURAGE_EXTRA_PATH", "MURAGE_FUIGO_DIR"]) saved[key] = process.env[key];
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    root = mkdtempSync(join(tmpdir(), "murage-fuigo-win-"));
    npmDir = join(root, "AppData", "Roaming", "npm");
    // Lower case, so a case-sensitive file system (Linux CI) finds what Windows would; Windows ignores the case.
    process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    // The process PATH holds only an empty folder; the install locations are exactly the ones a test names.
    const empty = join(root, "empty");
    mkdirSync(empty);
    process.env.PATH = empty;
    delete process.env.MURAGE_EXTRA_PATH;
    delete process.env.MURAGE_FUIGO_DIR;
    resetPathCacheForTests();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    restrictInstallScanDirsForTests(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPathCacheForTests();
    removeTempDirSync(root);
  });

  it("npm's fuigo.cmd shim resolves to `node <bin\\fuigo>`, its extensionless node script, never the .cmd", async () => {
    const entry = npmInstall(npmDir);
    restrictInstallScanDirsForTests([npmDir]);
    const resolved = resolveCli("fuigo", ["agent", "stdio"]);
    expect(resolved.command.toLowerCase()).not.toMatch(/\.cmd$/);
    expect(resolved.args).toEqual([entry, "agent", "stdio"]);
    expect(resolved.command).toMatch(/node(\.exe)?$/i);
    if (platform.value === "win32") {
      // the real platform: the resolved spawn runs, no shell, argv intact
      const args = ["agent", "a b", "%PATH%", "x&y|z"];
      const run = resolveCli("fuigo", args);
      const stdout = await new Promise<string>((resolve, reject) => execFile(run.command, run.args, (err, out) => (err ? reject(err) : resolve(out))));
      expect(JSON.parse(stdout)).toEqual(args);
    }
  });

  it("an extensionless shim target that is not a node script is never handed to node", () => {
    mkdirSync(join(npmDir, "node_modules", "fuigo", "bin"), { recursive: true });
    writeFileSync(join(npmDir, "fuigo.cmd"), FUIGO_NPM_SHIM);
    writeFileSync(shimTarget(npmDir), "#!/bin/sh\necho not node\n");
    restrictInstallScanDirsForTests([npmDir]);
    // unparseable: handed back as it is, so spawn refuses it (no shell is ever used)
    expect(resolveCli("fuigo", ["agent"]).command.toLowerCase()).toBe(join(npmDir, "fuigo.cmd").toLowerCase());
  });

  it("a shim target that steps out of the shim's folder (`..`) is never run, as a node script or as an exe", () => {
    for (const target of ["..\\..\\..\\payload", "node_modules\\..\\..\\payload.js", "..\\evil.exe"]) {
      mkdirSync(npmDir, { recursive: true });
      writeFileSync(join(npmDir, "fuigo.cmd"), FUIGO_NPM_SHIM.replace("node_modules\\fuigo\\bin\\fuigo", target));
      // the file exists where the shim points (on a POSIX file system join() keeps the backslashes in one name)
      const planted = join(npmDir, target);
      mkdirSync(dirname(planted), { recursive: true });
      writeFileSync(planted, "#!/usr/bin/env node\nconsole.log('payload')\n");
      restrictInstallScanDirsForTests([npmDir]);
      resetPathCacheForTests();
      const resolved = resolveCli("fuigo", ["agent"]);
      expect(resolved.args).not.toContain(planted);
      expect(resolved.command).not.toBe(planted);
      expect(resolved.command.toLowerCase()).toBe(join(npmDir, "fuigo.cmd").toLowerCase());
    }
  });

  it("a shim target that names a drive or a root is never run", () => {
    if (platform.value === "win32") return;                                             // the planted file's name is only creatable on POSIX
    for (const target of ["C:\\Users\\x\\payload.js", "\\\\host\\share\\payload.js"]) {
      mkdirSync(npmDir, { recursive: true });
      writeFileSync(join(npmDir, "fuigo.cmd"), FUIGO_NPM_SHIM.replace("node_modules\\fuigo\\bin\\fuigo", target));
      writeFileSync(join(npmDir, target.replace(/^\\/, "")), "console.log('payload')\n");
      restrictInstallScanDirsForTests([npmDir]);
      resetPathCacheForTests();
      expect(resolveCli("fuigo", ["agent"]).command.toLowerCase()).toBe(join(npmDir, "fuigo.cmd").toLowerCase());
    }
  });

  it("a shim target that is a link to a file outside the shim's folder is never run", () => {
    if (platform.value === "win32") return;                                             // links need extra rights on Windows
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, "fuigo.cmd"), FUIGO_NPM_SHIM);
    const outside = join(root, "outside-payload");
    writeFileSync(outside, "#!/usr/bin/env node\nconsole.log('payload')\n");
    symlinkSync(outside, shimTarget(npmDir));
    restrictInstallScanDirsForTests([npmDir]);
    expect(resolveCli("fuigo", ["agent"]).command.toLowerCase()).toBe(join(npmDir, "fuigo.cmd").toLowerCase());
  });

  it("shipped engine plus an npm install that never ran: the bundled fuigo.exe runs, not npm's shim", () => {
    npmInstall(npmDir);
    const bundled = exe(join(root, "Murage", "resources", "fuigo"));
    process.env.MURAGE_FUIGO_DIR = join(root, "Murage", "resources", "fuigo");
    restrictInstallScanDirsForTests([npmDir]);
    expect(fuigoTurnSpawn()).toEqual({ command: bundled, args: ["agent", "--no-leader", "stdio"] });
  });

  it("npm install that already ran (fuigo.exe in ~/.fuigo/bin): the fuigo.exe Murage chose runs, not the shim before it", () => {
    npmInstall(npmDir);
    const home = exe(join(root, ".fuigo", "bin"));
    // windowsKnownDirs' own order: %APPDATA%\npm before ~/.fuigo/bin
    restrictInstallScanDirsForTests([npmDir, join(root, ".fuigo", "bin")]);
    expect(fuigoTurnSpawn()).toEqual({ command: home, args: ["agent", "--no-leader", "stdio"] });
  });

  it("an npm user prefix on PATH and nothing else: the shim's node script runs", () => {
    const prefix = join(root, "npm-prefix");
    const entry = npmInstall(prefix);
    process.env.PATH = [prefix, process.env.PATH].join(delimiter);
    restrictInstallScanDirsForTests([]);
    resetPathCacheForTests();
    const spawn = fuigoTurnSpawn();
    expect(spawn.command).toMatch(/node(\.exe)?$/i);
    expect(spawn.args).toEqual([entry, "agent", "--no-leader", "stdio"]);
  });

  it("the version probe runs the same file the turn launches: execCli's lookup searches the handed PATH first", () => {
    npmInstall(npmDir);
    const bundled = exe(join(root, "bundle"));
    restrictInstallScanDirsForTests([npmDir]);
    expect(resolveCli("fuigo", ["--version"], [join(root, "bundle"), augmentedPath()].join(delimiter)).command).toBe(bundled);
    // and with no handed PATH, Murage's own PATH as before
    expect(resolveCli("fuigo", ["--version"]).args[0]).toBe(shimTarget(npmDir));
  });
});
