// PATH augmentation contract (issues #8, #12): a CLI living in a
// well-known install dir — or an nvm bin dir — must be findable even
// when the process itself started with a bare GUI PATH.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { augmentedPath, resetPathCacheForTests, resolveCliSpawn } from "./env-path.ts";

const posixIt = it.skipIf(process.platform === "win32");

describe("augmentedPath", () => {
  afterEach(() => {
    delete process.env.OMB_EXTRA_PATH;
    resetPathCacheForTests();
  });

  it("keeps the existing PATH entries first", () => {
    resetPathCacheForTests();
    const path = augmentedPath();
    const firstExisting = (process.env.PATH ?? "").split(delimiter).filter(Boolean)[0];
    // OMB_EXTRA_PATH is unset here, so the inherited PATH leads
    expect(path.split(delimiter)[0]).toBe(firstExisting);
  });

  it("prepends OMB_EXTRA_PATH and dedupes", () => {
    process.env.OMB_EXTRA_PATH = ["/tmp/omb-extra", "/tmp/omb-extra"].join(delimiter);
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    expect(parts[0]).toBe("/tmp/omb-extra");
    expect(parts.filter((p) => p === "/tmp/omb-extra")).toHaveLength(1);
  });

  posixIt("includes nvm bin dirs from the home dir, newest node first", () => {
    // setup.ts points homedir at a temp dir, so this is hermetic
    const nvm = join(homedir(), ".nvm", "versions", "node");
    mkdirSync(join(nvm, "v9.0.0", "bin"), { recursive: true });
    mkdirSync(join(nvm, "v24.2.0", "bin"), { recursive: true });
    resetPathCacheForTests();

    const parts = augmentedPath().split(delimiter);
    const v24 = parts.indexOf(join(nvm, "v24.2.0", "bin"));
    const v9 = parts.indexOf(join(nvm, "v9.0.0", "bin"));
    expect(v24).toBeGreaterThan(-1);
    expect(v9).toBeGreaterThan(-1);
    // numeric sort: v24 outranks v9 despite lexicographic order
    expect(v24).toBeLessThan(v9);
  });

  posixIt("makes a CLI in a known install dir spawnable despite a bare PATH", async () => {
    const bin = join(homedir(), ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "omb-fake-cli");
    writeFileSync(fake, "#!/bin/sh\necho found-me\n");
    chmodSync(fake, 0o755);
    resetPathCacheForTests();

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "omb-fake-cli",
        [],
        // bare GUI-style PATH + our augmentation — the augmentation must win
        { env: { PATH: augmentedPath() } },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    expect(stdout.trim()).toBe("found-me");
  });

  it("skips known dirs that do not exist", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    // temp home: .volta was never created, so it must not appear
    expect(parts).not.toContain(join(homedir(), ".volta", "bin"));
  });
});

// Windows CLI resolution — spawn(cli) alone finds nothing on Windows (no
// PATHEXT in libuv, no #!, and a .cmd throws outright since Node's
// CVE-2024-27980 fix). Fixtures are the two real npm shim shapes.
const winOnly = describe.skipIf(process.platform !== "win32");

// the exact bytes npm writes for a CLI whose bin is a native binary
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\pkg\\bin\\ombfake.exe"   %*
`;

// ...and for one whose bin is a node script (the "_prog" dance)
const JS_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\ombfake.js" %*
`;

describe("resolveCliSpawn", () => {
  it.skipIf(process.platform === "win32")("is identity off Windows — the kernel already resolves PATH and #!", () => {
    expect(resolveCliSpawn("claude", ["-p", "hi"])).toEqual({ command: "claude", args: ["-p", "hi"] });
  });
});

winOnly("resolveCliSpawn (Windows)", () => {
  let dir: string;
  const onPath = () => {
    process.env.OMB_EXTRA_PATH = dir;
    resetPathCacheForTests();
  };
  const shimWith = (name: string, body: string, target: string, targetBody: string) => {
    writeFileSync(join(dir, name), body);
    mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "bin", target), targetBody);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-shim-"));
  });
  afterEach(() => {
    delete process.env.OMB_EXTRA_PATH;
    resetPathCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses an npm .cmd shim down to the .exe it wraps", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    onPath();
    expect(resolveCliSpawn("ombfake", ["-p", "hi"])).toEqual({
      command: join(dir, "node_modules", "pkg", "bin", "ombfake.exe"),
      args: ["-p", "hi"],
    });
  });

  it("parses an npm .cmd shim down to `node <cli.js>`, never the shim's own node.exe", async () => {
    shimWith("ombfake.cmd", JS_SHIM, "ombfake.js", "console.log('js target ' + process.argv.slice(2).join(','));\n");
    onPath();
    const r = resolveCliSpawn("ombfake", ["-p", "hi"]);
    expect(r.args).toEqual([join(dir, "node_modules", "pkg", "bin", "ombfake.js"), "-p", "hi"]);
    expect(r.command.toLowerCase()).toMatch(/node\.exe$/);
    expect(r.windowsVerbatimArguments).toBeUndefined();

    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("js target -p,hi");
  });

  it("prefers the PATHEXT hit over the extensionless sibling npm installs beside it", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    writeFileSync(join(dir, "ombfake"), "#!/bin/sh\n# the POSIX shim — unrunnable here\n");
    onPath();
    expect(resolveCliSpawn("ombfake", []).command).toBe(join(dir, "node_modules", "pkg", "bin", "ombfake.exe"));
  });

  it("runs a #!node script through node — Windows has no shebang support", async () => {
    const script = join(dir, "ombfake-cli.ts");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log('shebang ' + process.argv.slice(2).join(','));\n");
    const r = resolveCliSpawn(script, ["a", "b"]);
    expect(r.command.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(r.args).toEqual([script, "a", "b"]);

    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("shebang a,b");
  });

  it("falls back to ComSpec for an unparseable shim, and a raw-JSON argument survives it byte for byte", async () => {
    // no "%dp0%"-relative target to find: the fallback is the only route
    writeFileSync(
      join(dir, "ombfake.cmd"),
      "@ECHO OFF\nnode -e \"require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))\" %*\n",
    );
    onPath();
    const out = join(dir, "seen.json");
    // the real payload this has to survive: claude's --mcp-config
    const payload = JSON.stringify({
      mcpServers: {
        ogb: {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["a b", "%PATH%", "x&y|z", "q^r", "<in>out"],
          env: { TOK: 'he said "hi"' },
        },
      },
    });

    const r = resolveCliSpawn("ombfake", [out, "--mcp-config", payload]);
    expect(r.windowsVerbatimArguments).toBe(true);
    expect(r.command.toLowerCase()).toMatch(/cmd\.exe$/);

    await new Promise<void>((resolve, reject) =>
      execFile(r.command, r.args, { windowsVerbatimArguments: true }, (err) => (err ? reject(err) : resolve())),
    );
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--mcp-config", payload]);
  });

  it("hands an unknown CLI back untouched so spawn reports its own ENOENT", () => {
    onPath();
    expect(resolveCliSpawn("definitely-not-installed", ["-p"])).toEqual({
      command: "definitely-not-installed",
      args: ["-p"],
    });
  });
});
