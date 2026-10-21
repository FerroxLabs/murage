// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (e)+(h) (a) of APP-GRANT-FIXPLAN-r6 (Rule 74c launch clause), structurally: every engine launch and every
// auxiliary engine probe goes through the shared launcher in procs.ts. Under server/ (tests and test support excluded)
// the process launchers of node:child_process are taken only by procs.ts and the allowlist below, each entry with its
// reason; spawnCli and execCli start a new session on posix (detached) and a hidden console on win32 (windowsHide, never
// detached), with stdin a pipe.
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ spawn: [] as unknown[][], execFile: [] as unknown[][] }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), { pid: 0x7fff_fff0, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    return child;
  };
  return {
    ...real,
    spawn: (...args: unknown[]) => { calls.spawn.push(args); return fakeChild(); },
    execFile: (...args: unknown[]) => { calls.execFile.push(args); return fakeChild(); },
  };
});
vi.mock("./env-path.ts", async (original) => ({
  ...(await original<typeof import("./env-path.ts")>()),
  resolveCliSpawn: (command: string, args: string[]) => ({ command, args }),
}));

const { execCli, spawnCli } = await import("./procs.ts");

const server = dirname(fileURLToPath(import.meta.url));

/** Modules that may start a process themselves, and why they are not an engine launch or an engine probe. */
const ALLOWLIST: Record<string, string> = {
  "procs.ts": "the shared launcher itself (spawnCli, execCli) and its taskkill stop route",
  "env-path.ts": "the owner's own login capture (Rule 74a, Murage's process, stdin closed); its Fuigo --version read is an engine probe and starts a session of its own (asserted below)",
  "drivers/process-tree.ts": "non-engine helper: ps and PowerShell process listing",
  "drivers/process-identity.ts": "non-engine helper: ps start-time read of a known pid",
  "drivers/warm-pool.ts": "non-engine helper: ps and vm_stat memory reads",
  "drivers/claude.ts": "git rev-parse of the session folder with stdin ignored and no network",
  "drivers/pi-mcp-extension.ts": "runs inside the Pi process and inherits its session",
  "drivers/headless-browser-proxy.ts": "the browser automation tool server Murage starts, not an engine",
  "drivers/phone-proxy.ts": "adb for the phone tool, not an engine",
  "browser-engine.ts": "the browser binary Murage starts for its browser tool, not an engine",
  "browser-native-relay.ts": "the browser native relay helper and its PowerShell cleanup, not an engine",
  "browser-macos-identity.ts": "codesign verification of a browser binary",
  "browser-sandbox.ts": "icacls ACL read and grant on the bundled browser folder, and the Linux Chrome sandbox check (one headless run of the bundled browser)",
  "mcp-bridge.ts": "the owner's MCP servers Murage hosts for its own tools, not an engine",
  "checkpoints.ts": "Murage's own checkpoint git repository",
  "engine-fs.ts": "Windows registry read of cloud sync roots",
  "protected-folders.ts": "Windows registry and xdg folder lookups",
  "engine-management.ts": "package manager install and update of an engine package, not an engine run",
  "fuigo-probe-isolation.ts": "sandbox helper setup and cleanup for the Fuigo update check",
  "gepa-worker.ts": "the GEPA Python worker, not an engine",
  "installation-backup-encryption.ts": "backup encryption tool with an empty PATH",
  "installation-encrypted-backup.ts": "backup encryption tool",
  "installation-archive.ts": "archive flush tool with an empty env",
  "backup-restic.ts": "restic for backups",
  "backup-sftp.ts": "ssh and sftp for backups with Murage's own ssh environment",
  "vps-computer.ts": "ssh tunnel to the owner's VPS computer, Murage's own connection",
  // Cloud home (int/1.0.3): engine turns there go through spawnCli and cloudTurnLaunch (the sudo turn launcher, in a session of
  // its own); these are the home's own control processes, never an engine run.
  "cloud-home/b1b-recovery.ts": "the sudo turn launcher's sign-in wipe request (no engine runs), stdio ignored but the request pipe",
  "cloud-home/bot-state.ts": "the sudo turn launcher's bot-state request (no engine runs), fixed PATH",
  "cloud-home/browser-process.ts": "the sudo turn launcher's browser start and cleanup requests for the browser tool, not an engine",
  "cloud-home/cloud-process-hooks.ts": "systemctl show of a turn's scope unit, not an engine",
  "cloud-home/control-state.ts": "the home's clock helper with an empty env and stdin ignored",
  "cloud-home/engine-launch-fixture.ts": "test fixture for the launcher suites that drives the launcher Python, never imported by the server",
  "cloud-home/own-server.ts": "Murage's own commands on the owner's own server, not an engine",
  "cloud-home/supervisor.ts": "the Cloud supervisor starting Murage's own server process",
  "cloud-home/vps-mcp-relay.ts": "the relay to the owner's VPS computer, Murage's own connection",
  "container-computer.ts": "docker for the container computer",
  "tts/system-voices.ts": "system voice listing",
  "drivers/win-process-table.ts": "System32 tasklist.exe read of the Windows process table (no PowerShell)",
  "memory/pip-reaper.ts": "PIP process reaper listing",
  "memory/pip-transport.ts": "macOS defaults read of a managed setting",
  "memory/worker-controller.ts": "fork of Murage's own memory worker",
  "channels/whatsapp/bridge-host.ts": "fork of Murage's own WhatsApp bridge",
};

/** Files that must reach a process only through spawnCli or execCli (the inventory's raw spawns, moved). */
const MOVED = ["drivers/acp/hermes.ts", "drivers/headless-target-guard.ts", "engine-env.ts", "fuigo-native-update.ts"];
const LAUNCHERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const MODULE = /^(node:)?child_process$/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "testing") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name) && !/\.(fixture\.ts|bench\.mjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** Each way a module takes a process launcher from node:child_process: a named value import, a default or namespace
 *  import, or a require or dynamic import of the module. */
function launcherUses(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && MODULE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) found.push(`default import ${clause.name.text}`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) found.push(`namespace import ${bindings.name.text}`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && LAUNCHERS.has(name)) found.push(name);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!) && MODULE.test((node.arguments[0] as ts.StringLiteral).text)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) found.push("dynamic import");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("engine processes have no controlling terminal (Rule 74c launch clause)", () => {
  it("takes a process launcher from node:child_process only in procs.ts and the allowlist", () => {
    const strays: string[] = [];
    const seen = new Set<string>();
    for (const file of sources(server)) {
      const uses = launcherUses(file);
      if (uses.length === 0) continue;
      const name = relative(server, file).split("\\").join("/");
      seen.add(name);
      if (!(name in ALLOWLIST)) strays.push(`${name}: ${uses.join(", ")}`);
    }
    expect(strays).toEqual([]);
    for (const name of MOVED) expect(seen.has(name), name).toBe(false);
    // every allowlist entry is live and carries its reason
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(seen.has(name), `${name} is allowlisted but takes no launcher`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("the moved probes run through the shared launcher", () => {
    const read = (name: string) => readFileSync(join(server, name), "utf8");
    expect(read("drivers/acp/hermes.ts")).toMatch(/spawnCli\(cli, \["-p", profile, "acp"\]/);
    expect(read("drivers/acp/hermes.ts")).toMatch(/quietChildPipes\(child\)/);
    expect(read("drivers/headless-target-guard.ts")).toMatch(/spawnCli\(spec\.command, \["--session"/);
    expect(read("engine-env.ts")).toMatch(/execCli\(program, \[\.\.\.args, "env -0; printf/);
    // the Fuigo update check runs the candidate engine: its --version read and its stdio session go through the launcher
    expect(read("fuigo-native-update.ts")).toMatch(/execCliAsync\(command, \[\.\.\.prefix, "--version"\]/);
    expect(read("fuigo-native-update.ts")).toMatch(/spawnCli\(command, \[\.\.\.prefix, "--permission-mode"/);
  });

  it("the Fuigo --version read in the resolver starts a session of its own on posix, a hidden console on win32", () => {
    const text = readFileSync(join(server, "env-path.ts"), "utf8");
    const call = /spawnSync\(absolute, \["--version"\], \{([\s\S]*?)\}\);/.exec(text);
    expect(call, "the Fuigo --version spawnSync").not.toBeNull();
    expect(call![1]).toMatch(/windowsHide: true/);
    expect(call![1]).toMatch(/\.\.\.\(process\.platform === "win32" \? \{\} : \{ detached: true \}\)/);
    expect(call![1]).toMatch(/stdio: \["pipe", "pipe", "pipe"\]/);
    // it is the only launcher env-path.ts runs besides the owner's login capture
    expect(text.match(/\bspawnSync\(/g)).toHaveLength(1);
  });

  describe("launch options per platform (stubbed spawn and execFile)", () => {
    const realPlatform = process.platform;
    const onPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: platform, configurable: true });
    afterEach(() => {
      onPlatform(realPlatform);
      calls.spawn.length = 0;
      calls.execFile.length = 0;
    });
    const spawnOptions = () => calls.spawn.at(-1)![2] as Record<string, unknown>;
    // execCli runs on spawn: execFile drops `detached`, so it cannot start a new session
    const execOptions = () => { expect(calls.execFile).toHaveLength(0); return calls.spawn.at(-1)![2] as Record<string, unknown>; };

    for (const platform of ["linux", "darwin"] as const) {
      it(`${platform}: spawnCli starts a new session with stdin a pipe`, () => {
        onPlatform(platform);
        spawnCli("engine", ["--x"], { stdio: ["pipe", "pipe", "pipe"], env: {} });
        expect(spawnOptions()).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
      });
      it(`${platform}: spawnCli never hands stdin on, even when asked to inherit or ignore it`, () => {
        onPlatform(platform);
        spawnCli("engine", [], { stdio: ["inherit", "inherit", "ignore"], env: {} });
        expect(spawnOptions()).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "ignore"] });
        spawnCli("engine", [], { stdio: "inherit", env: {} });
        expect(spawnOptions()).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
        spawnCli("engine", [], { env: {} });
        expect(spawnOptions()).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
      });
      it(`${platform}: execCli starts a new session with all stdio piped`, () => {
        onPlatform(platform);
        execCli("engine", ["--version"], { timeout: 1000, env: {} }, () => {});
        expect(execOptions()).toMatchObject({ detached: true, stdio: ["pipe", "pipe", "pipe"] });
      });
    }

    it("win32: spawnCli hides its console, all stdio piped, never detached", () => {
      onPlatform("win32");
      spawnCli("engine", ["--x"], { stdio: ["pipe", "pipe", "pipe"], env: {}, detached: true });
      expect(spawnOptions()).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      expect(spawnOptions().detached).toBeUndefined();
      spawnCli("engine", [], { stdio: ["inherit", "inherit", "inherit"], env: {} });
      expect(spawnOptions()).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      expect(spawnOptions().detached).toBeUndefined();
    });

    it("win32: execCli hides its console and is never detached", () => {
      onPlatform("win32");
      execCli("engine", ["--version"], { timeout: 1000, env: {} }, () => {});
      expect(execOptions()).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      expect(execOptions().detached).toBeUndefined();
    });
  });
});
