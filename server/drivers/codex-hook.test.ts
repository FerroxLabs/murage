// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Codex PreToolUse gate, Rules 67 and 68 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): T91 (the per-version policy),
// T100 a..g on the pieces, T86 and T103 for Codex deliveries. The driver-level half runs in codex.test.ts against the fake app-server.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_FLOORS, CODEX_GATE_MIN, CODEX_HOOK_SCRIPT, CODEX_LOCAL_ORDINARY, CODEX_SHELL_FORM_FEATURES, CODEX_UNTRUSTED_RETIRED_MIN,
  CODEX_HOOK_LAUNCH_ENV, CodexHookGate, HOOK_ASK_BOUND_MS, HOOK_SCRIPT_DEADLINE_MS, HOOK_TIMEOUT_SEC, HookDecisionTable, codexGatePlan, codexHooksJson, codexShellFormArgs,
  codexHookWindowsCommand, hookConfigOf, hookLaunchLine, hookSocketPath, hookWindowsLaunchValue, windowsCmdPath, parseApplyPatch, routeDelivery, stripOwnerHooks, tripwireLine, trustHooks, writeHookFiles,
  type HookAnswer, type HookDelivery, type RouteContext,
} from "./codex-hook.ts";
import { codexTurnPolicy } from "./codex-isolation.ts";
import { OWN_UNASKED } from "../../shared/own-servers.ts";
import { ABSENT_PINS } from "../../shared/arg-vocabulary.ts";
import { removeTempDir } from "../testing/cleanup.ts";

let dir: string;
let project: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-codex-hook-"))); // Windows CI: the long name of RUNNER~1, as the gate reads it
  project = join(dir, "project");
  mkdirSync(project);
});
afterEach(async () => { await removeTempDir(dir); });

describe("T91: the approval policy per Codex version", () => {
  it("records the probed retirement version and keeps the gate floor below it", () => {
    expect(CODEX_UNTRUSTED_RETIRED_MIN).toEqual([0, 149, 0]);
    expect(CODEX_GATE_MIN).toEqual([0, 129, 0]);
    expect(CODEX_FLOORS.gate[1]!).toBeLessThan(CODEX_FLOORS.retired[1]!);
  });

  it("keeps the retired policy only below the retirement and gates from there", () => {
    expect(codexGatePlan("codex-cli 0.148.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.129.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.56.0")).toEqual({ mode: "legacy" });
    expect(codexGatePlan("codex-cli 0.149.0")).toEqual({ mode: "gated" });
    expect(codexGatePlan("codex-cli 0.163.0")).toEqual({ mode: "gated" });
    expect(codexGatePlan("codex-cli 1.2.3")).toEqual({ mode: "gated" });
    // an unknown version is never legacy: the handshake decides
    expect(codexGatePlan(undefined)).toEqual({ mode: "gated" });
  });

  it("refuses a retired build that cannot carry the gate", () => {
    // no real build sits between the floors; a floor pair that leaves one shows the rule
    expect(codexGatePlan("codex-cli 0.110.0", { retired: [0, 100, 0], gate: [0, 129, 0] })).toEqual({ mode: "refuse", why: "update-codex" });
    expect(codexGatePlan("codex-cli 0.129.0", { retired: [0, 100, 0], gate: [0, 129, 0] })).toEqual({ mode: "gated" });
  });

  it("sends exactly what the driver sent before the pin below the retirement, and on-request from it", () => {
    const retired = ["un", "trusted"].join("");
    const base = { proposalOnly: false };
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: false, enforceApproval: true }).approvalPolicy).toBe(retired);
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: true, enforceApproval: true }).approvalPolicy).toBe(retired);
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: true, enforceApproval: false }).approvalPolicy).toBe("never");
    expect(codexTurnPolicy("codex-cli 0.147.0", { ...base, fullAuto: false, enforceApproval: false }).approvalPolicy).toBe("on-request");
    expect(codexTurnPolicy("codex-cli 0.147.0", { proposalOnly: true, fullAuto: true, enforceApproval: false })).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    for (const fullAuto of [false, true]) for (const enforceApproval of [false, true]) {
      expect(codexTurnPolicy("codex-cli 0.149.0", { ...base, fullAuto, enforceApproval }).approvalPolicy).toBe("on-request");
      expect(codexTurnPolicy("codex-cli 0.163.0", { ...base, fullAuto, enforceApproval }).approvalPolicy).toBe("on-request");
    }
    // the spelling follows the version below 0.69 as before
    expect(codexTurnPolicy("codex-cli 0.60.0", { ...base, fullAuto: false, enforceApproval: false })).toEqual({ approvalPolicy: "onRequest", sandbox: "workspaceWrite" });
    expect(codexTurnPolicy("codex-cli 0.163.0", { ...base, fullAuto: true })).toEqual({ approvalPolicy: "on-request", sandbox: "danger-full-access" });
  });
});

describe("T100a: what Murage writes into the scoped home", () => {
  it("writes hooks.json with one matcher-free PreToolUse and one SessionStart handler and nothing secret", () => {
    const home = join(dir, "scope");
    const files = writeHookFiles(home, hookSocketPath("abc"), "tok-123", "/usr/bin/node");
    const json = JSON.parse(readFileSync(files.hooksJson, "utf8"));
    expect(Object.keys(json.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    for (const event of ["PreToolUse", "SessionStart"]) {
      expect(json.hooks[event]).toHaveLength(1);
      expect(json.hooks[event][0]).not.toHaveProperty("matcher");
      expect(json.hooks[event][0].hooks).toHaveLength(1);
      const handler = json.hooks[event][0].hooks[0];
      expect(handler.type).toBe("command");
      expect(handler.command).toBe(`"/usr/bin/node" "${files.script}"`);
      // Windows: the command names no quote and no spaced path (Codex escapes inner quotes, rig 0.153.3) and reads the same in cmd and
      // PowerShell (F3: Codex 0.163.0 runs it under `powershell -NoProfile -Command`); the launch line rides in the environment.
      expect(handler.command_windows).toBe(codexHookWindowsCommand());
      expect(handler.command_windows).not.toMatch(/"/);
      expect(handler.timeout).toBe(HOOK_TIMEOUT_SEC);
    }
    expect(HOOK_TIMEOUT_SEC).toBe(Math.ceil(HOOK_ASK_BOUND_MS / 1000) + 30);
    // the token and the socket are in the 0600 env file and nowhere else
    expect(readFileSync(files.hooksJson, "utf8")).not.toContain("tok-123");
    expect(readFileSync(files.script, "utf8")).not.toContain("tok-123");
    expect(readFileSync(files.envFile, "utf8")).toBe(`SOCKET=${hookSocketPath("abc")}\nTOKEN=tok-123\n`);
    if (process.platform !== "win32") expect(statMode(files.envFile)).toBe(0o600);
    // hooks.json is identical on the next turn, so the hash and the trust hold
    const before = readFileSync(files.hooksJson, "utf8");
    writeHookFiles(home, hookSocketPath("abc"), "tok-456", "/usr/bin/node");
    expect(readFileSync(files.hooksJson, "utf8")).toBe(before);
    expect(readFileSync(files.envFile, "utf8")).toContain("tok-456");
    expect(codexHooksJson("/usr/bin/node", files.script)).toBe(before);
    expect(hookLaunchLine("/usr/bin/node", files.script)).toBe(`"/usr/bin/node" "${files.script}"`);
    // the launch line is part of the hook configuration, so a kept process whose node or script moved waits for a fresh proof
    expect(hookConfigOf(home, "/usr/bin/node")).not.toBe(hookConfigOf(home, "/opt/node/bin/node"));
  });

  // F3 (1.0.3 Windows gate): Codex picks the hook's shell (PowerShell `-NoProfile -Command`, cmd `/c`, or `%COMSPEC% /C "<command>"`;
  // codex-rs hooks/src/engine/command_runner.rs build_command). A string is shell-independent when its program is a bare absolute path
  // (no space, quote or variable: both shells run it the same way) and its arguments hold nothing special to PowerShell's argument
  // mode or to cmd outside quotes, except the one launch variable, which PowerShell passes on unread and the inner cmd expands.
  const shellIndependent = (command: string): boolean => {
    const [program, ...args] = command.split(" ");
    if (!program || !/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+\.exe$/i.test(program)) return false;
    const launch = `%${CODEX_HOOK_LAUNCH_ENV}%`;
    if (!args.every((arg) => arg === launch || /^[A-Za-z0-9_/:.\\-]+$/.test(arg))) return false;
    // the variable is read by an explicit inner cmd (`/c` right before it), never by whichever shell Codex picked
    return /\\cmd\.exe$/i.test(program) && args.at(-1) === launch && args.at(-2)?.toLowerCase() === "/c" && args.includes("/d");
  };

  it("hands Codex a Windows hook command that means the same in cmd and in PowerShell (F3)", () => {
    // the 1.0.3-rc command: cmd expanded it, PowerShell ran `%` (ForEach-Object) and the hook never started
    expect(shellIndependent(`%${CODEX_HOOK_LAUNCH_ENV}%`)).toBe(false);
    expect(shellIndependent(`& "C:\\Program Files\\nodejs\\node.exe" "x.mjs"`)).toBe(false);
    expect(shellIndependent(`"C:\\Program Files\\nodejs\\node.exe" "x.mjs"`)).toBe(false);
    const written = JSON.parse(codexHooksJson("C:\\Users\\Jo Smith\\node.exe", "C:\\Users\\Jo Smith\\scope\\murage-hook.mjs")).hooks;
    for (const event of ["PreToolUse", "SessionStart"]) expect(shellIndependent(written[event][0].hooks[0].command_windows)).toBe(true);
    expect(codexHookWindowsCommand("D:\\WINNT")).toBe(`D:\\WINNT\\System32\\cmd.exe /d /v:off /c %${CODEX_HOOK_LAUNCH_ENV}%`);
    // a system folder that is not a plain path never reaches the command
    for (const odd of ["C:\\Win dows", "C:\\W\"in", "%SystemRoot%", "C:\\$x", "relative", ""]) {
      expect(windowsCmdPath(odd)).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(shellIndependent(codexHookWindowsCommand(odd))).toBe(true);
    }
    // the launch line never starts with a quote, so the inner cmd's /c rule cannot strip its first and last quote when an outer cmd
    // expanded the variable first
    const value = hookWindowsLaunchValue("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Jo Smith\\scope\\murage-hook.mjs");
    expect(value).toBe(`@"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jo Smith\\scope\\murage-hook.mjs"`);
    expect(value.startsWith("\"")).toBe(false);
  });

  it.runIf(process.platform === "win32")("runs the Windows command under cmd.exe /C both ways Codex quotes it and under PowerShell -NoProfile -Command, from a node path with a space", async () => {
    const home = join(dir, "scope win");
    const gate = new CodexHookGate(hookSocketPath());
    await gate.listen();
    try {
      const files = writeHookFiles(home, gate.path, "win-token");
      const sessions: string[] = [];
      gate.arm({ token: "win-token", onSession: (id) => { sessions.push(id); }, onPreTool: async () => ({ decision: "allow" }) });
      const command = JSON.parse(readFileSync(files.hooksJson, "utf8")).hooks.SessionStart[0].hooks[0].command_windows as string;
      const env = { ...process.env, [CODEX_HOOK_LAUNCH_ENV]: hookWindowsLaunchValue(process.execPath, files.script) };
      const comspec = process.env.COMSPEC ?? "cmd.exe";
      const runCmd = (args: string[], verbatim: boolean, id: string, program = comspec) => new Promise<number | null>((resolve) => {
        const child = spawn(program, args, { env, windowsVerbatimArguments: verbatim, stdio: ["pipe", "ignore", "ignore"] });
        child.on("close", (code) => resolve(code));
        child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: id, source: "startup" }));
      });
      // Codex 0.153.3 (std arg escaping) and the raw `"<command>"` form of later builds
      expect(await runCmd(["/C", command], false, "escaped")).toBe(0);
      expect(await runCmd(["/C", `"${command}"`], true, "raw")).toBe(0);
      // Codex 0.163.0 with PowerShell as the user shell (F3)
      expect(await runCmd(["-NoProfile", "-Command", command], false, "powershell", "powershell.exe")).toBe(0);
      expect(sessions).toEqual(["escaped", "raw", "powershell"]);
    } finally { gate.close(); }
  });

  it("gives the script a deadline shorter than the handler timeout and no way to print ask", () => {
    expect(HOOK_SCRIPT_DEADLINE_MS / 1000).toBeLessThan(HOOK_TIMEOUT_SEC);
    expect(CODEX_HOOK_SCRIPT).not.toMatch(/"ask"|'ask'|permissionDecision: "ask"/);
    expect(CODEX_HOOK_SCRIPT).not.toContain("process.argv");
    expect(CODEX_HOOK_SCRIPT.match(/process\.exit\(2\)/g)?.length).toBe(1);
  });

  it("drops the owner's hooks table and its trust records from the config copy and keeps the rest", () => {
    const owner = [
      'model = "gpt-x"',
      'hooks.state = { "a" = { trusted_hash = "x" } }',
      "[mcp_servers.files]",
      'command = "files"',
      "[hooks]",
      'something = "owner hook"',
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      "[hooks.state]",
      '"/home/o/.codex/hooks.json:pre_tool_use:0:0" = { trusted_hash = "sha256:aa" }',
      "[projects.\"/work\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const kept = stripOwnerHooks(owner);
    expect(kept).not.toMatch(/hooks/);
    expect(kept).not.toContain("trusted_hash");
    expect(kept).toContain('model = "gpt-x"');
    expect(kept).toContain("[mcp_servers.files]");
    expect(kept).toContain('command = "files"');
    expect(kept).toContain('trust_level = "trusted"');
    // a name that only starts like it is another key
    expect(stripOwnerHooks('hooks_note = "x"\n[hookstore]\na = 1\n')).toContain("[hookstore]");
    // a multi-line inline value is dropped whole
    expect(stripOwnerHooks('hooks = {\n  state = { a = 1 }\n}\nmodel = "m"\n')).toBe('model = "m"\n');
  });

  it("pins the shell form: no login shell, the pins as policy, the shell-form features off", () => {
    const pins = new Map([["PAGER", "cat"], ["GIT_ASKPASS", ""], ["GIT_SSH_COMMAND", "'/opt/ssh' '-o' 'BatchMode=yes' '-p' '2222'"]]);
    const args = codexShellFormArgs(pins).join(" ");
    // the handed pin map, resolved values included, is the policy's `set`
    expect(args).toContain(`GIT_SSH_COMMAND=${JSON.stringify("'/opt/ssh' '-o' 'BatchMode=yes' '-p' '2222'")}`);
    expect(args).toContain('GIT_ASKPASS=""');
    expect(args).toContain("allow_login_shell=false");
    expect(args).toContain('shell_environment_policy.inherit="all"');
    expect(args).toMatch(/shell_environment_policy\.set=\{[^}]*PAGER="cat"/);
    for (const name of ABSENT_PINS) expect(args).toContain(JSON.stringify(name));
    for (const feature of CODEX_SHELL_FORM_FEATURES) expect(args).toContain(`features.${feature}=false`);
  });
});

describe("T100b: trust through hooks/list and config/batchWrite", () => {
  const hooksJson = "/scope/hooks.json";
  const listing = (trust: { pre: string; start: string }, extra: unknown[] = []) => ({
    data: [{ cwd: "/work", errors: [], warnings: [], hooks: [
      { key: `${hooksJson}:pre_tool_use:0:0`, eventName: "preToolUse", trustStatus: trust.pre, enabled: true, isManaged: false, sourcePath: hooksJson, currentHash: "sha256:p" },
      { key: `${hooksJson}:session_start:0:0`, eventName: "sessionStart", trustStatus: trust.start, enabled: true, isManaged: false, sourcePath: hooksJson, currentHash: "sha256:s" },
      ...extra,
    ] }],
  });

  it("trusts both handlers that list untrusted or modified, then requires both trusted and enabled", async () => {
    const writes: any[] = [];
    let trusted = false;
    const rpc = async (method: string, params: any) => {
      if (method === "config/batchWrite") { writes.push(params); trusted = true; return { status: "ok" }; }
      return trusted ? listing({ pre: "trusted", start: "trusted" }) : listing({ pre: "untrusted", start: "modified" });
    };
    await expect(trustHooks(rpc, hooksJson, "/work")).resolves.toEqual({ ok: true, managed: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ reloadUserConfig: true, edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert" }] });
    expect(writes[0].edits[0].value).toEqual({ [`${hooksJson}:pre_tool_use:0:0`]: { trusted_hash: "sha256:p" }, [`${hooksJson}:session_start:0:0`]: { trusted_hash: "sha256:s" } });
  });

  it("writes nothing when both are already trusted, and counts a managed hook without blocking on it", async () => {
    const managed = { key: "m", eventName: "preToolUse", trustStatus: "managed", enabled: true, isManaged: true, sourcePath: "/etc/codex/hooks.json", currentHash: "sha256:m" };
    const calls: string[] = [];
    const rpc = async (method: string) => { calls.push(method); return listing({ pre: "trusted", start: "trusted" }, [managed]); };
    await expect(trustHooks(rpc, hooksJson, "/work")).resolves.toEqual({ ok: true, managed: 1 });
    expect(calls).toEqual(["hooks/list"]);
  });

  it("refuses a missing method, a trust write that did not take, and another runnable hook", async () => {
    const missing = async () => { throw new Error("method not found"); };
    expect(await trustHooks(missing, hooksJson, "/work")).toMatchObject({ ok: false, why: expect.stringContaining("hooks/list") });
    const stays = async (method: string) => (method === "config/batchWrite" ? { status: "ok" } : listing({ pre: "untrusted", start: "untrusted" }));
    expect(await trustHooks(stays, hooksJson, "/work")).toMatchObject({ ok: false, why: "Murage's handlers are not trusted and enabled" });
    const other = { key: "o", eventName: "preToolUse", trustStatus: "trusted", enabled: true, isManaged: false, sourcePath: "/proj/.codex/hooks.json", currentHash: "sha256:o" };
    const crowded = async () => listing({ pre: "trusted", start: "trusted" }, [other]);
    expect(await trustHooks(crowded, hooksJson, "/work")).toMatchObject({ ok: false, why: "another hook would run in this scope" });
    const absent = async () => ({ data: [{ cwd: "/work", errors: [], warnings: [], hooks: [] }] });
    expect(await trustHooks(absent, hooksJson, "/work")).toMatchObject({ ok: false });
    const disabled = async () => { const l = listing({ pre: "trusted", start: "trusted" }); (l.data[0]!.hooks[0] as any).enabled = false; return l; };
    expect(await trustHooks(disabled, hooksJson, "/work")).toMatchObject({ ok: false });
  });

  // Astra BLOCK 10 (Rules 2, 68b): only an explicit true is enabled; another handler that is not explicitly off may still run
  it("reads a missing, null or unknown enabled as not enabled for Murage's handlers and as runnable for another", async () => {
    for (const value of [undefined, null, "true", 1]) {
      const odd = async () => { const l = listing({ pre: "trusted", start: "trusted" }); const h = l.data[0]!.hooks[1] as any; if (value === undefined) delete h.enabled; else h.enabled = value; return l; };
      expect(await trustHooks(odd, hooksJson, "/work")).toMatchObject({ ok: false, why: "Murage's handlers are not trusted and enabled" });
      const other = { key: "o", eventName: "preToolUse", trustStatus: "trusted", isManaged: false, sourcePath: "/proj/.codex/hooks.json", currentHash: "sha256:o", ...(value === undefined ? {} : { enabled: value }) };
      expect(await trustHooks(async () => listing({ pre: "trusted", start: "trusted" }, [other]), hooksJson, "/work")).toMatchObject({ ok: false, why: "another hook would run in this scope" });
    }
  });
});

describe("T100d: the script can only allow, deny or exit 2", () => {
  const run = (home: string, input: unknown, env: NodeJS.ProcessEnv = process.env) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(home, "murage-hook.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
  const pre = (extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call-1", turn_id: "t1", cwd: "/work", ...extra });
  let gate: CodexHookGate;
  let home: string;
  beforeEach(async () => {
    home = join(dir, "scope");
    gate = new CodexHookGate(hookSocketPath());
    await gate.listen();
    writeHookFiles(home, gate.path, "good-token");
  });
  afterEach(() => { gate.close(); });
  const arm = (answer: HookAnswer, seen: HookDelivery[] = [], sessions: string[] = []) =>
    gate.arm({ token: "good-token", onSession: (id) => { sessions.push(id); }, onPreTool: async (d) => { seen.push(d); return answer; } });

  it("prints allow and deny as the documented hook output and delivers the call whole", async () => {
    const seen: HookDelivery[] = [];
    arm({ decision: "allow" }, seen);
    const allowed = await run(home, pre());
    // rig, Codex 0.163.0: a printed allow is "unsupported" and fails the run; a silent clean exit lets the call proceed
    expect(allowed).toMatchObject({ code: 0, stdout: "" });
    expect(seen[0]).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call-1", turn_id: "t1", cwd: "/work" });
    arm({ decision: "deny", reason: "narrow it: use find with a path" });
    const denied = await run(home, pre());
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "narrow it: use find with a path" } });
    arm({ decision: "allow", updatedInput: { command: "ls -a" }, additionalContext: "excluded .git" });
    expect(JSON.parse((await run(home, pre())).stdout).hookSpecificOutput).toMatchObject({ updatedInput: { command: "ls -a" }, additionalContext: "excluded .git" });
  });

  it("posts the SessionStart liveness with the session id and prints nothing", async () => {
    const sessions: string[] = [];
    arm({ decision: "allow" }, [], sessions);
    const started = await run(home, { hook_event_name: "SessionStart", session_id: "thread-9", source: "startup" });
    expect(started).toMatchObject({ code: 0, stdout: "" });
    expect(sessions).toEqual(["thread-9"]);
  });

  it("exits 2 with the reason on stderr for every other outcome", async () => {
    // no turn armed: the token is refused
    gate.disarm();
    const refused = await run(home, pre());
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("Murage blocked this call");
    // a wrong token in the env file
    writeFileSync(join(home, "murage-hook.env"), `SOCKET=${gate.path}\nTOKEN=other\n`);
    arm({ decision: "allow" });
    expect((await run(home, pre())).code).toBe(2);
    // socket refused
    writeFileSync(join(home, "murage-hook.env"), `SOCKET=${hookSocketPath("nobody-listens")}\nTOKEN=good-token\n`);
    expect((await run(home, pre())).code).toBe(2);
    // no env file, malformed stdin, an unknown event
    writeHookFiles(home, gate.path, "good-token");
    expect((await run(home, "not json")).code).toBe(2);
    expect((await run(home, { hook_event_name: "Stop" })).code).toBe(2);
    // a malformed answer from the gate
    gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => ({ decision: "ask" } as never) });
    expect((await run(home, pre())).code).toBe(2);
    // a gate that throws answers deny, never silence
    gate.arm({ token: "good-token", onSession: () => {}, onPreTool: async () => { throw new Error("boom"); } });
    const thrown = await run(home, pre());
    expect(thrown.code).toBe(0);
    expect(JSON.parse(thrown.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    // a link in place of the env file does not matter to the script: it only reads its own folder
    symlinkSync(join(home, "murage-hook.env"), join(home, "link.env"));
  });
});

describe("T86 and T103: a Codex delivery as a decision", () => {
  const ctx = (extra: Partial<RouteContext> = {}): RouteContext => ({ project, home: dir, mounts: [
    { engineName: "agents", mountId: "own:agents", provenance: "own" },
    { engineName: "murage-memory", mountId: "own:memory", provenance: "own" },
    { engineName: "crm", mountId: "custom:crm", provenance: "custom" },
    { engineName: "gh", mountId: `external:codex:${"0".repeat(16)}:gh`, provenance: "external" },
  ], ...extra });
  const delivery = (tool_name: unknown, tool_input: unknown, more: Partial<HookDelivery> = {}): HookDelivery => ({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: project, ...more });

  it("sends a Bash or exec_command call to the verdict as a shell ask, with the command and the folder as written", () => {
    expect(routeDelivery(delivery("Bash", { command: "ls -la" }), ctx())).toMatchObject({ route: "ask", tool: "shell", command: "ls -la", cwd: project, toolCall: { name: "shell", input: { command: "ls -la", cwd: project } } });
    expect(routeDelivery(delivery("exec_command", { cmd: "git status", workdir: join(project, "sub") }), ctx())).toMatchObject({ route: "ask", tool: "shell", command: "git status", cwd: join(project, "sub") });
    // F5: a missing command is stated missing and never replaced
    const missing = routeDelivery(delivery("Bash", {}), ctx());
    expect(missing).toMatchObject({ route: "ask", tool: "shell", toolInputMissing: "command", toolCall: { name: "shell" } });
    expect((missing as any).toolCall).not.toHaveProperty("input");
  });

  it("reads apply_patch destinations from the headers and allows only in-project, non-sensitive ones", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    const inside = patch("*** Add File: notes/a.md", "+hello", "*** Update File: src/b.ts", "@@", "-x", "+y", "*** Move to: src/c.ts");
    expect(parseApplyPatch(inside)?.destinations).toEqual(["notes/a.md", "src/b.ts", "src/c.ts"]);
    mkdirSync(join(project, "src"));
    // the allow carries each destination by its real path (APP-GRANT-FIXPLAN-r6 (b), Rule 67)
    expect(routeDelivery(delivery("apply_patch", { command: inside }), ctx())).toEqual({ route: "allow", final: true, why: "own-workspace", destinations: [join(project, "notes", "a.md"), join(project, "src", "b.ts"), join(project, "src", "c.ts")], cwd: project });
    expect(routeDelivery(delivery("apply_patch", inside), ctx())).toMatchObject({ route: "allow", final: true, why: "own-workspace" });
    for (const bad of ["*** Add File: .env", "*** Delete File: ../outside.txt", "*** Add File: ~/.ssh/authorized_keys", "*** Add File: .git/hooks/pre-commit"]) {
      const out = routeDelivery(delivery("apply_patch", { command: patch(bad, "+x") }), ctx());
      expect(out).toMatchObject({ route: "ask", tool: "edit", destinations: [bad.split(": ")[1]] });
    }
    // a patch that is not one whole envelope is unread: a card, never an allow
    for (const unread of ["", "*** Begin Patch\n*** Add File: a\n+x", "*** Begin Patch\nnonsense line\n*** End Patch", "*** Begin Patch\n*** End Patch", 7, undefined]) {
      expect(parseApplyPatch(unread)).toBeNull();
      expect(routeDelivery(delivery("apply_patch", { command: unread }), ctx())).toMatchObject({ route: "ask", tool: "edit", toolInputMissing: "patch" });
    }
    // a link out of the project is placed by its real path
    symlinkSync(dir, join(project, "out"));
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: out/x.txt", "+x") }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
  });

  // Astra BLOCK 3 (Rules 63.2, 75d): `link/..` climbs from the link's real target, never collapsed before the link resolves
  it("places link/../x from the link's target, never lexically", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    mkdirSync(join(dir, "elsewhere", "deep"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "deep"), join(project, "jump"));
    // lexically project/x.txt (inside); really elsewhere/x.txt (outside)
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: jump/../x.txt", "+x") }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    writeFileSync(join(dir, "elsewhere", "x.png"), "x");
    expect(routeDelivery(delivery("view_image", { path: "jump/../x.png" }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
  });

  // Astra BLOCK 4 (Rules 63.5, 64): a template file's body is read by the secret-shape rules, added or updated
  it("asks for an in-project template file whose body carries a real secret, and allows a placeholder", () => {
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    const key = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: .env.example", "+OPENAI_API_KEY=") }), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Add File: .env.example", `+OPENAI_API_KEY=${key}`) }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    writeFileSync(join(project, ".env.sample"), "A=\n");
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: .env.sample", "@@", "-A=", `+A=${key}`) }), ctx())).toMatchObject({ route: "ask", tool: "edit" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: notes.md", "@@", "-A", "+B", "*** Move to: .env.dist") }), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("apply_patch", { command: patch("*** Update File: notes.md", "@@", "-A", "+-----BEGIN OPENSSH PRIVATE KEY-----", "*** Move to: .env.dist") }), ctx())).toMatchObject({ route: "ask" });
  });

  it("judges an MCP call against the mounts: own unasked rows run, other own tools and unproven names are asked, custom and external pass to the approval path", () => {
    const row = OWN_UNASKED.find((r) => r.mount === "own:agents")!;
    expect(routeDelivery(delivery(`mcp__agents__${row.tools[0]}`, {}), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    expect(routeDelivery(delivery("mcp__murage-memory__memory_search", { q: "x" }), ctx())).toEqual({ route: "allow", final: true, why: "own-unasked" });
    expect(routeDelivery(delivery("mcp__agents__publish_site", { x: 1 }), ctx())).toMatchObject({ route: "ask", tool: "publish_site", toolCall: { name: "mcp__agents__publish_site", input: { x: 1 } } });
    expect(routeDelivery(delivery("mcp__agents__not_in_any_row", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__crm__lookup", {}), ctx())).toEqual({ route: "allow", final: false, why: "custom" });
    expect(routeDelivery(delivery("mcp__gh__issues", {}), ctx())).toEqual({ route: "allow", final: false, why: "external" });
    // no record, no mount list, a missing tool part, a name that fits no record: unproven, so asked
    expect(routeDelivery(delivery("mcp__ghost__tool", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__list_bots", {}), ctx({ mounts: undefined }))).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__", {}), ctx())).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery("mcp__agents__list_bots", undefined), ctx())).toMatchObject({ route: "allow" });
    expect(routeDelivery(delivery("mcp__agents__publish_site", undefined), ctx())).toMatchObject({ route: "ask", toolInputMissing: "tool_input" });
  });

  it("lets exactly update_plan through as an ordinary local tool, judges view_image like a read, and denies the rest", () => {
    expect(CODEX_LOCAL_ORDINARY).toEqual(["update_plan"]);
    expect(routeDelivery(delivery("update_plan", { plan: [] }), ctx())).toEqual({ route: "allow", final: true, why: "local-ordinary" });
    writeFileSync(join(project, "shot.png"), "x");
    writeFileSync(join(project, ".env"), "KEY=1");
    expect(routeDelivery(delivery("view_image", { path: "shot.png" }), ctx())).toEqual({ route: "allow", final: true, why: "own-workspace" });
    expect(routeDelivery(delivery("view_image", { path: join(project, "shot.png") }), ctx())).toMatchObject({ route: "allow" });
    for (const path of [".env", "~/.ssh/id_rsa.png", "../elsewhere.png"]) expect(routeDelivery(delivery("view_image", { path }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
    symlinkSync(join(dir, "secret.png"), join(project, "link.png"));
    writeFileSync(join(dir, "secret.png"), "x");
    expect(routeDelivery(delivery("view_image", { path: "link.png" }), ctx())).toMatchObject({ route: "ask", tool: "view_image" });
    expect(routeDelivery(delivery("view_image", {}), ctx())).toMatchObject({ route: "ask", toolInputMissing: "path" });
    for (const name of ["web_fetch", "shell_snapshot", "request_user_input", "write_stdin", "", undefined, 7]) {
      expect(routeDelivery(delivery(name, {}), ctx())).toEqual({ route: "deny", reason: "Murage does not know this tool" });
    }
    // native search tools wait for the verdict (the walk of build step 4)
    expect(routeDelivery(delivery("grep_files", { pattern: "x" }), ctx())).toMatchObject({ route: "ask", tool: "grep_files" });
  });
});

describe("Rule 67: the tripwire table", () => {
  const issue = (table: HookDecisionTable, over: Partial<Parameters<HookDecisionTable["record"]>[0]> = {}) =>
    table.record({ toolUseId: "call-1", turnId: "t1", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash", ...over });

  it("matches a started call by id and treats an allow as ordinary", () => {
    const table = new HookDecisionTable();
    issue(table);
    expect(table.match({ id: "call-1", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: true });
  });

  it("calls a deny-matched call and an unmatched call incidents", () => {
    const table = new HookDecisionTable();
    issue(table, { decision: "deny" });
    expect(table.match({ id: "call-1", type: "commandExecution", command: "rm -rf x" }, "t1")).toEqual({ ok: false, why: "denied", command: "rm -rf x" });
    expect(table.match({ id: "other", type: "commandExecution", command: "curl evil" }, "t1")).toEqual({ ok: false, why: "unmatched", command: "curl evil" });
    expect(table.match({ id: "f1", type: "fileChange" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
  });

  it("falls back to command and cwd in order of issue, and an ambiguous fallback is a mismatch", () => {
    const table = new HookDecisionTable();
    issue(table, { toolUseId: "a" });
    expect(table.match({ id: "zzz", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: true });
    // consumed: the same started call again is unmatched
    expect(table.match({ id: "zzy", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const twice = new HookDecisionTable();
    issue(twice, { toolUseId: "a" });
    issue(twice, { toolUseId: "b" });
    expect(twice.match({ id: "zzz", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "ambiguous" });
    // another folder or another turn is no match
    const other = new HookDecisionTable();
    issue(other);
    expect(other.match({ id: "q", type: "commandExecution", command: "ls", cwd: "/elsewhere" }, "t1")).toMatchObject({ ok: false });
    expect(other.match({ id: "q", type: "commandExecution", command: "ls", cwd: "/work" }, "t2")).toMatchObject({ ok: false });
  });

  it("matches a file change on its destinations or an MCP call by its one delivery when the ids differ", () => {
    const table = new HookDecisionTable();
    // (a real absolute folder: `/work` names no place on Windows, so its destinations could never be placed there)
    table.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["a.md"], cwd: project });
    table.record({ toolUseId: "m1", turnId: "t1", decision: "allow", final: false, name: "mcp__crm__lookup" });
    expect(table.match({ id: "x1", type: "fileChange", changes: [{ path: join(project, "a.md") }] }, "t1")).toMatchObject({ ok: true });
    expect(table.match({ id: "x2", type: "mcpToolCall", server: "crm", tool: "lookup" }, "t1")).toMatchObject({ ok: true });
    expect(table.match({ id: "x3", type: "mcpToolCall", server: "crm", tool: "lookup" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
  });

  // Astra BLOCK 7 (Rule 67): a missing turn id or folder matches nothing, and a file change matches only on its destinations
  it("never treats a missing turn id or cwd as a wildcard, and never matches a file change on its tool name alone", () => {
    const shell = new HookDecisionTable();
    shell.record({ toolUseId: "a", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash" });
    expect(shell.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const noCwd = new HookDecisionTable();
    noCwd.record({ toolUseId: "a", turnId: "t1", decision: "allow", final: true, command: "ls", name: "Bash" });
    expect(noCwd.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const unstated = new HookDecisionTable();
    unstated.record({ toolUseId: "a", turnId: "t1", decision: "allow", final: true, command: "ls", cwd: "/work", name: "Bash" });
    expect(unstated.match({ id: "z", type: "commandExecution", command: "ls" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    expect(unstated.match({ id: "z", type: "commandExecution", command: "ls", cwd: "/work" })).toMatchObject({ ok: false, why: "unmatched" });
    const files = new HookDecisionTable();
    files.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch", destinations: ["notes.md"], cwd: "/work" });
    expect(files.match({ id: "f1", type: "fileChange", changes: [{ path: "/work/.git/hooks/pre-commit" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    expect(files.match({ id: "f1", type: "fileChange" }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    const unplaced = new HookDecisionTable();
    unplaced.record({ toolUseId: "p1", turnId: "t1", decision: "allow", final: true, name: "apply_patch" });
    expect(unplaced.match({ id: "f1", type: "fileChange", changes: [{ path: "/work/a.md" }] }, "t1")).toMatchObject({ ok: false, why: "unmatched" });
    // by id, the change must still land where the hook placed it
    expect(files.match({ id: "p1", type: "fileChange", changes: [{ path: "/work/other.md" }] }, "t1")).toMatchObject({ ok: false });
  });

  it("words the owner line as the design says", () => {
    expect(tripwireLine("rm -rf x")).toBe("Codex ran `rm -rf x` without Murage's check; the turn was stopped");
    for (const word of [/\bsafe/i, /unsafe/i, /safety/i, /composio/i, /—/]) expect(tripwireLine("x")).not.toMatch(word);
  });
});

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
