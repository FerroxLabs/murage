// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5 (Grok fuigo-windows-start r1 Medium): on Windows resolveFuigoCli version-checks an exact fuigo.exe, but a turn
// that launches the bare name `fuigo` looks it up again with PATHEXT, which tries .COM before .EXE (and a custom PATHEXT
// may put .CMD first). A fuigo.com or fuigo.cmd in the same folder as the checked exe then starts instead of it. The
// Fuigo driver now hands the launch, the `--version` probe and `fuigo models` the checked file itself (fuigoLaunchFile,
// AcpSupport.launchExecutable). The chain below is the one a turn composes: the driver's env step, the launch file, the
// launch file on that env's PATH (engineLaunchFile) and the spawn resolution (resolveCli). The platform is stubbed.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fuigo from "./drivers/acp/fuigo.ts";
import { augmentedPath, resetPathCacheForTests, restrictInstallScanDirsForTests } from "./env-path.ts";
import { engineLaunchFile } from "./drivers/isolation-cache.ts";
import { resolveCli } from "./procs.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const saved: Record<string, string | undefined> = {};
let root: string;
let binDir: string;

function file(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}
/** The driver's launch file (fuigoLaunchFile); a build without it runs the configured bare name. */
function launchFile(env: Record<string, string | undefined>, cli = "fuigo"): string {
  const pick = (fuigo as { fuigoLaunchFile?: (env: Record<string, string | undefined>, config: { cli: string }) => string }).fuigoLaunchFile;
  return pick ? pick(env, { cli }) : cli;
}
/** What a Fuigo turn spawns, composed the way core.ts does it. */
function turnSpawn(cli = "fuigo"): { command: string; args: string[] } {
  const env: Record<string, string | undefined> = { PATH: augmentedPath(), MURAGE_FUIGO_DIR: process.env.MURAGE_FUIGO_DIR };
  fuigo.reachBundledFuigo(env);
  return resolveCli(engineLaunchFile(launchFile(env, cli), { PATH: env.PATH }), ["agent", "--no-leader", "stdio"]);
}

describe("Fuigo on Windows launches the exact fuigo.exe it checked (1.0.5)", () => {
  beforeEach(() => {
    for (const key of ["PATH", "PATHEXT", "MURAGE_EXTRA_PATH", "MURAGE_FUIGO_DIR"]) saved[key] = process.env[key];
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    root = mkdtempSync(join(tmpdir(), "murage-fuigo-exact-"));
    binDir = join(root, ".fuigo", "bin");
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

  it("a fuigo.com beside the checked fuigo.exe never starts (default PATHEXT: .COM before .EXE)", () => {
    process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    const exe = file(binDir, "fuigo.exe", "MZ-not-really");
    file(binDir, "fuigo.com", "MZ-planted");
    restrictInstallScanDirsForTests([binDir]);
    expect(turnSpawn()).toEqual({ command: exe, args: ["agent", "--no-leader", "stdio"] });
    // the version probe and `fuigo models` run the same file
    expect(launchFile({ PATH: augmentedPath() })).toBe(exe);
  });

  it("a fuigo.cmd beside the checked fuigo.exe never starts under a PATHEXT that puts .CMD first", () => {
    process.env.PATHEXT = ".cmd;.exe;.com;.bat";
    const exe = file(binDir, "fuigo.exe", "MZ-not-really");
    file(binDir, "fuigo.cmd", "@ECHO off\r\n\"%~dp0\\payload.exe\" %*\r\n");
    file(binDir, "payload.exe", "MZ-planted");
    restrictInstallScanDirsForTests([binDir]);
    expect(turnSpawn()).toEqual({ command: exe, args: ["agent", "--no-leader", "stdio"] });
  });

  it("the bundled fuigo.exe, with a fuigo.com planted in the bundle folder, is the one that starts", () => {
    process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    const bundleDir = join(root, "Murage", "resources", "fuigo");
    const bundled = file(bundleDir, "fuigo.exe", "MZ-not-really");
    file(bundleDir, "fuigo.com", "MZ-planted");
    process.env.MURAGE_FUIGO_DIR = bundleDir;
    restrictInstallScanDirsForTests([]);
    expect(turnSpawn()).toEqual({ command: bundled, args: ["agent", "--no-leader", "stdio"] });
  });

  it("a custom cli is the user's own and runs as configured; no fuigo.exe anywhere keeps the bare name", () => {
    process.env.PATHEXT = ".com;.exe;.bat;.cmd";
    file(binDir, "fuigo.exe", "MZ-not-really");
    restrictInstallScanDirsForTests([binDir]);
    expect(launchFile({ PATH: augmentedPath() }, "C:\\tools\\my-fuigo.exe")).toBe("C:\\tools\\my-fuigo.exe");
    restrictInstallScanDirsForTests([]);
    resetPathCacheForTests();
    expect(launchFile({ PATH: augmentedPath() })).toBe("fuigo");
  });
});
