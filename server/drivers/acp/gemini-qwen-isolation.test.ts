// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Gemini and Qwen bot turns: Murage's own MCP servers present, the owner's personal setup out.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import { recordEvents } from "../../testing/events.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { GEMINI_LOGIN_ENTRIES, filterGeminiSettings, isolateGeminiFromPersonalSetup } from "./gemini-isolation.ts";
import { SCOPE_MARKER, ScopeUnavailableError, SCOPE_RETIRE_MAX_AGE_MS, SCOPE_RETIRE_MAX_COUNT, scopedCliHomeRoot, resetScopeBookkeeping, retireScopes, setScopeRetentionHooks } from "../scoped-cli-home.ts";
import { QwenAgentDriver, qwenIsolationArgs } from "./qwen.ts";
import { qwenSettingsJson } from "../../flux-memory-headers.ts";
import { resetVersionProbeBackoff } from "../isolation-cache.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) removeTempDirSync(home); });

function geminiHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-gemini-iso-"));
  homes.push(home);
  const g = join(home, ".gemini");
  for (const dir of ["extensions/myext", "skills/mine", "agents", "commands", "policies", "history", "tmp"]) mkdirSync(join(g, dir), { recursive: true });
  writeFileSync(join(g, "settings.json"), JSON.stringify({
    mcpServers: { "personal-a": { command: "x" } },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
    security: { auth: { selectedType: "oauth-personal" } },
    model: { name: "gemini-3.7-flash" },
  }));
  writeFileSync(join(g, "GEMINI.md"), "personal rules");
  writeFileSync(join(g, "AGENTS.md"), "personal agents");
  writeFileSync(join(g, "oauth_creds.json"), "LOGIN-FIXTURE");
  writeFileSync(join(g, "installation_id"), "id");
  return home;
}

describe("Gemini personal setup isolation", () => {
  it("scopes GEMINI_CLI_HOME: login and state linked through, personal items absent, settings keep auth but lose servers and hooks", () => {
    const home = geminiHome();
    ensureDirs();
    const env: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(env);
    const scoped = env.GEMINI_CLI_HOME!;
    expect(scoped).toBeTruthy();
    expect(scoped.startsWith(home)).toBe(false);
    const g = join(scoped, ".gemini");
    for (const gone of ["extensions", "skills", "agents", "commands", "policies", "GEMINI.md", "AGENTS.md"]) expect(existsSync(join(g, gone)), gone).toBe(false);
    expect(readFileSync(join(g, "oauth_creds.json"), "utf8")).toBe("LOGIN-FIXTURE");
    // history and sessions are the bot's own, not the owner's folders linked through
    expect(existsSync(join(g, "history"))).toBe(false);
    expect(existsSync(join(g, "tmp"))).toBe(false);
    expect(lstatSync(join(g, "oauth_creds.json")).isSymbolicLink()).toBe(true);
    const settings = JSON.parse(readFileSync(join(g, "settings.json"), "utf8"));
    expect(settings).toEqual({ security: { auth: { selectedType: "oauth-personal" } }, model: { name: "gemini-3.7-flash" } });
    // the owner's files are untouched
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers["personal-a"]).toEqual({ command: "x" });
    expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toBe("personal rules");
    // the same home gives the same scope, and a new login file or a settings edit keeps it (no rotation)
    const again: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(again);
    expect(again.GEMINI_CLI_HOME).toBe(scoped);
    writeFileSync(join(home, ".gemini", "google_accounts.json"), "{}");
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ model: { name: "gemini-3.8" }, mcpServers: { x: { command: "y" } } }));
    const later: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(later);
    expect(later.GEMINI_CLI_HOME).toBe(scoped);
    expect(readFileSync(join(scoped, ".gemini", "google_accounts.json"), "utf8")).toBe("{}");
    expect(JSON.parse(readFileSync(join(g, "settings.json"), "utf8"))).toEqual({ model: { name: "gemini-3.8" } });
  });

  it("stable per-bot state: what Gemini wrote in a scope survives a settings edit, a first sign-in lands in the owner's folder, and bots do not share state", () => {
    const home = geminiHome();
    ensureDirs();
    const real = join(home, ".gemini");
    rmSync(join(real, "oauth_creds.json"));
    const a: Record<string, string | undefined> = { HOME: home };
    const b: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(a, "bot-a");
    isolateGeminiFromPersonalSetup(b, "bot-b");
    expect(a.GEMINI_CLI_HOME).not.toBe(b.GEMINI_CLI_HOME);
    const ga = join(a.GEMINI_CLI_HOME!, ".gemini"), gb = join(b.GEMINI_CLI_HOME!, ".gemini");
    // the login destination is linked BEFORE it exists: a first sign-in made through the scope lands in the owner's folder
    expect(lstatSync(join(ga, "oauth_creds.json")).isSymbolicLink()).toBe(true);
    writeFileSync(join(ga, "oauth_creds.json"), "FIRST-SIGN-IN");
    expect(readFileSync(join(real, "oauth_creds.json"), "utf8")).toBe("FIRST-SIGN-IN");
    expect(readFileSync(join(gb, "oauth_creds.json"), "utf8")).toBe("FIRST-SIGN-IN");
    // state written inside bot A's scope stays with bot A, across a settings change
    mkdirSync(join(ga, "tmp", "chats"), { recursive: true });
    writeFileSync(join(ga, "tmp", "chats", "s1.json"), "SESSION-A");
    writeFileSync(join(real, "settings.json"), JSON.stringify({ model: { name: "other" } }));
    const again: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(again, "bot-a");
    expect(again.GEMINI_CLI_HOME).toBe(a.GEMINI_CLI_HOME);
    expect(readFileSync(join(ga, "tmp", "chats", "s1.json"), "utf8")).toBe("SESSION-A");
    expect(existsSync(join(gb, "tmp", "chats"))).toBe(false);
    expect(JSON.parse(readFileSync(join(ga, "settings.json"), "utf8"))).toEqual({ model: { name: "other" } });
    // a probe's shared scope is replaced by the bot's own on a bot turn
    const probe: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(probe);
    expect(probe.GEMINI_CLI_HOME).not.toBe(a.GEMINI_CLI_HOME);
    isolateGeminiFromPersonalSetup(probe, "bot-a");
    expect(probe.GEMINI_CLI_HOME).toBe(a.GEMINI_CLI_HOME);
  });

  it("retires unused scopes with limits: a long-idle one goes (its stranded login saved first), a recently used one stays", () => {
    const home = geminiHome();
    ensureDirs();
    resetScopeBookkeeping();
    setScopeRetentionHooks({ botExists: (id) => id === "live-bot" });
    const real = join(home, ".gemini");
    rmSync(join(real, "oauth_creds.json"));
    const stale: Record<string, string | undefined> = { HOME: home };
    const fresh: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(stale, "gone-bot");
    isolateGeminiFromPersonalSetup(fresh, "live-bot");
    // the gone bot's Gemini replaced the (still absent) login with a real file instead of writing through the link
    const login = join(stale.GEMINI_CLI_HOME!, ".gemini", "oauth_creds.json");
    rmSync(login);
    writeFileSync(login, "STRANDED-LOGIN");
    const day = 24 * 3_600_000;
    const old = new Date(Date.now() - (SCOPE_RETIRE_MAX_AGE_MS + day));
    utimesSync(join(stale.GEMINI_CLI_HOME!, SCOPE_MARKER), old, old);
    const recent = new Date(Date.now() - 2 * day);
    utimesSync(join(fresh.GEMINI_CLI_HOME!, SCOPE_MARKER), recent, recent);
    const retired = retireScopes("gemini", fresh.GEMINI_CLI_HOME!, Date.now(), true);
    expect(retired).toEqual([stale.GEMINI_CLI_HOME]);
    expect(existsSync(stale.GEMINI_CLI_HOME!)).toBe(false);
    expect(existsSync(fresh.GEMINI_CLI_HOME!)).toBe(true);
    expect(readFileSync(join(real, "oauth_creds.json"), "utf8")).toBe("STRANDED-LOGIN");
    // a count limit: the least recently used beyond it go, but none used within the last day
    const ids: string[] = [];
    for (let i = 0; i < SCOPE_RETIRE_MAX_COUNT + 6; i++) {
      const env: Record<string, string | undefined> = { HOME: home };
      isolateGeminiFromPersonalSetup(env, `bulk-${i}`);
      ids.push(env.GEMINI_CLI_HOME!);
      const when = new Date(Date.now() - 2 * day - i * 3_600_000);
      utimesSync(join(env.GEMINI_CLI_HOME!, SCOPE_MARKER), when, when);
    }
    const dayOld = ids[0]!;
    utimesSync(join(dayOld, SCOPE_MARKER), new Date(), new Date());
    retireScopes("gemini", fresh.GEMINI_CLI_HOME!, Date.now(), true);
    const left = ids.filter((path) => existsSync(path));
    expect(left.length).toBeLessThanOrEqual(SCOPE_RETIRE_MAX_COUNT);
    expect(existsSync(dayOld)).toBe(true);
    expect(existsSync(ids[ids.length - 1]!)).toBe(false); // the least recently used
  });

  it("settings: an owner's allow/deny lists, server command and tool commands cannot start theirs or drop Murage's", () => {
    const owner = {
      mcpServers: { "personal-db": { command: "db" } },
      mcp: { allowed: ["personal-db"], excluded: ["agents", "murage-memory"], serverCommand: "personal-mcp-config", keep: 1 },
      tools: { discoveryCommand: "disc", callCommand: "call", core: ["read_file"], exclude: ["run_shell_command", "mcp_agents_ask_bot"], sandbox: true },
      context: { fileName: "PERSONAL.md", includeDirectories: ["/home/o/notes"], loadMemoryFromIncludeDirectories: true, other: "x" },
      hooks: { SessionStart: [] }, hooksConfig: { enabled: true }, policyPaths: ["/home/o/p.toml"], admin: { mcp: { enabled: false } },
      security: { auth: { selectedType: "oauth-personal" } }, model: { name: "m" },
    };
    expect(filterGeminiSettings(owner)).toEqual({
      mcp: { keep: 1 },
      tools: { exclude: ["run_shell_command"], sandbox: true },
      context: { other: "x" },
      security: { auth: { selectedType: "oauth-personal" } }, model: { name: "m" },
    });
    // the scoped settings.json carries the filtered copy; the owner's own file keeps every byte
    const home = geminiHome();
    ensureDirs();
    const path = join(home, ".gemini", "settings.json");
    writeFileSync(path, JSON.stringify(owner));
    const env: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(env);
    const scoped = JSON.parse(readFileSync(join(env.GEMINI_CLI_HOME!, ".gemini", "settings.json"), "utf8"));
    expect(scoped.mcp).toEqual({ keep: 1 });
    expect(JSON.stringify(scoped)).not.toMatch(/personal-db|personal-mcp-config|disc|PERSONAL\.md|notes/);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(owner));
  });

  it("scopes even with no ~/.gemini yet (empty settings, no login links, nothing written to the owner's home); an unreadable settings.json is scoped with empty settings", () => {
    ensureDirs();
    const empty = mkdtempSync(join(tmpdir(), "murage-gemini-none-"));
    homes.push(empty);
    const a: Record<string, string | undefined> = { HOME: empty };
    isolateGeminiFromPersonalSetup(a, "bot-first", true);
    expect(a.GEMINI_CLI_HOME!.startsWith(scopedCliHomeRoot("gemini"))).toBe(true);
    expect(JSON.parse(readFileSync(join(a.GEMINI_CLI_HOME!, ".gemini", "settings.json"), "utf8"))).toEqual({});
    // a first bot turn writes only into its scope: no dangling login links into a folder that is not there, nothing in the owner's home
    for (const login of GEMINI_LOGIN_ENTRIES) expect(existsSync(join(a.GEMINI_CLI_HOME!, ".gemini", login))).toBe(false);
    expect(existsSync(join(empty, ".gemini"))).toBe(false);
    const broken = geminiHome();
    writeFileSync(join(broken, ".gemini", "settings.json"), "{ not json");
    const b: Record<string, string | undefined> = { HOME: broken };
    isolateGeminiFromPersonalSetup(b);
    // never left to Gemini's own (owner's) folder: the scope carries empty settings
    expect(b.GEMINI_CLI_HOME!.startsWith(scopedCliHomeRoot("gemini"))).toBe(true);
    expect(readFileSync(join(b.GEMINI_CLI_HOME!, ".gemini", "settings.json"), "utf8")).not.toContain("not json");
  });

  it("an explicit GEMINI_CLI_HOME is the SOURCE that gets scoped, never passed through to a bot", () => {
    ensureDirs();
    const owner = mkdtempSync(join(tmpdir(), "murage-gemini-explicit-"));
    homes.push(owner);
    mkdirSync(join(owner, ".gemini"), { recursive: true });
    writeFileSync(join(owner, ".gemini", "settings.json"), JSON.stringify({ model: "m", mcpServers: { personal: { command: "x" } }, hooks: { a: 1 } }));
    writeFileSync(join(owner, ".gemini", "oauth_creds.json"), "EXPLICIT-LOGIN");
    writeFileSync(join(owner, ".gemini", "GEMINI.md"), "PERSONAL");
    const elsewhere = geminiHome(); // HOME has its own, different .gemini that must NOT be the source
    const probe: Record<string, string | undefined> = { HOME: elsewhere, GEMINI_CLI_HOME: owner };
    isolateGeminiFromPersonalSetup(probe);
    const bot: Record<string, string | undefined> = { HOME: elsewhere, GEMINI_CLI_HOME: owner };
    isolateGeminiFromPersonalSetup(bot, "bot-x", true);
    for (const env of [probe, bot]) {
      expect(env.GEMINI_CLI_HOME).not.toBe(owner);
      expect(env.GEMINI_CLI_HOME!.startsWith(scopedCliHomeRoot("gemini"))).toBe(true);
    }
    const g = join(bot.GEMINI_CLI_HOME!, ".gemini");
    expect(JSON.parse(readFileSync(join(g, "settings.json"), "utf8"))).toEqual({ model: "m" });
    expect(readFileSync(join(g, "oauth_creds.json"), "utf8")).toBe("EXPLICIT-LOGIN"); // linked to the explicit home's login
    expect(existsSync(join(g, "GEMINI.md"))).toBe(false);
    // the probe's shared scope was built from the same source, so the bot's rebuild keeps it even though the env named the scope
    const rebuilt: Record<string, string | undefined> = { HOME: elsewhere, GEMINI_CLI_HOME: probe.GEMINI_CLI_HOME };
    isolateGeminiFromPersonalSetup(rebuilt, "bot-x", true);
    expect(rebuilt.GEMINI_CLI_HOME).toBe(bot.GEMINI_CLI_HOME);
    // the owner's explicit folder is untouched
    expect(readFileSync(join(owner, ".gemini", "GEMINI.md"), "utf8")).toBe("PERSONAL");
    expect(JSON.parse(readFileSync(join(owner, ".gemini", "settings.json"), "utf8")).mcpServers).toBeTruthy();
  });

  it("a bot turn spawns with the scoped home and still mounts Murage's servers", async () => {
    ensureDirs();
    const home = geminiHome();
    const dump = join(home, "spawn.json");
    const instance = await GeminiAgentDriver.create({ instanceId: "gem-iso", displayName: "Gemini", enabled: true,
      config: GeminiAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, GEMINI_API_KEY: "fixture-only", FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model" } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "gem-1", text: "hello", cwd: home,
        integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} } } });
      await recorder.until((event) => event.threadId === "gem-1" && event.type === "turn.completed", 15000);
      const spawned = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
      expect(spawned.env.GEMINI_CLI_HOME).toBeTruthy();
      expect(spawned.env.GEMINI_CLI_HOME).not.toBe(home);
      const mounted = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ args: string[] }>;
      expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30000);
});

describe("Qwen personal setup isolation", () => {
  it("allows only the servers Murage mounts, drops extensions and skills, and fails open on an unknown or old CLI", () => {
    expect(qwenIsolationArgs(["agents", "computer"], "0.15.6")).toEqual([
      "--allowed-mcp-server-names=agents", "--allowed-mcp-server-names=computer", "-e", "none", "--exclude-tools=skill", "--approval-mode", "default",
    ]);
    // no Murage servers: a name nothing matches, because an empty allow list means every server
    expect(qwenIsolationArgs([], "0.10.0")).toEqual(["--allowed-mcp-server-names=murage-no-servers", "-e", "none", "--exclude-tools=skill", "--approval-mode", "default"]);
    expect(qwenIsolationArgs(undefined, "1.2.3")[0]).toBe("--allowed-mcp-server-names=murage-no-servers");
    // fails closed: an older, unknown or unreadable Qwen is rejected (update-required), never started without the switches
    for (const version of ["0.9.9", undefined, "not a version"]) {
      let error: unknown = null;
      try { qwenIsolationArgs(["a"], version); } catch (e) { error = e; }
      expect(error, String(version)).toBeInstanceOf(ScopeUnavailableError);
      expect((error as ScopeUnavailableError).code).toBe("update-required");
      expect((error as ScopeUnavailableError).engine).toBe("Qwen");
    }
  });

  // Real-engine gate (Linux, qwen 0.25.3, 2026-10-21): at Ask, qwen ran `echo GATE-APPROVE-...` and the host computer's
  // click with no card and no session/request_permission. Its own chat log records every one of those turns with
  // `"executionContext":{"modelId":"flux-auto","authType":"openai","approvalMode":"auto"}`: Qwen's classifier mode,
  // where Qwen's own model call decides and only a classifier "block" reaches Murage. The real CLI on a probe did the
  // same (classifier answered {"shouldBlock":false}: the shell ran, nothing was asked). Murage must decide every call.
  it("every bot turn runs Qwen in its ask mode (approval mode default), never its own auto classifier", async () => {
    expect(qwenIsolationArgs(["agents"], "0.25.3")).toEqual(expect.arrayContaining(["--approval-mode", "default"]));
    const at = qwenIsolationArgs(["agents"], "0.25.3").indexOf("--approval-mode");
    expect(qwenIsolationArgs(["agents"], "0.25.3")[at + 1]).toBe("default");
  });

  it("turns the owner's hooks off in the system settings file", () => {
    expect(JSON.parse(qwenSettingsJson()).disableAllHooks).toBe(true);
  });

  it("a bot turn on a current Qwen spawns with the switches and Murage's server names", async () => {
    ensureDirs();
    const home = mkdtempSync(join(tmpdir(), "murage-qwen-iso-"));
    homes.push(home);
    const dump = join(home, "spawn.json");
    const instance = await QwenAgentDriver.create({ instanceId: "qwen-iso", displayName: "Qwen", enabled: true,
      config: QwenAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_VERSION: "0.15.6", FAKE_ACP_MCP_READY: "1" } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "qwen-1", text: "hello", cwd: home,
        integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} } } });
      await recorder.until((event) => event.threadId === "qwen-1" && event.type === "turn.completed", 15000);
      const spawned = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
      const mounted = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; args: string[] }>;
      expect(spawned.argv.slice(0, 2)).toEqual(["--acp", `--allowed-mcp-server-names=${mounted[0]!.name}`]);
      expect(spawned.argv).toEqual(expect.arrayContaining(["-e", "none", "--exclude-tools=skill"]));
      expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30000);

  it("a CLI whose --version fails is probed once more, and a bot turn is then rejected before any spawn (update-required), not run without the switches", async () => {
    ensureDirs();
    resetVersionProbeBackoff();
    const home = mkdtempSync(join(tmpdir(), "murage-qwen-probe-"));
    homes.push(home);
    const probes = join(home, "probes.log");
    const dump = join(home, "dump.json");
    const instance = await QwenAgentDriver.create({ instanceId: "qwen-probe", displayName: "Qwen", enabled: true,
      config: QwenAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: home, FAKE_ACP_MODE: "happy", FAKE_ACP_VERSION_FAIL: "1", FAKE_ACP_VERSION_LOG: probes, FAKE_ACP_MCP_READY: "1", FAKE_ACP_DUMP: dump } });
    const count = () => (existsSync(probes) ? readFileSync(probes, "utf8").split("\n").filter(Boolean).length : 0);
    try {
      const error = await instance.adapter.sendTurn({ threadId: "qp-1", text: "hello", cwd: home }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ScopeUnavailableError);
      expect(error).toMatchObject({ code: "update-required", engine: "Qwen" });
      expect(count()).toBe(2); // the turn's probe and ONE retry
      expect(existsSync(dump) && "initialize" in JSON.parse(readFileSync(dump, "utf8"))).toBe(false); // nothing was spawned
    } finally { await instance.dispose(); }
  }, 45000);
});
