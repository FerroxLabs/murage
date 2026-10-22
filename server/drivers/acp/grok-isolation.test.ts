// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Grok bot turns load Murage's own MCP servers and none of the owner's personal setup
// (grok.ts GROK_EXTERNAL_COMPAT_GATES, grokIsolationArgs). Synthetic owner home only.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recordEvents } from "../../testing/events.ts";
import { ensureDirs } from "../../config.ts";
import { isolationStats, resetIsolationCache } from "../isolation-cache.ts";
import { ScopeUnavailableError } from "../scoped-cli-home.ts";
import { filterGrokConfigToml, scopeGrokHome } from "./grok-scope.ts";
import { GROK_EXTERNAL_COMPAT_GATES, GrokAgentDriver, grokIsolationArgs, grokPersonalPluginNames, isolateGrokFromPersonalSetup } from "./grok.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTempDirSync(home); });

/** An owner home with personal plugins in every place grok looks, plus noise it must skip. */
function ownerHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-grok-iso-"));
  homes.push(home);
  const claude = join(home, ".claude"), plugins = join(claude, "plugins");
  const install = join(plugins, "cache", "mkt", "renamed-dir", "1.0.0");
  mkdirSync(join(install, ".claude-plugin"), { recursive: true });
  writeFileSync(join(install, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "manifest-name" }));
  writeFileSync(join(install, ".mcp.json"), JSON.stringify({ mcpServers: { personal: { command: "personal-mcp" } } }));
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ enabledPlugins: { "context7@claude-plugins-official": true, "bad name!@x": true }, hooks: { SessionStart: [] } }));
  writeFileSync(join(claude, "settings.local.json"), JSON.stringify({ enabledPlugins: { "local-only@mkt": true } }));
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "installed-id@mkt": [{ scope: "user", installPath: install }] } }));
  mkdirSync(join(plugins, "loose", ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugins, "loose", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "loose-plugin" }));
  writeFileSync(join(claude, "CLAUDE.md"), "PERSONAL INSTRUCTIONS");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { tradingview: { command: "tv" } } }));
  const grok = join(home, ".grok");
  mkdirSync(join(grok, "plugins", "native", ".grok-plugin"), { recursive: true });
  writeFileSync(join(grok, "plugins", "native", ".grok-plugin", "plugin.json"), JSON.stringify({ name: "grok-native" }));
  writeFileSync(join(grok, "config.toml"), '[models]\ndefault = "grok-4.7"\n\n[plugins]\nenabled = [\n  "user/a1b2c3d4/market-plugin",\n  "plain",\n]\n\n[ui]\nyolo = false\n');
  writeFileSync(join(grok, "auth.json"), "{}");
  return home;
}

describe("grok personal setup isolation", () => {
  it("closes every Claude, Cursor and Codex compat cell and memory, keeping an explicit owner choice", () => {
    const env: Record<string, string | undefined> = { GROK_CLAUDE_MCPS_ENABLED: "1" };
    isolateGrokFromPersonalSetup(env);
    expect(GROK_EXTERNAL_COMPAT_GATES).toHaveLength(18);
    for (const name of GROK_EXTERNAL_COMPAT_GATES) expect(env[name]).toBe(name === "GROK_CLAUDE_MCPS_ENABLED" ? "1" : "0");
    expect(env.GROK_MEMORY).toBe("0");
    const owner: Record<string, string | undefined> = { GROK_MEMORY: "1" };
    isolateGrokFromPersonalSetup(owner);
    expect(owner.GROK_MEMORY).toBe("1"); // --no-memory on argv still wins over it
  });

  it("finds the owner's plugins wherever grok discovers them, and only valid names", () => {
    const home = ownerHome();
    expect(grokPersonalPluginNames({ HOME: home })).toEqual(
      ["context7", "grok-native", "installed-id", "local-only", "loose-plugin", "manifest-name", "market-plugin", "plain"]);
    expect(grokPersonalPluginNames({ HOME: join(home, "absent") })).toEqual([]);
  });

  it("shadows each personal plugin with an empty Murage stub, only on a CLI that has the flags", () => {
    const home = ownerHome();
    const args = grokIsolationArgs({ HOME: home }, "grok 1.0.50 (c58f321264ba)");
    expect(args[0]).toBe("--no-leader");
    const dirs = args.filter((_, i) => args[i - 1] === "--plugin-dir");
    expect(dirs).toHaveLength(8);
    for (const dir of dirs) {
      expect(dir.startsWith(home)).toBe(false);
      const manifest = JSON.parse(readFileSync(join(dir, ".grok-plugin", "plugin.json"), "utf8"));
      expect(dir.endsWith(manifest.name)).toBe(true);
    }
    // below the shadowing floor only the local-agent flag; fail open on an unknown or pre-1.0 CLI
    expect(grokIsolationArgs({ HOME: home }, "grok 1.0.49 (x)")).toEqual(["--no-leader"]);
    expect(grokIsolationArgs({ HOME: home }, "grok 1.1.0")).toContain("--plugin-dir");
    expect(grokIsolationArgs({ HOME: home }, "")).toEqual([]);
    expect(grokIsolationArgs({ HOME: home }, "grok 0.1.150")).toEqual([]);
  });

  it("spawns a bot turn with Murage's servers and none of the owner's setup", async () => {
    const home = ownerHome();
    const dump = join(home, "spawn.json");
    const instance = await GrokAgentDriver.create({ instanceId: "grok-iso", displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: "grok 1.0.50 (fixture)",
        // Grok gates its first prompt on the MCP-ready announcement (grok.ts mcpReadyNotification), so the fixture sends it.
        FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "grok-iso-1", text: "hello", cwd: home,
        integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, memory: { command: process.execPath, args: ["fixture-memory"], env: {} } } });
      await recorder.until((event) => event.threadId === "grok-iso-1" && event.type === "turn.completed", 15000);
      const spawned = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
      for (const name of GROK_EXTERNAL_COMPAT_GATES) expect(spawned.env[name]).toBe("0");
      expect(spawned.env.GROK_MEMORY).toBe("0");
      expect(spawned.argv).toContain("--no-memory");
      const agent = spawned.argv.indexOf("agent"), stdio = spawned.argv.indexOf("stdio");
      expect(spawned.argv.indexOf("--no-leader")).toBeGreaterThan(agent);
      // grok's own plugins folder is absent from the scoped GROK_HOME; the rest are shadowed
      const shadows = spawned.argv.flatMap((arg, i) => arg === "--plugin-dir" ? [i] : []);
      expect(shadows).toHaveLength(7);
      // native ~/.grok setup out through a scoped GROK_HOME whose login links to the owner's
      const scoped = spawned.env.GROK_HOME!;
      expect(scoped).toBeTruthy();
      expect(scoped.startsWith(home)).toBe(false);
      expect(readlinkSync(join(scoped, "auth.json"))).toBe(join(home, ".grok", "auth.json"));
      expect(existsSync(join(scoped, "plugins"))).toBe(false);
      for (const i of shadows) { expect(i).toBeGreaterThan(agent); expect(i).toBeLessThan(stdio); }
      const mounted = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; args: string[] }>;
      expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
      expect(mounted.some((server) => server.args.includes("fixture-memory"))).toBe(true);
      expect(JSON.stringify(mounted)).not.toMatch(/tradingview|personal-mcp/);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30000);

  it("filters config.toml: no [mcp_servers.*] or hooks, everything else byte for byte", () => {
    const text = [
      "# my grok", 'theme = "dark"', 'mcp_servers = { inline = { command = "x" } }', "",
      "[models]", 'default = "fakellm"', "",
      "[model.fakellm]", 'base_url = "http://127.0.0.1:1/v1"', 'api_key = "sk-fake"', "",
      "[mcp_servers.pgrok1]", 'command = "node"', 'args = ["p.mjs"]', "",
      '[mcp_servers."quoted.name"]', 'command = "q"', "",
      "[[hooks.SessionStart]]", "[[hooks.SessionStart.hooks]]", 'type = "command"', 'command = "touch /tmp/x"', "",
      "[features]", 'note = """', "[mcp_servers.not_a_heading]", '"""', "x = 1", "",
    ].join("\n");
    const out = filterGrokConfigToml(text);
    expect(out).not.toMatch(/pgrok1|quoted\.name|SessionStart|touch|inline/);
    expect(out).toContain('[model.fakellm]\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "sk-fake"');
    expect(out).toContain('theme = "dark"');
    expect(out).toContain('[features]\nnote = """\n[mcp_servers.not_a_heading]\n"""\nx = 1');
  });

  it("filters on the parsed key: quoted and dotted spellings of mcp_servers, hooks and skills do not slip through", () => {
    const text = [
      'theme = "dark"',
      '"mcp_servers" = { personal = { command = "node" } }',
      "'hooks' = { SessionStart = [] }",
      '"mcp_servers".other.command = "x"',
      'hooks . stop . command = "touch /tmp/y"',
      "\"skills\" = { disabled = [\"a\"] }",
      'mcp_servers = {',
      '  multi = { command = "m" },',
      '}',
      'keep_me = 1',
      "",
      '["mcp_servers"."q"]', 'command = "q"', "",
      '[ "hooks" . "Stop" ]', 'command = "h"', "",
      '[["hooks"."Pre"]]', 'command = "p"', "",
      "[ui]",
      '"mcp_servers" = "this is ui.mcp_servers, not the top-level table"',
      'mcp_servers_note = "kept"',
      "",
      '[models]', 'default = "grok-4.7"', "",
    ].join("\n");
    const out = filterGrokConfigToml(text);
    expect(out).not.toMatch(/personal|SessionStart|touch|"x"|multi|command = "[qhpm]"|disabled/);
    expect(out).toContain('theme = "dark"');
    expect(out).toContain("keep_me = 1");
    expect(out).toContain('[ui]\n"mcp_servers" = "this is ui.mcp_servers, not the top-level table"\nmcp_servers_note = "kept"');
    expect(out).toContain('[models]\ndefault = "grok-4.7"');
    // a file the scanner cannot read is not copied at all
    expect(filterGrokConfigToml('mcp_servers = { a = "unterminated\n')).toBe("");
  });

  it("each bot has its own state root: one bot's sessions and files never appear for another, the login is shared", () => {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome();
    const grok = join(home, ".grok");
    mkdirSync(join(grok, "sessions"), { recursive: true });
    writeFileSync(join(grok, "sessions", "owner-session.json"), "OWNER");
    const a: Record<string, string | undefined> = { HOME: home };
    const b: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(a, "grok 1.0.50", "bot-a");
    scopeGrokHome(b, "grok 1.0.50", "bot-b");
    expect(a.GROK_HOME).toBeTruthy();
    expect(a.GROK_HOME).not.toBe(b.GROK_HOME);
    // the owner's sessions are not in either scope, and a file bot A writes is not in B's
    expect(existsSync(join(a.GROK_HOME!, "sessions"))).toBe(false);
    mkdirSync(join(a.GROK_HOME!, "sessions"));
    writeFileSync(join(a.GROK_HOME!, "sessions", "a-session.json"), "A");
    writeFileSync(join(a.GROK_HOME!, "AGENTS.md"), "BOT A WROTE THIS");
    expect(existsSync(join(b.GROK_HOME!, "sessions"))).toBe(false);
    expect(existsSync(join(b.GROK_HOME!, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(grok, "sessions", "a-session.json"))).toBe(false);
    expect(existsSync(join(grok, "AGENTS.md"))).toBe(false);
    // same bot, same scope; its own state is still there on the next turn
    resetIsolationCache();
    const again: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(again, "grok 1.0.50", "bot-a");
    expect(again.GROK_HOME).toBe(a.GROK_HOME);
    expect(readFileSync(join(again.GROK_HOME!, "sessions", "a-session.json"), "utf8")).toBe("A");
    // the login is the one shared thing: a refresh through either scope reaches the owner's real file
    expect(readlinkSync(join(a.GROK_HOME!, "auth.json"))).toBe(join(grok, "auth.json"));
    expect(readlinkSync(join(b.GROK_HOME!, "auth.json"))).toBe(join(grok, "auth.json"));
    // a turn with no bot has a root of its own
    const none: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(none, "grok 1.0.50");
    expect(none.GROK_HOME).not.toBe(a.GROK_HOME);
  });

  it("scoped GROK_HOME from 1.0.50: native personal setup out, login and sessions linked through, cached", () => {
    ensureDirs();
    resetIsolationCache();
    const home = ownerHome();
    const grok = join(home, ".grok");
    for (const dir of ["rules", "skills/s", "hooks", "sessions"]) mkdirSync(join(grok, dir), { recursive: true });
    writeFileSync(join(grok, "AGENTS.md"), "PERSONAL_GROK_AGENTS_MARKER");
    writeFileSync(join(grok, "config.toml"), '[models]\ndefault = "grok-4.7"\n\n[mcp_servers.pgrok1]\ncommand = "node"\n\n[skills]\ndisabled = ["x"]\n');
    mkdirSync(join(home, ".agents", "skills", "shared-dir"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "shared-dir", "SKILL.md"), "---\nname: shared-skill\ndescription: d\n---\nbody\n");
    // fails closed: an unknown or older grok is rejected with an update-required code, never run in the owner's own GROK_HOME
    for (const version of [undefined, "grok 1.0.49"]) {
      const refused: Record<string, string | undefined> = { HOME: home };
      expect(() => scopeGrokHome(refused, version)).toThrow(ScopeUnavailableError);
      expect(refused.GROK_HOME).toBeUndefined();
      try { scopeGrokHome(refused, version); } catch (error) { expect((error as ScopeUnavailableError).code).toBe("update-required"); expect((error as ScopeUnavailableError).engine).toBe("Grok"); }
    }
    const env: Record<string, string | undefined> = { HOME: home };
    scopeGrokHome(env, "grok 1.0.50 (abc)");
    const scoped = env.GROK_HOME!;
    for (const gone of ["AGENTS.md", "rules", "skills", "hooks", "plugins"]) expect(existsSync(join(scoped, gone)), gone).toBe(false);
    expect(readlinkSync(join(scoped, "auth.json"))).toBe(join(grok, "auth.json"));
    expect(readlinkSync(join(scoped, "auth.json.lock"))).toBe(join(grok, "auth.json.lock")); // linked before it exists
    // sessions and history are the bot's own, never the owner's folder linked through
    expect(existsSync(join(scoped, "sessions"))).toBe(false);
    expect(lstatSync(join(scoped, "config.toml")).isSymbolicLink()).toBe(false);
    // grok reads ~/.agents/skills from HOME, outside GROK_HOME: those are disabled by name in the scoped config
    expect(readFileSync(join(scoped, "config.toml"), "utf8")).toBe('[models]\ndefault = "grok-4.7"\n\n[skills]\ndisabled = ["shared-dir", "shared-skill"]\n\n[permission]\nask = ["Bash", "Edit", "Write"]\n');
    // grok refreshes the login by resolving the link and renaming onto the TARGET (rig, 1.0.50): the owner's file
    // is updated and the scoped path stays a link
    writeFileSync(join(grok, ".1.tmp"), "REFRESHED");
    renameSync(join(grok, ".1.tmp"), join(grok, "auth.json"));
    expect(readFileSync(join(scoped, "auth.json"), "utf8")).toBe("REFRESHED");
    expect(lstatSync(join(scoped, "auth.json")).isSymbolicLink()).toBe(true);
    // cached per owner setup; an explicit owner GROK_HOME is the real home, an already-scoped one is left alone
    resetIsolationCache();
    for (let i = 0; i < 20; i++) { const e: Record<string, string | undefined> = { HOME: home }; scopeGrokHome(e, "grok 1.0.50"); expect(e.GROK_HOME).toBe(scoped); }
    expect(isolationStats("grok-scope")).toEqual({ builds: 1, hits: 19 });
    const again: Record<string, string | undefined> = { HOME: home, GROK_HOME: scoped };
    scopeGrokHome(again, "grok 1.0.50");
    expect(again.GROK_HOME).toBe(scoped);
    // the owner's files are untouched
    expect(readFileSync(join(grok, "AGENTS.md"), "utf8")).toBe("PERSONAL_GROK_AGENTS_MARKER");
    expect(readFileSync(join(grok, "config.toml"), "utf8")).toContain("pgrok1");
  });
});
