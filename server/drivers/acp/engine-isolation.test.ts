// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenCode and Fuigo bot turns: Murage's own MCP servers present, the owner's personal
// setup switched off (opencode-go.ts isolateOpenCodeFromPersonalSetup, fuigo.ts transformEnv).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../../testing/events.ts";
import { FUIGO_EXTERNAL_MCP_GATES, FuigoAgentDriver } from "./fuigo.ts";
import { DroidAgentDriver, scopeDroidHome } from "./droid.ts";
import { ensureDirs } from "../../config.ts";
import { ScopeUnavailableError, scopedCliHomeRoot } from "../scoped-cli-home.ts";
import { createOpenCodeDriver, isolateOpenCodeFromPersonalSetup, isolateOpenCodeGlobalInstructions, jsoncToJson, ownerOpenCodeMcpNames } from "./opencode-go.ts";
import type { ProviderDriver } from "../../contracts.ts";
import type { AcpConfig } from "./core.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const homes: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

function ownerHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-engine-iso-"));
  homes.push(home);
  const config = join(home, ".config", "opencode");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "opencode.json"), JSON.stringify({ mcp: { tradingview: { type: "remote", url: "https://tv.example" }, agents: { type: "local", command: ["x"] } } }));
  writeFileSync(join(config, "opencode.jsonc"), '{\n  // personal\n  "mcp": { "notion": { "type": "remote", "url": "https://n.example" } }\n}\n');
  return home;
}

async function bootTurn(driver: ProviderDriver<AcpConfig>, home: string, extra: Record<string, string> = {}) {
  const dump = join(home, "spawn.json");
  const instance = await driver.create({ instanceId: "iso", displayName: "iso", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home,
      // The CLI's config folder is chosen by these two before ~/.config; pin them so a runner's own values cannot redirect the fixture.
      OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: join(home, ".config"),
      FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", ...extra } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "iso-1", text: "hello", cwd: home,
      integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, memory: { command: process.execPath, args: ["fixture-memory"], env: {} } } });
    await recorder.until((event) => event.threadId === "iso-1" && event.type === "turn.completed", 15000);
    return {
      spawned: JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> },
      mounted: JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; args: string[] }>,
    };
  } finally { recorder.stop(); await instance.dispose(); }
}

describe("OpenCode personal setup isolation", () => {
  it("reads OpenCode's JSONC (comments, trailing commas, // inside strings)", () => {
    expect(JSON.parse(jsoncToJson('{\n // c\n "a": "x//y \\" q", /* b */ "m": {"n": 1,},\n}\n'))).toEqual({ a: 'x//y " q', m: { n: 1 } });
  });

  it("lists every server in the owner's global config, whatever it is called", () => {
    expect(ownerOpenCodeMcpNames({ HOME: ownerHome() })).toEqual(["agents", "notion", "tradingview"]);
  });

  it("disables them in the overlay and keeps a Flux provider already there", () => {
    const env: Record<string, string | undefined> = { HOME: ownerHome(), OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { flux: { options: { headers: { a: "1" } } } } }), OPENCODE_PURE: "0" };
    isolateOpenCodeFromPersonalSetup(env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ provider: { flux: { options: { headers: { a: "1" } } } }, mcp: { agents: { enabled: false }, notion: { enabled: false }, tradingview: { enabled: false } } });
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(env.OPENCODE_PURE).toBe("0"); // the owner's explicit choice
  });

  it("a personal server with a reserved name (agents, computer, composio, murage-memory) is off like any other: an ACP mount is not suppressed by it", () => {
    const home = ownerHome();
    writeFileSync(join(home, ".config", "opencode", "config.json"), JSON.stringify({ mcp: { computer: { type: "local", command: ["mine"] }, composio: { type: "remote", url: "https://c.example" }, "murage-memory": { type: "local", command: ["m"] } } }));
    const env: Record<string, string | undefined> = { HOME: home };
    isolateOpenCodeFromPersonalSetup(env);
    expect(Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp).sort()).toEqual(["agents", "composio", "computer", "murage-memory", "notion", "tradingview"]);
  });

  it("keeps the owner's global AGENTS.md out with an empty OPENCODE_CONFIG_DIR, and scopes an explicit one instead of passing it through", () => {
    const env: Record<string, string | undefined> = { HOME: ownerHome() };
    isolateOpenCodeGlobalInstructions(env);
    expect(env.OPENCODE_CONFIG_DIR).toBeTruthy();
    expect(readdirSync(env.OPENCODE_CONFIG_DIR!)).toEqual([]);
    // the owner's own OPENCODE_CONFIG_DIR is the SOURCE: the bot gets a Murage-owned scope of it
    ensureDirs();
    const explicit = join(ownerHome(), "my-oc");
    mkdirSync(join(explicit, "agents"), { recursive: true });
    writeFileSync(join(explicit, "AGENTS.md"), "PERSONAL GLOBAL OPENCODE INSTRUCTIONS");
    writeFileSync(join(explicit, "agents", "mine.md"), "PERSONAL AGENT");
    writeFileSync(join(explicit, "opencode.jsonc"), '// owner config\n{ "model": "p/m", "provider": { "p": {} }, "mcp": { "personal": { "command": "x" } }, "plugin": ["evil"], "instructions": ["PERSONAL.md"], }');
    const owner: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: explicit };
    isolateOpenCodeGlobalInstructions(owner, "bot-oc");
    expect(owner.OPENCODE_CONFIG_DIR).not.toBe(explicit);
    expect(owner.OPENCODE_CONFIG_DIR!.startsWith(scopedCliHomeRoot("opencode-config"))).toBe(true);
    expect(readdirSync(owner.OPENCODE_CONFIG_DIR!).filter((name) => !name.startsWith(".")).sort()).toEqual(["opencode.jsonc"]);
    expect(JSON.parse(readFileSync(join(owner.OPENCODE_CONFIG_DIR!, "opencode.jsonc"), "utf8"))).toEqual({ model: "p/m", provider: { p: {} } });
    const other: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: explicit };
    isolateOpenCodeGlobalInstructions(other, "bot-other");
    expect(other.OPENCODE_CONFIG_DIR).not.toBe(owner.OPENCODE_CONFIG_DIR);
    // already a Murage scope: left as is (a second call in the same turn)
    const scope = owner.OPENCODE_CONFIG_DIR;
    isolateOpenCodeGlobalInstructions(owner, "bot-oc");
    expect(owner.OPENCODE_CONFIG_DIR).toBe(scope);
    // the owner's folder is only read
    expect(readFileSync(join(explicit, "AGENTS.md"), "utf8")).toBe("PERSONAL GLOBAL OPENCODE INSTRUCTIONS");
    expect(readFileSync(join(explicit, "opencode.jsonc"), "utf8")).toContain('"plugin": ["evil"]');
  });

  it("spawns a bot turn with Murage's servers and the owner's switched off", async () => {
    const home = ownerHome();
    const driver = createOpenCodeDriver(async () => ({ default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture" }] }));
    const { spawned, mounted } = await bootTurn(driver, home, { OPENCODE_API_KEY: "fixture-only" });
    expect(spawned.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(spawned.env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(spawned.env.OPENCODE_PURE).toBe("1");
    expect(spawned.env.OPENCODE_CONFIG_DIR).toBeTruthy(); // the owner's global AGENTS.md out
    expect(spawned.env.OPENCODE_CONFIG_DIR!.startsWith(home)).toBe(false);
    // every owner server off, their `agents` too: Murage's ACP `agents` mount is not affected by it
    expect(mounted.map((server) => server.name)).toContain("agents");
    expect(JSON.parse(spawned.env.OPENCODE_CONFIG_CONTENT!).mcp).toEqual({ agents: { enabled: false }, notion: { enabled: false }, tradingview: { enabled: false } });
    expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
    expect(mounted.some((server) => server.args.includes("fixture-memory"))).toBe(true);
  }, 30000);

  // Real-engine gate (Linux, OpenCode 1.19.3, 2026-10-21): at Ask, OpenCode ran shell commands and the host computer's
  // tools with no card, and a denied card stopped nothing (A1: no card ever came). OpenCode's own permission defaults
  // allow bash, edit and every MCP tool, so it never sent session/request_permission. With `permission` set, the same
  // CLI asks, e.g. `{"method":"session/request_permission","params":{"toolCall":{"title":"computer_click","kind":"other",
  // "rawInput":{}},"options":[{"optionId":"once","kind":"allow_once"},{"optionId":"always","kind":"allow_always"},
  // {"optionId":"reject","kind":"reject_once"}]}}` (remote probe, real CLI), and Murage's level decides.
  it("hands OpenCode a permission set where everything but reads asks Murage, and in-project key files ask too", async () => {
    const home = ownerHome();
    const driver = createOpenCodeDriver(async () => ({ default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture" }] }));
    const { spawned } = await bootTurn(driver, home, { OPENCODE_API_KEY: "fixture-only", OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "allow", "*": "allow" } }) });
    const permission = JSON.parse(spawned.env.OPENCODE_CONFIG_CONTENT!).permission;
    // the owner's own permission choices never decide a bot's approvals
    expect(permission["*"]).toBe("ask");
    expect(permission.bash).toBe("ask");
    for (const tool of ["glob", "grep", "list", "todowrite", "todoread"]) expect(permission[tool], tool).toBe("allow");
    expect(permission.read["*"]).toBe("allow");
    for (const key of ["*.env", "*.env.*", "*credentials.json", "*.ssh/*", "*.aws/credentials", "*.git/config"]) expect(permission.read[key], key).toBe("ask");
    // an agent's own permission outranks the top-level one: an owner's `agent.build.permission.bash: "allow"` ran bash
    // unasked on the real CLI, so OpenCode's own agents carry the same set and a turn starts on `build`
    const config = JSON.parse(spawned.env.OPENCODE_CONFIG_CONTENT!);
    for (const name of ["build", "plan", "general", "explore"]) expect(config.agent[name].permission, name).toEqual(permission);
    expect(config.default_agent).toBe("build");
  }, 30000);
});

describe("Fuigo personal setup isolation", () => {
  it("spawns with every compat cell off and --no-memory, Murage's servers mounted", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-fuigo-iso-"));
    homes.push(home);
    const { spawned, mounted } = await bootTurn(FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>, home, { FUIGO_API_KEY: "sk-flux-fixture-only" });
    for (const name of FUIGO_EXTERNAL_MCP_GATES) expect(spawned.env[name]).toBe("0");
    expect(spawned.argv).toContain("--no-memory");
    expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
  }, 30000);
});

describe("Droid personal setup isolation", () => {
  function factoryHome(): string {
    const home = mkdtempSync(join(tmpdir(), "murage-droid-iso-"));
    homes.push(home);
    const f = join(home, ".factory");
    for (const dir of ["droids", "skills/s", "commands", "sessions"]) mkdirSync(join(f, dir), { recursive: true });
    writeFileSync(join(f, "mcp.json"), JSON.stringify({ mcpServers: { pdroid1: { command: "node", args: ["p.mjs"] } } }));
    writeFileSync(join(f, "AGENTS.md"), "PERSONAL_FACTORY_AGENTS_MARKER");
    writeFileSync(join(f, "settings.json"), JSON.stringify({ customModels: [{ id: "custom:x", model: "x" }], hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/h" }] }] }, modelFavorites: ["custom:x"] }));
    writeFileSync(join(f, "auth.v2.file"), "LOGIN");
    mkdirSync(join(home, ".agents", "skills", "a"), { recursive: true });
    return home;
  }

  it("a scoped FACTORY_HOME_OVERRIDE from 0.196.0: personal servers, hooks, droids, skills, commands and AGENTS.md out; login and sessions linked", () => {
    ensureDirs();
    const home = factoryHome();
    // fails closed: an unknown or older droid is rejected (update-required), never run in the owner's own .factory
    for (const version of [undefined, "0.195.9"]) {
      const env: Record<string, string | undefined> = { HOME: home };
      let error: unknown = null;
      try { scopeDroidHome(env, version); } catch (e) { error = e; }
      expect(error, String(version)).toBeInstanceOf(ScopeUnavailableError);
      expect((error as ScopeUnavailableError).code).toBe("update-required");
      expect((error as ScopeUnavailableError).engine).toBe("Droid");
      expect(env.FACTORY_HOME_OVERRIDE).toBeUndefined();
    }
    const floor: Record<string, string | undefined> = { HOME: home };
    scopeDroidHome(floor, "droid 0.196.0", "floor-bot"); // the earliest droid whose FACTORY_HOME_OVERRIDE is proved
    expect(floor.FACTORY_HOME_OVERRIDE).toBeTruthy();
    const env: Record<string, string | undefined> = { HOME: home };
    scopeDroidHome(env, "droid 0.238.0");
    const scoped = env.FACTORY_HOME_OVERRIDE!;
    expect(scoped.startsWith(home)).toBe(false);
    const f = join(scoped, ".factory");
    for (const gone of ["mcp.json", "droids", "skills", "commands", "AGENTS.md"]) expect(existsSync(join(f, gone)), gone).toBe(false);
    expect(existsSync(join(scoped, ".agents"))).toBe(false);
    expect(readlinkSync(join(f, "auth.v2.file"))).toBe(join(home, ".factory", "auth.v2.file"));
    expect(readlinkSync(join(f, "auth.v2.keyring"))).toBe(join(home, ".factory", "auth.v2.keyring")); // linked before a first sign-in
    expect(existsSync(join(f, "sessions"))).toBe(false); // the bot's own, not the owner's linked through
    expect(JSON.parse(readFileSync(join(f, "settings.json"), "utf8"))).toEqual({ customModels: [{ id: "custom:x", model: "x" }], modelFavorites: ["custom:x"] });
    // the owner's files keep every byte
    expect(JSON.parse(readFileSync(join(home, ".factory", "settings.json"), "utf8")).hooks).toBeTruthy();
    // an already-scoped env is left alone
    scopeDroidHome(env, "droid 0.238.0");
    expect(env.FACTORY_HOME_OVERRIDE).toBe(scoped);
  });

  it("settings.local.json is kept as a filtered copy: model and BYOK fields stay, hooks and servers go, the owner's file is untouched", () => {
    ensureDirs();
    const home = factoryHome();
    const f = join(home, ".factory");
    const local = { customModels: [{ id: "custom:local", model: "local-model", apiKey: "sk-fixture-only" }], hooks: { SessionStart: [{ hooks: [{ type: "command", command: "touch /tmp/l" }] }] }, mcpServers: { pl: { command: "x" } }, mcp: { servers: {} }, reasoningEffort: "high" };
    writeFileSync(join(f, "settings.local.json"), JSON.stringify(local));
    const env: Record<string, string | undefined> = { HOME: home };
    scopeDroidHome(env, "droid 0.238.0", "bot-1");
    const copy = JSON.parse(readFileSync(join(env.FACTORY_HOME_OVERRIDE!, ".factory", "settings.local.json"), "utf8"));
    expect(copy).toEqual({ customModels: local.customModels, reasoningEffort: "high" });
    expect(lstatSync(join(env.FACTORY_HOME_OVERRIDE!, ".factory", "settings.local.json")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(f, "settings.local.json"), "utf8"))).toEqual(local);
    // no local file: none is invented; one that is not JSON is not copied
    const bare = factoryHome();
    const e2: Record<string, string | undefined> = { HOME: bare };
    scopeDroidHome(e2, "droid 0.238.0", "bot-1");
    expect(existsSync(join(e2.FACTORY_HOME_OVERRIDE!, ".factory", "settings.local.json"))).toBe(false);
    writeFileSync(join(bare, ".factory", "settings.local.json"), "{ not json with hooks");
    const e3: Record<string, string | undefined> = { HOME: bare };
    scopeDroidHome(e3, "droid 0.238.0", "bot-2");
    expect(existsSync(join(e3.FACTORY_HOME_OVERRIDE!, ".factory", "settings.local.json"))).toBe(false);
  });

  it("each bot has its own .factory state root; only the login files are shared", () => {
    ensureDirs();
    const home = factoryHome();
    const f = join(home, ".factory");
    const a: Record<string, string | undefined> = { HOME: home };
    const b: Record<string, string | undefined> = { HOME: home };
    scopeDroidHome(a, "droid 0.238.0", "bot-a");
    scopeDroidHome(b, "droid 0.238.0", "bot-b");
    expect(a.FACTORY_HOME_OVERRIDE).not.toBe(b.FACTORY_HOME_OVERRIDE);
    const fa = join(a.FACTORY_HOME_OVERRIDE!, ".factory"), fb = join(b.FACTORY_HOME_OVERRIDE!, ".factory");
    mkdirSync(join(fa, "sessions"), { recursive: true });
    writeFileSync(join(fa, "sessions", "a.json"), "A");
    writeFileSync(join(fa, "AGENTS.md"), "BOT A");
    expect(existsSync(join(fb, "sessions"))).toBe(false);
    expect(existsSync(join(fb, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(f, "sessions", "a.json"))).toBe(false);
    expect(readlinkSync(join(fa, "auth.v2.file"))).toBe(join(f, "auth.v2.file"));
    expect(readlinkSync(join(fb, "auth.v2.file"))).toBe(join(f, "auth.v2.file"));
  });

  it("a bot turn spawns with the scoped home and Murage's servers mounted", async () => {
    const home = factoryHome();
    const { spawned, mounted } = await bootTurn(DroidAgentDriver as unknown as ProviderDriver<AcpConfig>, home, { FACTORY_API_KEY: "fixture-only", FAKE_ACP_VERSION: "0.238.0" });
    expect(spawned.env.FACTORY_HOME_OVERRIDE).toBeTruthy();
    expect(spawned.env.FACTORY_HOME_OVERRIDE!.startsWith(home)).toBe(false);
    expect(mounted.some((server) => server.args.includes("fixture-agents"))).toBe(true);
  }, 30000);
});
