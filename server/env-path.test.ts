// PATH augmentation contract (issues #8, #12): a CLI living in a
// well-known install dir — or an nvm bin dir — must be findable even
// when the process itself started with a bare GUI PATH.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  augmentedPath,
  bundledFuigoPath,
  resetPathCache,
  resetPathCacheForTests,
  resolveFuigoCli,
  splitCliString,
} from "./env-path.ts";
import { resolveCli } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// Forward real filesystem behavior by default. The Fuigo resource tests below
// restrict only existsSync's view of the machine, without replacing candidate
// lookup or changing the production preference for user-installed engines.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const posixIt = it.skipIf(process.platform === "win32");

describe("augmentedPath", () => {
  afterEach(() => {
    delete process.env.MURAGE_EXTRA_PATH;
    resetPathCacheForTests();
  });

  it("keeps the existing PATH entries first", () => {
    resetPathCacheForTests();
    const path = augmentedPath();
    const firstExisting = (process.env.PATH ?? "").split(delimiter).filter(Boolean)[0];
    // MURAGE_EXTRA_PATH is unset here, so the inherited PATH leads
    expect(path.split(delimiter)[0]).toBe(firstExisting);
  });

  it("prepends MURAGE_EXTRA_PATH and dedupes", () => {
    process.env.MURAGE_EXTRA_PATH = ["/tmp/murage-extra", "/tmp/murage-extra"].join(delimiter);
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    expect(parts[0]).toBe("/tmp/murage-extra");
    expect(parts.filter((p) => p === "/tmp/murage-extra")).toHaveLength(1);
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

  posixIt("includes a user npm prefix at ~/.npm-global/bin", () => {
    const npmGlobal = join(homedir(), ".npm-global", "bin");
    mkdirSync(npmGlobal, { recursive: true });
    resetPathCacheForTests();
    expect(augmentedPath().split(delimiter)).toContain(npmGlobal);
  });

  posixIt("makes a CLI in a known install dir spawnable despite a bare PATH", async () => {
    const bin = join(homedir(), ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "murage-fake-cli");
    writeFileSync(fake, "#!/bin/sh\necho found-me\n");
    chmodSync(fake, 0o755);
    resetPathCacheForTests();

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "murage-fake-cli",
        [],
        // bare GUI-style PATH + our augmentation — the augmentation must win
        { env: { PATH: augmentedPath() } },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    expect(stdout.trim()).toBe("found-me");
  });

  posixIt("keeps the last login-shell PATH available during a rescan", async () => {
    const shell = join(homedir(), "fake-login-shell");
    const rcOnlyBin = join(homedir(), "rc-only", "bin");
    writeFileSync(shell, `#!/bin/sh\nprintf '__MURAGE_PATH__%s' '${rcOnlyBin}'\n`);
    chmodSync(shell, 0o755);

    const previousShell = process.env.SHELL;
    const previousVitest = process.env.VITEST;
    try {
      process.env.SHELL = shell;
      delete process.env.VITEST;
      resetPathCacheForTests();

      augmentedPath();
      await vi.waitFor(() => expect(augmentedPath().split(delimiter)).toContain(rcOnlyBin));

      resetPathCache();
      expect(augmentedPath().split(delimiter)).toContain(rcOnlyBin);
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      resetPathCacheForTests();
    }
  });

  it("skips known dirs that do not exist", () => {
    resetPathCacheForTests();
    const parts = augmentedPath().split(delimiter);
    // temp home: .volta was never created, so it must not appear
    expect(parts).not.toContain(join(homedir(), ".volta", "bin"));
  });

  it.skipIf(process.platform !== "win32")("finds Antigravity installed after launch", () => {
    const previous = process.env.LOCALAPPDATA;
    const localAppData = mkdtempSync(join(tmpdir(), "murage-localappdata-"));
    try {
      process.env.LOCALAPPDATA = localAppData;
      const agyBin = join(localAppData, "agy", "bin");
      mkdirSync(agyBin, { recursive: true });
      resetPathCacheForTests();
      expect(augmentedPath().split(delimiter)).toContain(agyBin);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      resetPathCacheForTests();
      rmSync(localAppData, { recursive: true, force: true });
    }
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

describe("resolveCli", () => {
  it.skipIf(process.platform === "win32")("is identity off Windows — the kernel already resolves PATH and #!", () => {
    expect(resolveCli("claude", ["-p", "hi"])).toEqual({ command: "claude", args: ["-p", "hi"] });
  });
});

winOnly("resolveCli (Windows)", () => {
  let dir: string;
  const onPath = () => {
    process.env.MURAGE_EXTRA_PATH = dir;
    resetPathCacheForTests();
  };
  const shimWith = (name: string, body: string, target: string, targetBody: string) => {
    writeFileSync(join(dir, name), body);
    mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "bin", target), targetBody);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murage-shim-"));
  });
  afterEach(async () => {
    delete process.env.MURAGE_EXTRA_PATH;
    resetPathCacheForTests();
    // These tests spawn the shims out of this directory; a just-exited one can
    // still be holding it for a beat after the call returns.
    await removeTempDir(dir);
  });

  it("parses an npm .cmd shim down to the .exe it wraps", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    onPath();
    expect(resolveCli("ombfake", ["-p", "hi"])).toEqual({
      command: join(dir, "node_modules", "pkg", "bin", "ombfake.exe"),
      args: ["-p", "hi"],
    });
  });

  it("parses an npm .cmd shim down to `node <cli.js>`, never the shim's own node.exe", async () => {
    shimWith("ombfake.cmd", JS_SHIM, "ombfake.js", "console.log('js target ' + process.argv.slice(2).join(','));\n");
    onPath();
    const r = resolveCli("ombfake", ["-p", "hi"]);
    expect(r.args).toEqual([join(dir, "node_modules", "pkg", "bin", "ombfake.js"), "-p", "hi"]);
    expect(r.command.toLowerCase()).toMatch(/node\.exe$/);
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("js target -p,hi");
  });

  it("prefers the PATHEXT hit over the extensionless sibling npm installs beside it", () => {
    shimWith("ombfake.cmd", EXE_SHIM, "ombfake.exe", "MZ-not-really");
    writeFileSync(join(dir, "ombfake"), "#!/bin/sh\n# the POSIX shim — unrunnable here\n");
    onPath();
    expect(resolveCli("ombfake", []).command).toBe(join(dir, "node_modules", "pkg", "bin", "ombfake.exe"));
  });

  it("runs a #!node script through node — Windows has no shebang support", async () => {
    const script = join(dir, "ombfake-cli.ts");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log('shebang ' + process.argv.slice(2).join(','));\n");
    const r = resolveCli(script, ["a", "b"]);
    expect(r.command.toLowerCase()).toMatch(/node(\.exe)?$/);
    expect(r.args).toEqual([script, "a", "b"]);

    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(r.command, r.args, (err, out) => (err ? reject(err) : resolve(out))),
    );
    expect(stdout.trim()).toBe("shebang a,b");
  });

  it("never crosses the no-shell boundary for an unparseable shim", () => {
    const shim = join(dir, "ombfake.cmd");
    writeFileSync(shim, "@ECHO OFF\ncustom-launcher %*\n");
    onPath();
    const payload = JSON.stringify({
      mcpServers: {
        muragebox: {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["a b", "%PATH%", "x&y|z", "q^r", "<in>out"],
          env: { TOK: 'he said "hi"' },
        },
      },
    });
    const resolved = resolveCli("ombfake", ["--mcp-config", payload]);
    expect(resolved.command.toLowerCase()).toBe(shim.toLowerCase());
    expect(resolved.args).toEqual(["--mcp-config", payload]);
  });

  it("hands an unknown CLI back untouched so spawn reports its own ENOENT", () => {
    onPath();
    expect(resolveCli("definitely-not-installed", ["-p"])).toEqual({
      command: "definitely-not-installed",
      args: ["-p"],
    });
  });
});

describe("splitCliString", () => {
  it("splits wrapper command + fixed args, honoring quotes", () => {
    expect(splitCliString("/usr/local/bin/ag claude agp")).toEqual(["/usr/local/bin/ag", "claude", "agp"]);
    expect(splitCliString('"/opt/my tools/cli" --flag with space')).toEqual(["/opt/my tools/cli", "--flag", "with", "space"]);
    expect(splitCliString("claude")).toEqual(["claude"]);
    expect(splitCliString("  ")).toEqual([]);
  });

  it("strips quotes from a lone quoted path — the spaced-path case", () => {
    // a user quoting a path with spaces pastes ONE token; the quotes must
    // not survive into the spawn, or every turn dies ENOENT on a filename
    // that literally contains quote characters
    expect(splitCliString('"/opt/my tools/claude"')).toEqual(["/opt/my tools/claude"]);
  });
});

describe("resolveCli with wrapper commands", () => {
  posixIt("puts wrapper subcommands BEFORE invocation args", () => {
    const resolved = resolveCli("/usr/local/bin/ag claude agp", ["--help"]);
    expect(resolved.command).toBe("/usr/local/bin/ag");
    expect(resolved.args).toEqual(["claude", "agp", "--help"]);
  });

  posixIt("strips quotes from a single-token quoted path", () => {
    expect(resolveCli('"/opt/my tools/claude"', ["--help"])).toEqual({
      command: "/opt/my tools/claude",
      args: ["--help"],
    });
  });

  posixIt("keeps an EXISTING unquoted spaced path whole — what the candidates list emits", () => {
    const bin = join(homedir(), ".local", "bin");
    mkdirSync(bin, { recursive: true });
    // simulate "/Applications/My Tools/claude": a real file at a spaced path
    const spacedDir = join(bin, "murage space dir");
    mkdirSync(spacedDir, { recursive: true });
    const spaced = join(spacedDir, "myclaude");
    writeFileSync(spaced, "#!/bin/sh\n");
    expect(resolveCli(spaced, ["--version"])).toEqual({
      command: spaced,
      args: ["--version"],
    });
    // a NONEXISTENT spaced string still splits (wrapper interpretation)
    expect(resolveCli(join(spacedDir, "nope two words"), ["--version"])).toEqual({
      command: join(bin, "murage"),
      args: ["space", "dir/nope", "two", "words", "--version"],
    });
  });
});

// The bundled Fuigo engine. The whole point of shipping it is that a machine
// with no Node, npm or npx still has a working engine — so a missing or
// unrunnable bundle has to be a named error, never a quiet "no engine here".
describe("resolveFuigoCli", () => {
  let bundleDirectory: string;
  let realExistsSync: typeof existsSync;

  beforeEach(async () => {
    bundleDirectory = mkdtempSync(join(tmpdir(), "murage-fuigo-"));
    realExistsSync = (await vi.importActual<typeof import("node:fs")>("node:fs")).existsSync;
    // The temporary home does not isolate inherited PATH or fixed locations
    // such as /usr/local/bin. A developer's installed Fuigo correctly wins in
    // production, but must not satisfy a fixture's "no installed engine" case.
    // Keep real checks for every fixture file, including bundle permissions.
    const roots = [homedir(), bundleDirectory];
    vi.mocked(existsSync).mockImplementation((path) =>
      typeof path === "string" && roots.some((root) => path === root || path.startsWith(root + sep))
        ? realExistsSync(path)
        : false,
    );
    resetPathCacheForTests();
  });

  afterEach(() => {
    vi.mocked(existsSync).mockImplementation(realExistsSync);
    vi.unstubAllEnvs();
    delete process.env.MURAGE_FUIGO_DIR;
    delete process.env.MURAGE_EXTRA_PATH;
    rmSync(bundleDirectory, { recursive: true, force: true });
    // setup.ts points homedir at a temp dir shared by this file, so a
    // user-installed fuigo left behind would make every later case find one.
    rmSync(join(homedir(), ".fuigo"), { recursive: true, force: true });
    resetPathCacheForTests();
  });

  function bundle(mode = 0o755): string {
    const binary = join(bundleDirectory, process.platform === "win32" ? "fuigo.exe" : "fuigo");
    writeFileSync(binary, "#!/bin/sh\necho fuigo 1.0.1\n");
    chmodSync(binary, mode);
    return binary;
  }

  it("points at the executable inside the packaged resource directory", () => {
    expect(bundledFuigoPath({ MURAGE_FUIGO_DIR: "/R/fuigo" }, "darwin")).toBe("/R/fuigo/fuigo");
    expect(bundledFuigoPath({ MURAGE_FUIGO_DIR: "/R/fuigo" }, "win32")).toBe("/R/fuigo/fuigo.exe");
    // Not "empty" — simply undeclared, which resolveFuigoCli turns into an error.
    expect(bundledFuigoPath({}, "darwin")).toBeNull();
    expect(bundledFuigoPath({ MURAGE_FUIGO_DIR: "  " }, "darwin")).toBeNull();
  });

  posixIt("falls back to the bundled engine when the user has no fuigo of their own", () => {
    const binary = bundle();
    process.env.MURAGE_FUIGO_DIR = bundleDirectory;
    resetPathCacheForTests();
    expect(resolveFuigoCli()).toEqual({ command: binary, source: "bundled" });
  });

  posixIt("lets a fuigo the user installed themselves win over the bundled copy", () => {
    bundle();
    process.env.MURAGE_FUIGO_DIR = bundleDirectory;
    // ~/.fuigo/bin is where the npm postinstall puts a user's own engine, and
    // augmentedPath() scans it even under a bare GUI PATH.
    const installed = join(homedir(), ".fuigo", "bin");
    mkdirSync(installed, { recursive: true });
    const own = join(installed, "fuigo");
    writeFileSync(own, "#!/bin/sh\necho fuigo 9.9.9\n");
    chmodSync(own, 0o755);
    resetPathCacheForTests();

    expect(resolveFuigoCli()).toEqual({ command: own, source: "path" });
  });

  it("prefers an inherited PATH install over a known-directory install and the bundle", () => {
    bundle();
    process.env.MURAGE_FUIGO_DIR = bundleDirectory;
    const executable = process.platform === "win32" ? "fuigo.exe" : "fuigo";
    const pathDirectory = join(bundleDirectory, "user-path-bin");
    const knownDirectory = join(homedir(), ".fuigo", "bin");
    for (const directory of [pathDirectory, knownDirectory]) {
      mkdirSync(directory, { recursive: true });
      const binary = join(directory, executable);
      writeFileSync(binary, "fixture engine\n");
      chmodSync(binary, 0o755);
    }
    vi.stubEnv("PATH", pathDirectory);
    resetPathCacheForTests();
    expect(resolveFuigoCli()).toEqual({ command: join(pathDirectory, executable), source: "path" });
  });

  it("names the missing declaration rather than silently reporting no engine", () => {
    delete process.env.MURAGE_FUIGO_DIR;
    process.env.MURAGE_EXTRA_PATH = bundleDirectory; // deliberately empty
    resetPathCacheForTests();
    expect(() => resolveFuigoCli()).toThrow(/MURAGE_FUIGO_DIR is not set/);
  });

  it("names the missing file when the resource directory was declared but never shipped", () => {
    process.env.MURAGE_FUIGO_DIR = join(bundleDirectory, "absent");
    resetPathCacheForTests();
    expect(() => resolveFuigoCli()).toThrow(/bundled engine is missing at/);
  });

  posixIt("names a lost executable bit instead of spawning something that cannot run", () => {
    bundle(0o644);
    process.env.MURAGE_FUIGO_DIR = bundleDirectory;
    resetPathCacheForTests();
    expect(() => resolveFuigoCli()).toThrow(/is not executable/);
  });
});
