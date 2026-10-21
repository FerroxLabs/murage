// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 Critical: Claude Code 2.1.305 starts every stdio MCP server through CLAUDE_CODE_SHELL_PREFIX (murage-exec) as
// one quoted command string, with the server's mcp.json env on the prefix process. The wrapper's `env -i` dropped that
// env, so ELECTRON_RUN_AS_NODE was lost, the Murage binary started as the app and no MCP server came up. These run the
// REAL wrapper the way the CLI does.

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { claudeMcpLaunch } from "../testing/fake-custom-tool.ts";
import { claudeEnvironment, stripClaudeOwnedEnv } from "./claude.ts";
import { EXEC_KEEP, installMurageExec, withExecKeep, writeExecEnvFile } from "./murage-exec.ts";

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

describe.skipIf(process.platform === "win32")("murage-exec in front of MCP servers", () => {
  let proj: string;
  let wrapper: string;
  let envFile: string;
  beforeEach(() => {
    proj = realpathSync(mkdtempSync(join(tmpdir(), "murage-exec-mcp-")));
    wrapper = installMurageExec();
    envFile = writeExecEnvFile(`t-mcp-${process.pid}`, { PATH: process.env.PATH ?? "/usr/bin:/bin", SHARED: "turn" }, proj, "/bin/bash");
  });
  afterEach(() => removeTempDirSync(proj));

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
    const launch = claudeMcpLaunch({ command: servers.probe!.command, args: servers.probe!.args, env: servers.probe!.env! }, { CLAUDE_CODE_SHELL_PREFIX: wrapper, CLAUDE_CODE_SHELL: "/bin/bash" });
    expect(launch.command).toBe("/bin/bash");
    const out = spawnSync(launch.command, launch.args, {
      env: { PATH: process.env.PATH, MURAGE_EXEC_ENV_FILE: envFile, FROM_CLAUDE: "claude's own", ...launch.env },
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
    expect(reply.result.cwd).toBe(proj);
  });

  it("a Bash command gains no server variable (MURAGE_EXEC_KEEP is never in Claude's own environment)", () => {
    const run = (env: Record<string, string>) => spawnSync(wrapper, ['printf "%s|%s|%s|%s|%s" "${ELECTRON_RUN_AS_NODE-gone}" "${NEEDED-gone}" "${MURAGE_EXEC_KEEP-gone}" "${SHARED-gone}" "${MURAGE_EXEC_ENV_FILE-gone}"'],
      { env: { MURAGE_EXEC_ENV_FILE: envFile, ...env }, encoding: "utf8" });
    // Claude's own environment can hold anything; a command sees only the turn's map.
    const bash = run({ ELECTRON_RUN_AS_NODE: "1", NEEDED: "x", SHARED: "claude" });
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("gone|gone|gone|turn|gone");
    // A list naming invalid, reserved, unset or the wrapper's own names carries over only valid, set names.
    const listed = run({ NEEDED: "x", [EXEC_KEEP]: "BAD NAME,1X,,murage_exec_kept,MURAGE_EXEC_ENV_FILE,UNSET_ONE,NEEDED,$(touch x)" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("gone|x|gone|turn|gone");
  });
});

describe("Claude Code session names never reach an engine", () => {
  const session = {
    CLAUDECODE: "1", AI_AGENT: "claude-code", CLAUDE_PID: "4242", CLAUDE_EFFORT: "high",
    CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s-1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_EXECPATH: "/opt/claude", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock", CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  };
  const kept = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe" };

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
