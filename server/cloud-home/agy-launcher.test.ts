// SPDX-License-Identifier: AGPL-3.0-or-later
// Antigravity (agy) on a Cloud home: the launcher's argv grammar, pinned environment, rendered
// config, sign-in command and token persistence. Drives the real launcher Python.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTIGRAVITY_ASK_HOOK_SOURCE } from "../drivers/antigravity.ts";
import { ANTIGRAVITY_RELAY_SCRIPT, ANTIGRAVITY_WORKSPACE_ROOTS } from "../drivers/antigravity-relay.ts";
import { MINIMAL_ARGV, launcher, launcherRig, signinStore, type Rig } from "./engine-launch-fixture.ts";

let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-agy-"); });
afterEach(() => rig.dispose());
const unit = "murage-turn-0123456789abcdef.scope";
const SESSION = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const BASE = MINIMAL_ARGV.antigravity;
const socket = "/data/broker/perm-abcd1234.sock";
const RELAY = { profile: "relay", socket: "/data/broker/agyr-0123456789ab.sock", token: "a".repeat(48) };
const LOG = "/data/broker/agyr-0123456789ab.log";
const ok = (request: Record<string, unknown>) => { const result = rig.plan(request); if (!result.ok) throw new Error(result.error); return result.ok; };
const refused = (args: string[], extra: Record<string, unknown> = {}) => rig.plan(rig.request("antigravity", { args, ...extra })).error;

describe("agy argv grammar", () => {
  it("accepts the smallest and the fullest argv the driver emits, in both access forms", () => {
    expect(rig.plan(rig.request("antigravity")).ok?.args).toEqual(BASE);
    for (const access of [["--dangerously-skip-permissions"], ["--mode", "accept-edits"]]) {
      const args = [...BASE, "--print-timeout", "8760h", "--add-dir", `${rig.workspaces}/ws/proj`, ...access, "--model", "gemini-3.5-pro", "--conversation", SESSION];
      const result = rig.plan(rig.request("antigravity", { unit, args, render: { hooks: RELAY } }));
      expect(result.error).toBeUndefined();
      expect(result.ok!.args.length).toBe(args.length);
    }
  });
  it.each([
    [[...BASE, "--sandbox"], "--sandbox"], [[...BASE, "--remote-control"], "--remote-control"], [[...BASE, "-p"], "-p"],
    [[...BASE, "--add-dir", "/etc"], "--add-dir"], [[...BASE, "--mode", "auto"], "--mode"], [[...BASE, "--print-timeout", "1h"], "--print-timeout"],
    [[...BASE, "--conversation", "../x"], "--conversation"], [[...BASE, "--model", "/x"], "--model"],
    [["--input-format", "stream-json"], "missing --output-format"], [["--output-format", "stream-json"], "missing --input-format"],
  ])("refuses %j naming only %s", (args, named) => {
    expect(refused(args)).toBe(`Cloud engine argument is not allowed: ${named}`);
  });
  it("accepts the server's probes as whole argv", () => {
    for (const args of [["--version"], ["models"]]) expect(rig.plan(rig.request("antigravity", { args })).ok?.args).toEqual(args);
    expect(refused(["--version", "--help"])).toBeDefined();
  });
});

describe("agy Auto and Full: the relay hook profile and the project-config masks", () => {
  const relayArgs = (...more: string[]) => [...BASE, "--dangerously-skip-permissions", "--log-file", LOG, ...more];
  it("renders a read-only hooks.json, the server's own relay program and the turn's socket and token into the turn's home", () => {
    const plan = ok(rig.request("antigravity", { args: relayArgs(), render: { hooks: RELAY, mcp: { muragebox: { proxy: "permission", socket } } } }));
    const home = rig.home("antigravity");
    const hooks = JSON.parse(plan.files[`${home}/.gemini/config/hooks.json`]);
    expect(Object.keys(hooks)).toEqual(["murage-relay"]);
    expect(hooks["murage-relay"].PreToolUse).toHaveLength(1);
    expect(hooks["murage-relay"].PreToolUse[0].hooks[0].command).toBe(`"/usr/local/bin/node" "${home}/.gemini/config/murage-agy-relay.cjs"`);
    expect(plan.files[`${home}/.gemini/config/murage-agy-relay.cjs`]).toBe(ANTIGRAVITY_RELAY_SCRIPT);
    expect(plan.files[`${home}/.gemini/config/murage-agy-relay.env`]).toBe(`SOCKET=${RELAY.socket}\nTOKEN=${RELAY.token}\n`);
    expect(Object.keys(plan.files).some(path => !path.startsWith(`${home}/`))).toBe(false);
  });
  it("refuses a relay profile with any other key, a socket outside /data/broker, or a short token; the Ask profile is unchanged", () => {
    for (const bad of [{ ...RELAY, extra: 1 }, { ...RELAY, socket: "/data/broker/perm-abcd1234.sock" }, { ...RELAY, socket: "/tmp/agyr-0123456789ab.sock" }, { ...RELAY, token: "short" }, { ...RELAY, profile: "ask" }, { socket: RELAY.socket, token: RELAY.token }]) {
      expect(rig.plan(rig.request("antigravity", { args: BASE, render: { hooks: bad } })).error).toBe("Cloud turn render hooks is not allowed");
    }
  });
  it("lets agy skip its own permissions only behind the relay hook, and read the relay log only with it", () => {
    expect(refused([...BASE, "--dangerously-skip-permissions"])).toBe("Cloud engine argument is not allowed: --dangerously-skip-permissions");
    expect(refused([...BASE, "--dangerously-skip-permissions"], { render: { hooks: "ask" } })).toBe("Cloud engine argument is not allowed: --dangerously-skip-permissions");
    expect(refused([...BASE, "--log-file", LOG])).toBe("Cloud engine argument is not allowed: --log-file");
    expect(rig.plan(rig.request("antigravity", { args: relayArgs(), render: { hooks: RELAY } })).error).toBeUndefined();
    expect(refused(relayArgs().map(a => (a === LOG ? "/data/broker/other.log" : a)), { render: { hooks: RELAY } })).toBe("Cloud engine argument is not allowed: --log-file");
    expect(rig.plan(rig.request("antigravity", { args: [...BASE, "--mode", "accept-edits"] })).error).toBeUndefined();
  });
  it("binds /data/broker into an agy turn (the relay socket and log live there), as for Claude", () => {
    expect(readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8")).toContain('if engine in ("claudeAgent", "antigravity") and os.path.isdir(BROKER_DIR):');
  });
  // all four customization roots the server's hook-load check scans (ANTIGRAVITY_WORKSPACE_ROOTS)
  const ROOTS = [".agents", ".agent", "_agents", "_agent"];
  const MASK_FILES = ROOTS.flatMap(root => [`${root}/hooks.json`, `${root}/plugins.json`]), MASK_DIRS = ROOTS.flatMap(root => [`${root}/plugins`, `${root}/agents`]);
  it("masks the same four roots the server's hook-load check scans, in step with ANTIGRAVITY_WORKSPACE_ROOTS", () => {
    expect(ROOTS).toEqual([...ANTIGRAVITY_WORKSPACE_ROOTS]);
    expect(JSON.parse(rig.py(`print(json.dumps([list(m.AGY_ROOTS), list(m.AGY_PROJECT_FILE_MASKS), list(m.AGY_PROJECT_DIR_MASKS)]))`))).toEqual([ROOTS, MASK_FILES, MASK_DIRS]);
  });
  it("masks only the files and directories agy reads hooks from in <cwd>/.agents and each --add-dir's, so a repository cannot add or replace a hook", () => {
    const cwd = `${rig.workspaces}/ws/proj`, extra = `${rig.workspaces}/other`;
    mkdirSync(extra, { recursive: true });
    const plan = ok(rig.request("antigravity", { cwd, args: relayArgs("--add-dir", extra), render: { hooks: RELAY } }));
    for (const dir of [cwd, extra]) {
      for (const name of MASK_FILES) expect([name, plan.files[`${dir}/${name}`]]).toEqual([name, "{}\n"]);
      for (const name of MASK_DIRS) expect(plan.tmpfs).toContain(`${dir}/${name}`);
    }
  });
  it("leaves the rest of .agents visible: other files, skills and rules are not masked", () => {
    const cwd = `${rig.workspaces}/ws/proj`, extra = `${rig.workspaces}/other`;
    mkdirSync(`${cwd}/.agents/skills/x`, { recursive: true }); writeFileSync(`${cwd}/.agents/other.md`, "keep");
    mkdirSync(extra, { recursive: true });
    const plan = ok(rig.request("antigravity", { cwd, args: relayArgs("--add-dir", extra), render: { hooks: RELAY } }));
    expect(plan.tmpfs).not.toContain(`${cwd}/.agents`);
    expect(plan.tmpfs).not.toContain(`${extra}/.agents`);
    const inWorkspace = [...plan.tmpfs, ...Object.keys(plan.files)].filter(path => path.startsWith(`${rig.workspaces}/`) && ROOTS.some(root => path.includes(`/${root}/`)));
    expect(inWorkspace.sort()).toEqual([cwd, extra].flatMap(dir => [...MASK_DIRS, ...MASK_FILES].map(name => `${dir}/${name}`)).sort());
    for (const root of ROOTS.slice(1)) expect(plan.tmpfs).not.toContain(`${cwd}/${root}`);
    for (const visible of [`${cwd}/.agents/other.md`, `${cwd}/.agents/skills/x`, `${cwd}/.agents/skills/x/SKILL.md`, `${cwd}/.agents/rules/a.md`])
      expect(inWorkspace.some(mask => visible === mask || visible.startsWith(`${mask}/`))).toBe(false);
    expect(readFileSync(`${cwd}/.agents/other.md`, "utf8")).toBe("keep");
  });
  it("masks the hook paths whether or not they exist, and refuses one that is a directory", () => {
    const cwd = `${rig.workspaces}/ws/proj`;
    const absent = ok(rig.request("antigravity", { cwd, args: relayArgs(), render: { hooks: RELAY } }));
    for (const root of ROOTS) expect(absent.files[`${cwd}/${root}/hooks.json`]).toBe("{}\n");
    mkdirSync(`${cwd}/.agents`, { recursive: true }); writeFileSync(`${cwd}/.agents/hooks.json`, '{"evil":{}}');
    const present = ok(rig.request("antigravity", { cwd, args: relayArgs(), render: { hooks: RELAY } }));
    expect(present.files[`${cwd}/.agents/hooks.json`]).toBe("{}\n");
    rmSync(`${cwd}/.agents/hooks.json`); mkdirSync(`${cwd}/.agents/hooks.json`);
    expect(rig.plan(rig.request("antigravity", { cwd, args: relayArgs(), render: { hooks: RELAY } })).error).toBe("Cloud turn mask path is a directory: hooks.json");
  });
  it("masks nothing under .agents for another engine (a customer repo keeps its skills there)", () => {
    const cwd = `${rig.workspaces}/ws/proj`;
    const plan = ok(rig.request("claudeAgent", { cwd }));
    expect([...plan.tmpfs, ...Object.keys(plan.files)].filter(path => path.includes("/.agents"))).toEqual([]);
  });
});

describe("agy environment", () => {
  it("pins AGY_CLI_DISABLE_AUTO_UPDATE=true over any request value and allows no key variable", () => {
    const out = JSON.parse(rig.py(`
env, _ = m.engine_environment("antigravity", "/fixture/engine-homes/antigravity", {"AGY_CLI_DISABLE_AUTO_UPDATE": "0", "GEMINI_API_KEY": "x"})
print(json.dumps(env))`));
    expect(out.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(out.GEMINI_API_KEY).toBeUndefined();
  });
});

describe("agy rendered config", () => {
  it("renders the MCP stanzas into ~/.gemini/config/mcp_config.json and nothing else without a hook", () => {
    const plan = ok(rig.request("antigravity", { render: { mcp: { muragebox: { proxy: "permission", socket } } } }));
    const home = rig.home("antigravity");
    const config = JSON.parse(plan.files[`${home}/.gemini/config/mcp_config.json`]);
    expect(Object.keys(config.mcpServers)).toEqual(["muragebox"]);
    expect(config.mcpServers.muragebox.command).toBe("/usr/local/bin/node");
    expect(plan.files[`${home}/.gemini/config/hooks.json`]).toBeUndefined();
  });
  it("renders the Ask hook as a fixed Murage file, equal to the driver's, when the turn asks for it", () => {
    const plan = ok(rig.request("antigravity", { render: { hooks: "ask" } }));
    const home = rig.home("antigravity");
    const hooks = JSON.parse(plan.files[`${home}/.gemini/config/hooks.json`]);
    const command: string = hooks["murage-ask-stop"].PreToolUse[0].hooks[0].command;
    expect(command).toBe(`"/usr/local/bin/node" "${home}/.gemini/config/murage-ask-hook.cjs"`);
    expect(plan.files[`${home}/.gemini/config/murage-ask-hook.cjs`]).toBe(ANTIGRAVITY_ASK_HOOK_SOURCE);
  });
  it("refuses an unknown hook profile, an mcp render on another engine's hook part, and hooks on other engines", () => {
    expect(rig.plan(rig.request("antigravity", { render: { hooks: "anything" } })).error).toBe("Cloud turn render hooks is not allowed");
    expect(rig.plan(rig.request("grokAgent", { render: { hooks: "ask" } })).error).toContain("Cloud turn render part is not allowed");
  });
});

describe("agy sign-in", () => {
  it("runs bare agy in a pty with a scripted first Enter, per bot, and pins the no-update variable", () => {
    const out = JSON.parse(rig.py(`
turn = m.validate_login_request({"mode":"login","engine":"antigravity","action":"login","bot":"bot-atlas","pty":True})
print(json.dumps({"turn": turn, "first": m.LOGIN_FIRST_INPUT.get("antigravity"), "label": m.LOGIN_LABEL["antigravity"]}))`));
    expect(out.turn).toMatchObject({ engine: "antigravity", command: "/opt/murage/bin/agy", args: [], bot: "bot-atlas", pty: true });
    expect(out.turn.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(out.first).toBe("\r");
    expect(out.label).toBe("Antigravity");
  });
});

describe("agy token persistence", () => {
  const TOKEN = ".gemini/antigravity-cli/antigravity-oauth-token";
  it("stages the bot's signed-in token into the turn, and publishes a token the sign-in wrote", () => {
    const staged = rig.turn({ engine: "antigravity", args: BASE, before: signinStore("antigravity", { [TOKEN]: '{"access_token":"a","refresh_token":"r"}' }) });
    expect(staged.turnFiles[TOKEN]).toBe('{"access_token":"a","refresh_token":"r"}');
    const login = rig.turn({ engine: "antigravity", args: BASE, login: true, during: { [TOKEN]: '{"access_token":"b"}', ".gemini/antigravity-cli/cache/antigravity-keyring-unavailable": "" } });
    expect(login.published).toEqual([{ engine: "antigravity", bot: expect.any(String), files: { [TOKEN]: '{"access_token":"b"}' }, kind: "signin" }]);
  });
  it("accepts text only: a binary or empty or huge token file is refused", () => {
    const out = JSON.parse(rig.py(`print(json.dumps([m.STATE_SHAPES["agy-token"](b"\\x00abc") is None, m.STATE_SHAPES["agy-token"](b"") is None, m.STATE_SHAPES["agy-token"](b"x"*70000) is None, m.STATE_SHAPES["agy-token"](b'{"a":1}') is not None]))`));
    expect(out).toEqual([true, true, true, true]);
  });
  it("is part of recovery cleanup and the backup excludes (.gemini is excluded whole)", () => {
    const out = JSON.parse(rig.py(`print(json.dumps(m.RECOVERY_CREDENTIALS["antigravity"]))`));
    expect(out).toEqual([TOKEN]);
    expect(readFileSync(new URL("../../deploy/cloud-home/backup-excludes.txt", import.meta.url), "utf8")).toMatch(/^\.gemini$/m);
  });
});
void execFileSync; void launcher;
