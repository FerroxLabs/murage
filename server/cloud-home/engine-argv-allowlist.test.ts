// SPDX-License-Identifier: AGPL-3.0-or-later
// Each Cloud engine's argv is a string the launcher accepted against that engine's
// grammar (lanes/release103/CLOUD-ENGINES-DESIGN.md section 4, tests 6, 7 and 8). Astra
// r4 H1 was `opencode mcp list` against a request-authored config; an unlisted flag,
// subcommand, key or value shape now refuses the whole turn, naming only the flag.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_RENDER_MCP, CLOUD_RENDER_SYSTEM_PROMPT } from "./turn-process.ts";
import { MINIMAL_ARGV, launcherRig, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-argv-"); });
afterEach(() => rig.dispose());
const unit = "murage-turn-0123456789abcdef.scope";
const SESSION = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const CLAUDE_BASE = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits"];
const plugins = 'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }';

// The full argv each driver can emit on a home today, every optional flag included.
const FULL: Record<string, { args: string[]; render?: Record<string, unknown> }> = {
  claudeAgent: { args: [...CLAUDE_BASE, "--add-dir", "@WS@", "--tools", "Bash,Read,Edit", "--disallowedTools", "ListAgents,SendMessage", "--model", "claude-sonnet-5", "--effort", "high",
    "--permission-prompt-tool", "mcp__muragebox__approve", "--mcp-config", CLOUD_RENDER_MCP, "--allowedTools", "mcp__composio,mcp__murage-memory,mcp__muragebox",
    "--append-system-prompt-file", CLOUD_RENDER_SYSTEM_PROMPT, "--strict-mcp-config", "--resume", SESSION],
    render: { mcp: { muragebox: { proxy: "permission", socket: "/data/broker/perm-abcd1234.sock" } }, systemPrompt: "You are a bot.\n" } },
  codex: { args: ["app-server", "-c", "model_context_window=129024", "-c", "features.browser_use=false", "-c", "features.browser_use_external=false", "-c", "features.computer_use=false",
    "-c", plugins, "-c", "features.memories=false", "-c", "features.shell_tool=false", "-c", "features.apps=false", "-c", 'web_search="disabled"'] },
  grokAgent: { args: ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "-m", "murage_0123456789abcdef01234567", "--reasoning-effort", "high", "stdio"] },
  kimiAgent: { args: ["-m", "kimi-code/kimi-for-coding", "acp"] },
  opencodeGo: { args: ["acp"] },
  fuigoAgent: { args: ["--permission-mode", "default", "--trust", "--no-memory", "agent", "--no-leader", "-m", "murage_selected", "--reasoning-effort", "medium", "stdio"] },
};
function full(engine: string) {
  const entry = FULL[engine];
  return rig.request(engine, { unit, args: entry.args.map(a => a === "@WS@" ? `${rig.workspaces}/ws/proj` : a), ...(entry.render ? { render: entry.render } : {}) });
}

describe.each(Object.keys(FULL))("%s", engine => {
  it("accepts the exact argv the driver emits, smallest and fullest", () => {
    expect(rig.plan(rig.request(engine)).ok?.args).toEqual(MINIMAL_ARGV[engine as keyof typeof MINIMAL_ARGV]);
    const result = rig.plan(full(engine));
    expect(result.error).toBeUndefined();
    expect(result.ok!.args.length).toBe(FULL[engine].args.length);
  });
});

it("substitutes the render placeholders with the turn's own render files", () => {
  const args = rig.plan(full("claudeAgent")).ok!.args;
  expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/murage-render-0123456789abcdef/mcp.json");
  expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/tmp/murage-render-0123456789abcdef/prompt.txt");
});

it("refuses a written-out path under a render flag and a placeholder with no render part", () => {
  const refuse = (args: string[], render?: Record<string, unknown>) => rig.plan(rig.request("claudeAgent", { unit, args: [...MINIMAL_ARGV.claudeAgent, ...args], ...(render ? { render } : {}) })).error;
  expect(refuse(["--mcp-config", "/tmp/murage-render-0123456789abcdef/mcp.json"], { mcp: { muragebox: { proxy: "permission", socket: "/data/broker/perm-abcd1234.sock" } } })).toBe("Cloud engine argument is not allowed: --mcp-config");
  expect(refuse(["--mcp-config", CLOUD_RENDER_MCP])).toBe("Cloud engine argument is not allowed: --mcp-config");
  expect(refuse(["--append-system-prompt-file", CLOUD_RENDER_SYSTEM_PROMPT])).toBe("Cloud engine argument is not allowed: --append-system-prompt-file");
  expect(refuse(["--append-system-prompt-file", "/tmp/x/prompt.txt"], { systemPrompt: "x" })).toBe("Cloud engine argument is not allowed: --append-system-prompt-file");
});

const SECRET_VALUE = "sk-fixture-never-printed";
it.each([
  ["opencodeGo", ["mcp", "list"], "unexpected token"],
  ["opencodeGo", ["acp", "--port", "1"], "--port"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--mcp-config", "/x"], "--mcp-config"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--settings", SECRET_VALUE], "--settings"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--plugin-dir", "/fixture/plugins"], "--plugin-dir"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--", "x"], "--"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--model", "/fixture/model"], "--model"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--model", SECRET_VALUE + "/../x"], "--model"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--add-dir", "/etc"], "--add-dir"],
  ["claudeAgent", MINIMAL_ARGV.claudeAgent.filter(a => a !== "--strict-mcp-config"), "missing --strict-mcp-config"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--permission-mode", "default"], "repeated --permission-mode"],
  ["claudeAgent", [...MINIMAL_ARGV.claudeAgent, "--unknown-flag"], "--unknown-flag"],
  ["claudeAgent", MINIMAL_ARGV.claudeAgent.map(a => a === "--verbose" ? "--verbose=1" : a), "--verbose"],
  ["codex", ["app-server", "-c", "mcp_servers.x.command=\"/bin/sh\""], "-c"],
  ["codex", ["app-server", "-c", "model_providers.x.base_url=\"https://evil.example\""], "-c"],
  ["codex", ["app-server", "-c", "model_provider=\"x\""], "-c"],
  ["codex", ["app-server", "-c", "features.shell_tool=true"], "-c"],
  // 1.0.4 audit 11-4: the memories override is accepted with its exact value only, and no other features.* key rides with it.
  ["codex", ["app-server", "-c", "features.memories=true"], "-c"],
  ["codex", ["app-server", "-c", "features.memories=false ", "-c", "features.memories=false"], "-c"],
  ["codex", ["app-server", "-c", "features.memory=false"], "-c"],
  ["codex", ["app-server", "-c", "features.telepathy=false"], "-c"],
  ["codex", ["app-server", "-c", "features.memories"], "-c"],
  ["grokAgent", ["--permission-mode", "default", "--no-memory=1", "agent", "--no-leader", "stdio"], "--no-memory"],
  ["grokAgent", ["--permission-mode", "default", "--no-memory", "--memory", "agent", "--no-leader", "stdio"], "--memory"],
  ["codex", ["-c", "features.apps=false", "app-server"], "missing app-server"],
  ["codex", ["exec", "x"], "missing app-server"],
  ["grokAgent", ["--permission-mode", "default", "stdio", "agent"], "unexpected token"],
  ["grokAgent", ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio", "-m", "grok-4"], "missing stdio last"],
  ["grokAgent", ["agent", "stdio"], "missing --permission-mode"],
  ["kimiAgent", ["-m", "/fixture/model", "acp"], "-m"],
  ["kimiAgent", ["acp", "-m", "kimi"], "missing acp last"],
  ["fuigoAgent", ["--permission-mode", "default", "agent", "--no-leader", "stdio"], "missing --no-memory"],
  ["fuigoAgent", ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "--trust=1", "stdio"], "--trust"],
  // Grok and Fuigo run `--permission-mode default` at every level: under any other mode the engine never asks Murage.
  ["grokAgent", ["--permission-mode", "bypassPermissions", "--no-memory", "agent", "--no-leader", "stdio"], "--permission-mode"],
  ["grokAgent", ["--permission-mode", "acceptEdits", "--no-memory", "agent", "--no-leader", "stdio"], "--permission-mode"],
  ["fuigoAgent", ["--permission-mode", "bypassPermissions", "--no-memory", "agent", "--no-leader", "stdio"], "--permission-mode"],
  ["fuigoAgent", ["--permission-mode", "plan", "--no-memory", "agent", "--no-leader", "stdio"], "--permission-mode"],
])("refuses %s argv %j naming only the flag", (engine, args, named) => {
  const result = rig.plan(rig.request(engine, { args }));
  expect(result.error).toBe(`Cloud engine argument is not allowed: ${named}`);
  expect(result.error).not.toContain(SECRET_VALUE);
});

it("refuses argv over the token and byte limits (r3 Low)", () => {
  const many = [...MINIMAL_ARGV.claudeAgent, ...Array.from({ length: 30 }, () => ["--tools", "Read"]).flat()];
  expect(rig.plan(rig.request("claudeAgent", { args: many })).error).toBe("Cloud engine arguments exceed their token limit");
  const big = [...MINIMAL_ARGV.claudeAgent, "--tools", "A".repeat(4000), "--allowedTools", "A".repeat(4000), "--disallowedTools", "A".repeat(4000)];
  expect(rig.plan(rig.request("claudeAgent", { args: [...big, ...big.slice(-6), ...big.slice(-6), ...big.slice(-6), ...big.slice(-6), ...big.slice(-6)] })).error).toMatch(/exceed their (size|token) limit/u);
});

it.each([
  ["claudeAgent", ["--version"]], ["claudeAgent", ["auth", "status", "--json"]], ["codex", ["--version"]], ["codex", ["login", "status"]], ["grokAgent", ["--version"]], ["kimiAgent", ["--version"]],
  ["opencodeGo", ["models"]], ["opencodeGo", ["models", "--verbose"]], ["fuigoAgent", ["models"]], ["fuigoAgent", ["--version"]],
])("accepts the server's %s probe %j as a whole argv", (engine, args) => {
  expect(rig.plan(rig.request(engine, { args })).ok?.args).toEqual(args);
});
it("refuses a probe argv with anything appended", () => {
  expect(rig.plan(rig.request("opencodeGo", { args: ["models", "--verbose", "--print-logs"] })).error).toBe("Cloud engine argument is not allowed: unexpected token");
  expect(rig.plan(rig.request("codex", { args: ["login", "--with-api-key"] })).error).toBe("Cloud engine argument is not allowed: missing app-server");
});
it("accepts Claude's one-shot review form on a home and nothing looser", () => {
  const review = ["-p", "--model", "claude-haiku-4-5", "--output-format", "text", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
  expect(rig.plan(rig.request("claudeAgent", { args: review })).ok?.args).toEqual(review);
  expect(rig.plan(rig.request("claudeAgent", { args: [...review, "--settings", '{"disableAllHooks":true}'] })).error).toBe("Cloud engine argument is not allowed: --output-format");
  expect(rig.plan(rig.request("claudeAgent", { args: review.filter(a => a !== "--strict-mcp-config") })).error).toBeDefined();
});
it("accepts a login only as the exact LOGIN_COMMANDS argv", () => {
  const login = (args: string[]) => rig.plan({ engine: "codex", command: rig.command, args, cwd: rig.home("codex"), env: {} }, { login: true });
  expect(login(["login", "--device-auth"]).ok?.args).toEqual(["login", "--device-auth"]);
  // r9 "logout": no logout runs a CLI, so a logout argv is no longer a login command.
  expect(login(["logout"]).error).toBe("Cloud engine argument is not allowed: login command");
  expect(login(["login"]).error).toBe("Cloud engine argument is not allowed: login command");
  expect(login(["app-server"]).error).toBe("Cloud engine argument is not allowed: login command");
});

it("fails the launcher at load when a grammar shape accepts a path or a flag is listed twice (test 8)", () => {
  const out = JSON.parse(rig.py(`
def refused(rules):
    try: m.check_argv_rules(rules); return False
    except ValueError: return True
loose = m.Shape("loose", lambda value, render: True)
print(json.dumps({
  "path": refused({"x": m.ArgvRule({"--model": loose})}),
  "twice": refused({"x": m.ArgvRule({"agent": None}, literals=("agent",))}),
  "workspace": refused({"x": m.ArgvRule({"--add-dir": m.WORKSPACE_DIR})}),
  "real": refused(None),
  "model": [m.model_id(v) for v in ["/model", ":model", "../model", ".model", "a/../b", "claude-sonnet-5", "kimi-code/kimi-for-coding", "murage_0123", "qwen2.5-coder:7b"]],
}))`));
  expect(out).toEqual({ path: true, twice: true, workspace: false, real: false, model: [false, false, false, false, false, true, true, true, true] });
});

it("accepts the Codex memories-off override and Grok's --no-memory exactly as the drivers emit them (1.0.4 audit 11-4)", () => {
  const codex = ["app-server", "-c", "features.memories=false"];
  expect(rig.plan(rig.request("codex", { args: codex })).ok?.args).toEqual(codex);
  const grok = ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio"];
  expect(rig.plan(rig.request("grokAgent", { args: grok })).ok?.args).toEqual(grok);
});
