// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 Critical: Claude Code 2.1.305 starts every stdio MCP server through CLAUDE_CODE_SHELL_PREFIX (murage-exec) as
// one quoted command string, with the server's mcp.json env on the prefix process. The wrapper's `env -i` dropped that
// env, so ELECTRON_RUN_AS_NODE was lost, the Murage binary started as the app and no MCP server came up. These run the
// REAL wrapper the way the CLI does.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { claudeMcpLaunch } from "../testing/fake-custom-tool.ts";
import { claudeEnvironment, stripClaudeOwnedEnv } from "./claude.ts";
import { EXEC_KEEP, installMurageExec, murageExecPrefix, withExecKeep, writeExecEnvFile } from "./murage-exec.ts";

// A tiny stdio MCP server: answers `initialize` with the variables it was started with, and refuses to answer at all
// without NEEDED (as the Murage binary does not run as a server without ELECTRON_RUN_AS_NODE).
const SERVER = `
const names = ["NEEDED", "ELECTRON_RUN_AS_NODE", "MURAGE_CRED_FILE", "FROM_CLAUDE", "MURAGE_EXEC_KEEP", "MURAGE_EXEC_ENV_FILE", "SHARED"];
if (process.env.NEEDED === undefined) { process.stderr.write("NEEDED is missing\\n"); process.exit(3); }
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const nl = buf.indexOf("\\n");
  if (nl < 0) return;
  const req = JSON.parse(buf.slice(0, nl));
  const env = Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]));
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { serverInfo: { name: "probe" }, env, cwd: process.cwd(), hasPath: !!process.env.PATH } }) + "\\n");
  process.exit(0);
});
`;

// The wrapper is a Bash script. On Windows Claude runs it through Git for Windows' bash (the same MSYS bash the app
// hands CLAUDE_CODE_SHELL), so the suite runs there too when that bash is installed, and says why when it is not.
const WIN = process.platform === "win32";
function findBash(): string | null {
  if (!WIN) return "/bin/bash";
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined];
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, ...roots.map((root) => (root ? join(root, "Git", "bin", "bash.exe") : undefined))];
  return candidates.find((candidate) => !!candidate && existsSync(candidate)) ?? null;
}
const BASH = findBash();
/** Git for Windows' usr\bin (env, printenv, cygpath ...), which the shell's PATH must carry; null off Windows. */
const GIT_USR_BIN = WIN && BASH ? [join(dirname(BASH), "..", "usr", "bin"), dirname(BASH)].find((dir) => existsSync(join(dir, "env.exe"))) ?? null : null;
const PATH_SEP = WIN ? ";" : ":";
/** The PATH a turn (and Claude) has: the host's, with Git's tools in front on Windows. */
const hostPath = (): string => [GIT_USR_BIN, process.env.PATH ?? (WIN ? "" : "/usr/bin:/bin")].filter(Boolean).join(PATH_SEP);
/** Names a Windows process (the Git Bash launcher, node) needs to start at all. */
const winBase = (): Record<string, string> => (WIN ? Object.fromEntries(["SystemRoot", "windir", "TEMP", "TMP", "COMSPEC"].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : []))) : {});
/** A real turn's map always carries HOME, and so does the Claude Code process that runs the wrapper (the outer env). On a macOS runner a Homebrew shim on PATH prints "$HOME must be set to run brew" to stderr when it runs under `env -i` without one. */
const homeBase = (): Record<string, string> => (!WIN && process.env.HOME ? { HOME: process.env.HOME } : {});
const sameDir = (a: string, b: string): boolean => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

describe.skipIf(!BASH)(`murage-exec in front of MCP servers${BASH ? "" : " (skipped: Git for Windows bash not found; set CLAUDE_CODE_GIT_BASH_PATH)"}`, () => {
  let proj: string;
  let wrapper: string;
  let envFile: string;
  beforeEach(() => {
    proj = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-exec-mcp-")));
    wrapper = installMurageExec();
    envFile = writeExecEnvFile(`t-mcp-${process.pid}`, { ...winBase(), ...homeBase(), PATH: hostPath(), SHARED: "turn" }, proj, BASH!);
  });
  afterEach(() => removeTempDirSync(proj));
  // Run the wrapper as Claude's shell does (through bash: a Windows file has no shebang to execute).
  const runWrapper = (command: string, env: Record<string, string>, script = wrapper) => spawnSync(BASH!, [WIN ? script.replace(/\\/g, "/") : script, command], { env: { ...winBase(), ...homeBase(), PATH: hostPath(), MURAGE_EXEC_ENV_FILE: envFile, ...env }, encoding: "utf8" });

  const hostile = `it's "here" $(touch /nonexistent) \`x\`\nsecond line`;

  it("a stdio server started through the prefix sees its own mcp.json env, and nothing else of Claude's", () => {
    const script = join(proj, "server.cjs");
    writeFileSync(script, SERVER);
    const servers = withExecKeep({
      probe: { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_CRED_FILE: join(proj, "cred.json"), NEEDED: hostile, SHARED: "server" } },
      remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer x" } },
      bare: { command: process.execPath, args: [script] },
    }) as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    expect(servers.probe!.env![EXEC_KEEP]).toBe("ELECTRON_RUN_AS_NODE,MURAGE_CRED_FILE,NEEDED,SHARED");
    expect(servers.remote).toEqual({ type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer x" } });
    expect(servers.bare!.env).toBeUndefined();
    // Exactly as Claude Code starts it: `<shell> -c "<prefix> '<command line>'"`, the server's env on that process.
    // On Windows the prefix is spelled with forward slashes (murageExecPrefix) and the server command is a Windows path.
    const asBash = (path: string): string => (WIN ? path.replace(/\\/g, "/") : path);
    const launch = claudeMcpLaunch({ command: asBash(servers.probe!.command), args: servers.probe!.args.map(asBash), env: servers.probe!.env! }, { CLAUDE_CODE_SHELL_PREFIX: murageExecPrefix(), CLAUDE_CODE_SHELL: BASH! });
    expect(launch.command).toBe(BASH);
    const out = spawnSync(launch.command, launch.args, {
      env: { ...winBase(), ...homeBase(), PATH: hostPath(), MURAGE_EXEC_ENV_FILE: envFile, FROM_CLAUDE: "claude's own", ...launch.env },
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      encoding: "utf8",
    });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    const reply = JSON.parse(out.stdout.trim()) as { id: number; result: { env: Record<string, string | null>; cwd: string; hasPath: boolean } };
    expect(reply.id).toBe(1);
    expect(reply.result.env).toEqual({
      NEEDED: hostile, ELECTRON_RUN_AS_NODE: "1", MURAGE_CRED_FILE: join(proj, "cred.json"),
      FROM_CLAUDE: null, MURAGE_EXEC_KEEP: null, MURAGE_EXEC_ENV_FILE: null,
      SHARED: "server", // the server's own value wins over the turn's
    });
    expect(reply.result.hasPath).toBe(true);
    expect(sameDir(reply.result.cwd, proj)).toBe(true);
  });

  it("a Bash command gains no server variable (MURAGE_EXEC_KEEP is never in Claude's own environment)", () => {
    const run = (env: Record<string, string>) => runWrapper('printf "%s|%s|%s|%s|%s" "${ELECTRON_RUN_AS_NODE-gone}" "${NEEDED-gone}" "${MURAGE_EXEC_KEEP-gone}" "${SHARED-gone}" "${MURAGE_EXEC_ENV_FILE-gone}"', env);
    // Claude's own environment can hold anything; a command sees only the turn's map.
    const bash = run({ ELECTRON_RUN_AS_NODE: "1", NEEDED: "x", SHARED: "claude" });
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("gone|gone|gone|turn|gone");
    // A list naming invalid, reserved, unset or the wrapper's own names carries over only valid, set names.
    const listed = run({ NEEDED: "x", [EXEC_KEEP]: "BAD NAME,1X,,murage_exec_kept,MURAGE_EXEC_ENV_FILE,UNSET_ONE,NEEDED,$(touch x)" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("gone|x|gone|turn|gone");
  });

  it("a kept value never appears in any process's arguments (the env it execs is recorded)", () => {
    // Every `env` the wrapper execs is a shim that records its argv, then runs the real one. On Linux/macOS the shim sits
    // first on PATH. MSYS puts its own /usr/bin first whatever the PATH says, so on Windows the shim is named in a copy of
    // the wrapper whose only difference is that the two `exec env -i` call it by path.
    const realEnv = WIN ? "/usr/bin/env" : spawnSync("/bin/sh", ["-c", "command -v env"], { encoding: "utf8" }).stdout.trim();
    expect(realEnv).toMatch(/^\//);
    const bin = join(proj, "bin");
    mkdirSync(bin);
    const log = join(proj, "env-argv.log");
    const shim = join(bin, WIN ? "envshim" : "env");
    const fwd = (path: string): string => path.replace(/\\/g, "/");
    writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${fwd(log)}'; done\nexec '${realEnv}' "$@"\n`);
    chmodSync(shim, 0o755);
    let script = wrapper;
    if (WIN) {
      const source = readFileSync(wrapper, "utf8");
      expect(source.split("exec env -i").length - 1).toBe(2);
      script = join(proj, "murage-exec-shimmed");
      writeFileSync(script, source.split("exec env -i").join(`exec '${fwd(shim)}' -i`));
    }
    const secret = "dummy-secret-4f1c9a";
    const out = spawnSync(BASH!, [fwd(script), 'printf "%s|%s|%s" "${NOTES_TOKEN-gone}" "${SHARED-gone}" "${ELECTRON_RUN_AS_NODE-gone}"'],
      { env: { ...winBase(), ...homeBase(), PATH: WIN ? hostPath() : `${bin}:${hostPath()}`, MURAGE_EXEC_ENV_FILE: envFile, NOTES_TOKEN: secret, SHARED: `server-${secret}`, ELECTRON_RUN_AS_NODE: "1", [EXEC_KEEP]: "NOTES_TOKEN,SHARED,ELECTRON_RUN_AS_NODE" }, encoding: "utf8" });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`${secret}|server-${secret}|1`);
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain("-i");
    expect(argv).not.toContain(secret);
    expect(argv).not.toContain("ELECTRON_RUN_AS_NODE=");
    // the turn's own names do not ride on that command line either
    expect(argv).not.toContain("SHARED=");
    expect(argv).not.toContain("PATH=");
  });

  it("MURAGE_EXEC_KEEP is read whole, and only names that came in the environment are carried", () => {
    const shown = 'for n in NEEDED LATE UID BASH_VERSION EUID BAD; do printf "%s=%s|" "$n" "$(printenv "$n" || echo gone)"; done';
    const run = (keep: string) => runWrapper(shown, { NEEDED: "x", LATE: "y", BAD: "z", [EXEC_KEEP]: keep });
    // a name with a newline in it is not a name: neither NEEDED nor BAD rides on it; what follows the newline is still read
    const lines = run("UID,BASH_VERSION,EUID,NEEDED\nBAD,LATE");
    expect(lines.status).toBe(0);
    expect(lines.stdout).toBe("NEEDED=gone|LATE=y|UID=gone|BASH_VERSION=gone|EUID=gone|BAD=gone|");
    // Bash's own variables are never carried, even alone in the list
    const own = run("UID,BASH_VERSION,EUID,SHLVL,PPID");
    expect(own.status).toBe(0);
    expect(own.stdout).toBe("NEEDED=gone|LATE=gone|UID=gone|BASH_VERSION=gone|EUID=gone|BAD=gone|");
  });
});

describe("Claude Code session names never reach an engine", () => {
  const session = {
    CLAUDECODE: "1", AI_AGENT: "claude-code", CLAUDE_PID: "4242", CLAUDE_EFFORT: "high",
    CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s-1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_EXECPATH: "/opt/claude", CLAUDE_CODE_SSE_PORT: "5555", CLAUDE_CODE_PLUGIN_DIRS: "/tmp/plugins", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock", CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    // a remote session's credential carriers
    CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/tmp/ingress-token", CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: "5", CLAUDE_CODE_REMOTE_SESSION_ID: "r-1",
  };
  const kept = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe",
    // owner-exported login and gateway settings: every other CLAUDE_CODE_* name survives
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1", CLAUDE_CODE_SKIP_VERTEX_AUTH: "1", CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
    CLAUDE_CODE_CLIENT_CERT: "/etc/c.pem", CLAUDE_CODE_CLIENT_KEY: "/etc/k.pem", CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "pp",
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "60000", CLAUDE_CODE_EXTRA_BODY: "{\"a\":1}",
  };

  it("claudeEnvironment drops an inherited Claude Code session", () => {
    const env = claudeEnvironment(undefined, { PATH: "/usr/bin:/bin", HOME: "/home/x", ...session, ...kept, claude_code_session_id: "lower" });
    for (const name of [...Object.keys(session), "claude_code_session_id"]) expect(env[name], name).toBeUndefined();
    expect(env).toMatchObject(kept);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("stripClaudeOwnedEnv drops them from the captured shell map", () => {
    const map: Record<string, string | undefined> = { PATH: "/usr/bin", ...session, ...kept };
    stripClaudeOwnedEnv(map);
    for (const name of Object.keys(session)) expect(map[name], name).toBeUndefined();
    expect(map).toMatchObject(kept);
  });
});

// U20 (1.0.4): the wrapper's Windows (Git Bash) branch, where the turn file holds Windows spellings that cygpath turns into
// MSYS ones, run on every OS: `uname` and `cygpath` are stand-ins first on the wrapper's PATH (spelling "W:<posix path>" for a
// Windows path, ";" between search-path entries). The real Git Bash run is the suite above on a Windows runner.
describe.skipIf(WIN)("murage-exec Git Bash branch (MSYS spellings, simulated)", () => {
  let proj: string;
  let bin: string;
  beforeEach(() => {
    proj = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-exec-msys-")));
    bin = join(proj, "fakebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-20348\n");
    // cygpath -u X | cygpath -u -p LIST: drop the W: marker; a list's ";" becomes ":"
    writeFileSync(join(bin, "cygpath"), `#!/bin/sh\nlast=""; list=0\nfor a in "$@"; do case "$a" in -p) list=1 ;; -*) ;; *) last="$a" ;; esac; done\nif [ $list = 1 ]; then printf '%s\\n' "$last" | sed 's/;/:/g; s/W://g'; else printf '%s\\n' "$last" | sed 's/^W://'; fi\n`);
    chmodSync(join(bin, "uname"), 0o755);
    chmodSync(join(bin, "cygpath"), 0o755);
  });
  afterEach(() => removeTempDirSync(proj));

  it("an MCP server started through the prefix gets its own env, the MSYS directory and the MSYS search path", () => {
    const script = join(proj, "server.cjs");
    writeFileSync(script, SERVER);
    const hostDirs = (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean);
    const winPath = [bin, ...hostDirs].map((dir) => `W:${dir}`).join(";");
    const envFile = writeExecEnvFile(`t-msys-${process.pid}`, { ...homeBase(), PATH: winPath, SHARED: "turn" }, `W:${proj}`, "W:/bin/bash");
    const servers = withExecKeep({ probe: { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1", NEEDED: "msys", SHARED: "server" } } }) as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    const launch = claudeMcpLaunch(servers.probe!, { CLAUDE_CODE_SHELL_PREFIX: murageExecPrefix(), CLAUDE_CODE_SHELL: "/bin/bash" });
    const out = spawnSync(launch.command, launch.args, {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MURAGE_EXEC_ENV_FILE: envFile, ...launch.env },
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      encoding: "utf8",
    });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    const reply = JSON.parse(out.stdout.trim()) as { result: { env: Record<string, string | null>; cwd: string; hasPath: boolean } };
    expect(reply.result.env).toMatchObject({ NEEDED: "msys", ELECTRON_RUN_AS_NODE: "1", SHARED: "server", MURAGE_EXEC_KEEP: null, MURAGE_EXEC_ENV_FILE: null });
    expect(sameDir(reply.result.cwd, proj)).toBe(true);
    // a Bash command through the same file sees the converted search path, in MSYS form
    const bash = spawnSync("/bin/bash", [installMurageExec(), 'printf "%s|%s" "$PATH" "$PWD"'], { env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, MURAGE_EXEC_ENV_FILE: envFile }, encoding: "utf8" });
    expect(bash.stderr).toBe("");
    expect(bash.stdout).toBe(`${[bin, ...hostDirs].join(":")}|${proj}`);
  });

  it("a Windows file with no cygpath on the wrapper's PATH stops with the reason, running nothing", () => {
    writeFileSync(join(bin, "cygpath"), "");
    rmSync(join(bin, "cygpath"));
    const envFile = writeExecEnvFile(`t-msys-nocyg-${process.pid}`, { PATH: "W:/usr/bin" }, `W:${proj}`, "W:/bin/bash");
    const out = spawnSync("/bin/bash", [installMurageExec(), "touch ran"], { env: { PATH: `${bin}:/usr/bin:/bin`, MURAGE_EXEC_ENV_FILE: envFile }, encoding: "utf8", cwd: proj });
    expect(out.status).toBe(126);
    expect(out.stderr).toContain("cygpath is not available");
    expect(existsSync(join(proj, "ran"))).toBe(false);
  });
});
