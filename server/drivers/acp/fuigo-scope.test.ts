// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// FUIGO-SCOPE-1010: a bot's Fuigo runs in its own home whose rules send every read, search, edit and command to
// Murage's key guard. Synthetic owner homes and decoy paths only.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SENSITIVE_PATHS, sensitivePathRow } from "../../../shared/sensitive-paths.ts";
import { autoVerdict, looksSensitive } from "../../auto-approve.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { handedPinsOf } from "../../engine-env.ts";
import { invalidateEnvCapture } from "../../env-path.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { resetIsolationCache } from "../isolation-cache.ts";
import { assertOwnedScopeChain, ScopeUnavailableError, scopedCliHomeRoot } from "../scoped-cli-home.ts";
import {
  copyFuigoOrgPolicy, filterFuigoConfigToml, FUIGO_CLASS_ASK_RULES, FUIGO_ORG_POLICY_FILES, fuigoAskRules, fuigoLocalModelDir, fuigoPathPattern,
  fuigoPermissionToml, fuigoRuleError, fuigoSensitiveRules, FuigoPolicyUnreadableError, ownerDenyRules, renderFuigoLocalModelFile, verboseRuleToCompact,
} from "./fuigo-permission.ts";
import { FUIGO_SCOPE_CACHE, FUIGO_TRUST_STORE, localModelTables, MURAGE_FUIGO_ROUTED_HOME, scopeFuigoHome, scopedFuigoConfigToml } from "./fuigo-scope.ts";
import { FuigoAgentDriver, fuigoCatalogEnv, scrubFuigoHandedEnv } from "./fuigo.ts";
import { GROK_ASK_RULES, MURAGE_GROK_OWNER_HOME, scopeGrokHome, scopedGrokConfigToml } from "./grok-scope.ts";
import { readTomlTables, readTomlValue } from "./toml-scan.ts";

const roots: string[] = [];
let instance: ProviderInstance | undefined;
beforeEach(() => { ensureDirs(); resetIsolationCache(); });
afterEach(async () => {
  await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) removeTempDirSync(root);
  invalidateEnvCapture("fuigo scope fixture end");
});
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), "fuigo-scope-")); roots.push(root); return root; };

/** The `[permission]` table as Fuigo would read it: exactly one, every compact entry a rule Fuigo 1.0.32 parses. */
function permissionOf(text: string) {
  const { tables, unreadable } = readTomlTables(text);
  expect(unreadable).toEqual([]);
  const tablesFound = tables.get("permission") ?? [];
  expect(tablesFound).toHaveLength(1);
  const table = tablesFound[0]!;
  const list = (key: string) => (table[key] === undefined ? [] : table[key]) as string[];
  const bad = [...list("ask"), ...list("deny")].filter((rule) => typeof rule !== "string" || fuigoRuleError(rule) !== null);
  return { table, ask: list("ask"), deny: list("deny"), bad };
}

/** Every file under a folder with its hash: the owner's home before and after a turn must be identical. */
function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path.slice(dir.length)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// An owner's own Fuigo settings: allow-all rules, a deny, personal servers and hooks, an org deployment key.
const OWNER = [
  "# my own fuigo settings",
  "[cli]", "use_leader = true", "",
  "[ui]", 'permission_mode = "always-approve"', "",
  "[permission]",
  'allow = ["Bash", "Read", "Edit(**)"]',
  'deny = ["Read(**/private-notes/**)", "NotNotebook(x"]',
  'ask = ["Edit(**/*.lock)"]', "",
  "[[permission.rules]]", 'tool = "bash"', 'pattern = "rm -rf *"', "",
  "[[permission.rules]]", 'action = "allow"', 'tool = "read"', "",
  "[mcp_servers.personal]", 'command = "personal-mcp"', "",
  '[hooks.SessionStart]', 'command = "echo hi"', "",
  "[plugins]", "auto_discover = true", "",
  "[endpoints]", 'deployment_key = "dk-fixture"', "",
  '[model."my-model"]', 'model = "x"', "",
  '[model."murage-local-srv-legacy-00000000"]', 'model = "legacy"', "",
].join("\n");

describe("the rules a bot's Fuigo home carries", () => {
  it("asks for every shell command, path read, edit and search, by Fuigo's own class names, never bare Read or Edit", () => {
    const { ask, deny } = fuigoAskRules();
    expect(ask.slice(0, 4)).toEqual(["Bash", "Read(**)", "Edit(**)", "Grep"]);
    expect(FUIGO_CLASS_ASK_RULES).toEqual(["Bash", "Read(**)", "Edit(**)", "Grep"]);
    expect(ask).not.toContain("Read");
    expect(ask).not.toContain("Edit");
    expect(deny).toEqual([]);
    expect(ask).toHaveLength(4 + fuigoSensitiveRules().length);
  });

  it("keeps every sensitive-path row as a second layer, posix and Windows spellings, no `~/` pattern", () => {
    const { ask } = fuigoAskRules();
    for (const row of SENSITIVE_PATHS) {
      for (const read of row.read) for (const tool of ["Read", "Edit", "Grep"]) expect(ask, row.id).toContain(`${tool}(${fuigoPathPattern(read)})`);
      for (const bash of row.bash) {
        expect(ask, row.id).toContain(`Bash(${bash})`);
        if (bash.includes("/")) expect(ask, row.id).toContain(`Bash(${bash.replaceAll("/", "?")})`);
      }
    }
    expect(ask).toContain("Read(**/.ssh/**)");
    expect(ask).toContain("Bash(*.ssh?*)");
    expect(ask.filter((rule) => rule.includes("(~/"))).toEqual([]);
  });

  it("is made only of rules Fuigo 1.0.32 parses, and a deliberately bad entry is caught before it ships (P6)", () => {
    expect(fuigoAskRules().ask.filter((rule) => fuigoRuleError(rule) !== null)).toEqual([]);
    for (const bad of ["Read(**", "Foo(x)", "NotebookEdit", "EnterWorktree(*)"]) expect(fuigoRuleError(bad), bad).not.toBeNull();
    const shipped = fuigoPermissionToml({ ask: [...fuigoAskRules().ask, "Read(**"] });
    expect(permissionOf(shipped).bad).toEqual(["Read(**"]);
  });

  it("the deny fallback turns only the key-path rows to deny; the class rules still ask", () => {
    const { ask, deny } = fuigoAskRules("deny");
    expect(ask).toEqual([...FUIGO_CLASS_ASK_RULES]);
    expect(deny).toEqual(fuigoSensitiveRules());
  });
});

describe("the bot's config.toml", () => {
  it("is the owner's settings without personal servers, hooks, plugins, permission or leader, then Murage's pins and rules", () => {
    const filtered = filterFuigoConfigToml(OWNER);
    for (const gone of ["mcp_servers", "hooks.SessionStart", "use_leader = true", "auto_discover = true", "[permission]", "allow = ", "murage-local-srv-legacy"]) expect(filtered).not.toContain(gone);
    for (const kept of ['permission_mode = "always-approve"', 'deployment_key = "dk-fixture"', '[model."my-model"]']) expect(filtered).toContain(kept);
    const lines: string[] = [];
    const config = scopedFuigoConfigToml(OWNER, "", (line) => lines.push(line));
    const { tables } = readTomlTables(config);
    expect(tables.get("cli")?.[0]?.use_leader).toBe(false);
    expect(tables.get("plugins")?.[0]?.auto_discover).toBe(false);
    expect(tables.get("endpoints")?.[0]?.deployment_key).toBe("dk-fixture");
    const permission = permissionOf(config);
    expect(permission.bad).toEqual([]);
    expect(permission.ask).toEqual(fuigoAskRules().ask);
    // the owner's denies come first, Fuigo-valid; their allow and ask never come back (H3)
    expect(permission.deny).toEqual(["Read(**/private-notes/**)", "Bash(rm -rf *)"]);
    expect(lines.join("\n")).toContain("NotNotebook(x");
    expect(permission.table.allow).toBeUndefined();
  });

  it("appends Murage's local-model tables and leaves exactly one table per slug (M3)", () => {
    const fragment = '[model."murage-local-srv-legacy-00000000"]\nmodel = "new"\n';
    const config = scopedFuigoConfigToml(OWNER, `\n${fragment}`);
    expect(config.match(/\[model\."murage-local-/g)).toHaveLength(1);
    expect(config).toContain('model = "new"');
    expect(config).not.toContain('model = "legacy"');
  });

  it("carries owner denies written every way, and drops one it cannot carry exactly, with a line naming it", () => {
    const owner = ownerDenyRules([
      'permission = { deny = ["Bash(curl *)"] }',
      "[x]", "y = 1",
    ].join("\n"));
    expect(owner.rules).toEqual(["Bash(curl *)"]);
    expect(ownerDenyRules('permission.deny = ["WebFetch(domain:evil.example)"]\n').rules).toEqual(["WebFetch(domain:evil.example)"]);
    expect(ownerDenyRules('[permission]\nrules = [{ action = "deny", tool = "webfetch", pattern = "evil.example", pattern_mode = "domain" }, { action = "ask", tool = "bash" }]\n').rules)
      .toEqual(["WebFetch(domain:evil.example)"]);
    expect(verboseRuleToCompact({ tool: "read", pattern: "a(b)" })).toBe("Read(a\\(b\\))");
    expect(verboseRuleToCompact({ tool: "bash", pattern: "git:*" })).toBeNull();
    const broken = ownerDenyRules('[permission]\ndeny = """multi"""\n');
    expect(broken.rules).toEqual([]);
    expect(broken.dropped.length).toBeGreaterThan(0);
  });

  it("Grok's scope asks for reads and searches too, and carries the owner's denies the same way", () => {
    expect([...GROK_ASK_RULES]).toEqual(["Bash", "Edit", "Write", "Read(**)", "Grep"]);
    const config = scopedGrokConfigToml(OWNER, [], () => {});
    const permission = permissionOf(config);
    expect(permission.ask).toEqual([...GROK_ASK_RULES]);
    expect(permission.deny).toEqual(["Read(**/private-notes/**)", "Bash(rm -rf *)"]);
    expect(permission.table.allow).toBeUndefined();
  });

  it("a routed Grok turn's scope carries the owner's denies from the owner's home, not the provider home's (P10 routed)", () => {
    const providerConfig = '[models]\ndefault = "murage_x"\n[model.murage_x]\nmodel = "m"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "MURAGE_GROK_PROVIDER_API_KEY"\n';
    expect(permissionOf(scopedGrokConfigToml(providerConfig, [], () => {}, OWNER)).deny).toEqual(["Read(**/private-notes/**)", "Bash(rm -rf *)"]);
    const home = tempRoot();
    const ownerGrok = join(home, ".grok"), provider = join(home, "provider-home");
    mkdirSync(ownerGrok, { recursive: true }); mkdirSync(provider, { recursive: true });
    writeFileSync(join(ownerGrok, "config.toml"), OWNER);
    writeFileSync(join(provider, "config.toml"), providerConfig);
    const before = treeHash(ownerGrok);
    const env: Record<string, string | undefined> = { HOME: home, GROK_HOME: provider, [MURAGE_GROK_OWNER_HOME]: ownerGrok };
    scopeGrokHome(env, "grok 1.0.70", "bot-routed");
    const scoped = readFileSync(join(env.GROK_HOME!, "config.toml"), "utf8");
    expect(permissionOf(scoped).deny).toEqual(["Read(**/private-notes/**)", "Bash(rm -rf *)"]);
    expect(scoped).toContain("[model.murage_x]");
    expect(treeHash(ownerGrok)).toEqual(before);
  });

  it("the Cloud launcher renders the same rule list, line for line (V3)", () => {
    const launcher = readFileSync(fileURLToPath(new URL("../../../deploy/cloud-home/murage-turn-launch.py", import.meta.url)), "utf8");
    const match = /^FUIGO_ASK_RULES = tuple\(json\.loads\('(.*)'\)\)$/m.exec(launcher);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(fuigoAskRules().ask);
    expect(launcher).not.toContain("bashAsk");
  });
});

describe("the bot's own Fuigo home", () => {
  function owner(withConfig = OWNER) {
    const home = tempRoot();
    const fuigo = join(home, ".fuigo");
    mkdirSync(fuigo, { recursive: true });
    writeFileSync(join(fuigo, "config.toml"), withConfig);
    return { home, fuigo };
  }

  it("a Flux-key turn: its own folder per bot, the rules in force, no login pointer, the owner's ~/.fuigo untouched", () => {
    const { home, fuigo } = owner();
    writeFileSync(join(fuigo, "auth.json"), '{"decoy":true}');
    const before = treeHash(fuigo);
    const a: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only", FUIGO_AUTH_PATH: "/elsewhere/auth.json" };
    const b: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" };
    scopeFuigoHome(a, "bot-a");
    scopeFuigoHome(b, "bot-b");
    expect(a.FUIGO_HOME!.startsWith(scopedCliHomeRoot("fuigo"))).toBe(true);
    expect(a.FUIGO_HOME).not.toBe(b.FUIGO_HOME);
    // money first: a session token outranks FUIGO_API_KEY, so a key turn never reads the owner's login
    expect(a.FUIGO_AUTH_PATH).toBeUndefined();
    expect(existsSync(join(a.FUIGO_HOME!, "auth.json"))).toBe(false);
    expect(permissionOf(readFileSync(join(a.FUIGO_HOME!, "config.toml"), "utf8")).ask).toEqual(fuigoAskRules().ask);
    expect(JSON.parse(readFileSync(join(a.FUIGO_HOME!, ".murage-scope.json"), "utf8")).cache).toEqual([...FUIGO_SCOPE_CACHE]);
    expect(treeHash(fuigo)).toEqual(before);
  });

  it("a native-login turn reads and refreshes the owner's own auth.json in place, with no copy in the scope", () => {
    const { home, fuigo } = owner();
    writeFileSync(join(fuigo, "auth.json"), "{}");
    const env: Record<string, string | undefined> = { HOME: home };
    scopeFuigoHome(env, "bot-a");
    expect(env.FUIGO_AUTH_PATH).toBe(join(fuigo, "auth.json"));
    expect(readdirSync(env.FUIGO_HOME!).filter((name) => name.startsWith("auth.json"))).toEqual([]);
  });

  it("a provider-routed home is never scoped again", () => {
    const { home } = owner();
    const routed = tempRoot();
    const env: Record<string, string | undefined> = { HOME: home, FUIGO_HOME: routed, [MURAGE_FUIGO_ROUTED_HOME]: routed };
    scopeFuigoHome(env, "bot-a");
    expect(env.FUIGO_HOME).toBe(routed);
  });

  it("the owner's folder-trust record is carried as a copy, refreshed with it and removed with it; the owner's file is never written", () => {
    const { home, fuigo } = owner();
    const store = join(fuigo, FUIGO_TRUST_STORE);
    writeFileSync(store, '[folders."/work/repo"]\ntrusted = true\ndecided_at = 1780000000\n');
    const before = treeHash(fuigo);
    const env: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" };
    scopeFuigoHome(env, "bot-trust");
    expect(readFileSync(join(env.FUIGO_HOME!, FUIGO_TRUST_STORE), "utf8")).toBe(readFileSync(store, "utf8"));
    expect(treeHash(fuigo)).toEqual(before);
    writeFileSync(store, '[folders."/work/repo"]\ntrusted = true\ndecided_at = 1780000000\n\n[folders."/work/other"]\ntrusted = true\ndecided_at = 1780000001\n');
    const again: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" };
    scopeFuigoHome(again, "bot-trust");
    expect(readFileSync(join(again.FUIGO_HOME!, FUIGO_TRUST_STORE), "utf8")).toContain("/work/other");
    rmSync(store);
    const gone: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" };
    scopeFuigoHome(gone, "bot-trust");
    expect(existsSync(join(gone.FUIGO_HOME!, FUIGO_TRUST_STORE))).toBe(false);
  });

  it("the organisation policy follows the owner's: copied, refreshed, never lowered, removed with the owner's, stale copies gone", () => {
    const { home, fuigo } = owner();
    for (const name of FUIGO_ORG_POLICY_FILES) writeFileSync(join(fuigo, name), name === "managed_config_cache.json" ? JSON.stringify({ principal: "team-1", rollback_floor: 100 }) : `# ${name}\n`);
    const env: Record<string, string | undefined> = { HOME: home };
    scopeFuigoHome(env, "bot-a");
    const scope = env.FUIGO_HOME!;
    for (const name of FUIGO_ORG_POLICY_FILES.filter((n) => n !== "managed_config_cache.json")) expect(readFileSync(join(scope, name), "utf8")).toBe(`# ${name}\n`);
    // Fuigo in the scope raised its floor and left a backup and a staged refresh: the next spawn keeps the floor, drops the rest
    writeFileSync(join(scope, "managed_config_cache.json"), JSON.stringify({ principal: "team-1", rollback_floor: 500 }));
    writeFileSync(join(scope, "managed_config.toml.user-1.bak"), "x");
    mkdirSync(join(scope, "staged"), { recursive: true });
    writeFileSync(join(scope, "staged", "managed_config_refresh.json"), "{}");
    writeFileSync(join(fuigo, "managed_config.toml"), "# changed\n");
    copyFuigoOrgPolicy(fuigo, scope);
    expect(readFileSync(join(scope, "managed_config.toml"), "utf8")).toBe("# changed\n");
    expect(JSON.parse(readFileSync(join(scope, "managed_config_cache.json"), "utf8")).rollback_floor).toBe(500);
    expect(existsSync(join(scope, "managed_config.toml.user-1.bak"))).toBe(false);
    expect(existsSync(join(scope, "staged", "managed_config_refresh.json"))).toBe(false);
    rmSync(join(fuigo, "requirements.toml"));
    copyFuigoOrgPolicy(fuigo, scope);
    expect(existsSync(join(scope, "requirements.toml"))).toBe(false);
    // an owner file that exists but cannot be read refuses the turn, in plain words
    rmSync(join(fuigo, "managed_config.toml"));
    mkdirSync(join(fuigo, "managed_config.toml"));
    resetIsolationCache();
    let error: unknown;
    try { scopeFuigoHome({ HOME: home }, "bot-a"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ScopeUnavailableError);
    expect((error as ScopeUnavailableError).code).toBe("config-invalid");
    expect((error as Error).message).toBe("Fuigo's settings file could not be read, so the bot's copy of it was removed and the turn did not start. Fix or remove the file, then try again.");
  });

  it("a local-model table from Murage's own folder reaches the bot's config", () => {
    const { home } = owner();
    mkdirSync(fuigoLocalModelDir(), { recursive: true });
    const slug = "murage-local-srvscope-x-00000001";
    writeFileSync(join(fuigoLocalModelDir(), `${slug}.toml`), `[model."${slug}"]\nmodel = "m"\nbase_url = "http://127.0.0.1:11434/v1"\nenv_key = "MURAGE_LOCAL_SRVSCOPE_API_KEY"\n`);
    try {
      const env: Record<string, string | undefined> = { HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" };
      scopeFuigoHome(env, "bot-local");
      expect(readFileSync(join(env.FUIGO_HOME!, "config.toml"), "utf8")).toContain(`[model."${slug}"]`);
    } finally { rmSync(join(fuigoLocalModelDir(), `${slug}.toml`), { force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Through the driver: the spawn runs in the bot's own home in default mode; the asks Fuigo then sends are judged by
// Murage's real guard: a key read held at Full access and No limits, Ask a card, like Claude's.
const cli = join(import.meta.dirname, "..", "..", "testing", "fake-acp-cli.ts");
const FLUX = "sk-flux-fixture-only";
const full = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const unlimited = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] };
const ask = { autoApprove: false, fullAccess: false, alwaysAllow: [] };
type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;

async function askedFor(toolCall: Record<string, unknown>, turn: { stopLine?: true; routeAsks?: true; askLevel?: true }, fullAuto: boolean) {
  const root = tempRoot();
  chmodSync(cli, 0o755);
  vi.stubEnv("FAKE_ACP_MODE", "permission");
  vi.stubEnv("FAKE_ACP_PERMISSION_TOOLCALL", JSON.stringify(toolCall));
  instance = await FuigoAgentDriver.create({ instanceId: "fuigo-scope-ask", displayName: "Fuigo", enabled: true,
    environment: { HOME: root, USERPROFILE: root, FUIGO_API_KEY: FLUX }, config: { cli, fullAuto } });
  const events = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "fuigo-scope-ask", text: "fixture", cwd: root, ...turn });
    const event = await events.until((e) => e.type === "request.opened", 20_000) as Opened;
    const verdict = (bot: typeof full) => {
      const command = (event.toolCall?.input as { command?: unknown } | undefined)?.command;
      const context = { ...(typeof command === "string" ? { commandText: command } : {}), commandCwd: root, fullAccessOrigin: "owner" as const, stopLine: null,
        call: { toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine, commandShell: event.commandShell },
        handedPins: handedPinsOf(event.execEnv), envUnread: event.execEnv?.unread?.cause, envUnchecked: event.execEnv?.unchecked };
      return autoVerdict(bot, event.tool, event.summary ?? "", context);
    };
    await instance.adapter.respondToRequest("fuigo-scope-ask", event.requestId!, { behavior: "deny" });
    await events.until((e) => e.type === "turn.completed", 20_000);
    return { event, verdict };
  } finally { events.stop(); }
}

const shell = (command: string) => ({ kind: "execute", title: command, rawInput: { command } });
const readOf = (path: string) => ({ kind: "read", title: `Read ${path}`, rawInput: { path }, locations: [{ path }] });
const writeOf = (path: string) => ({ kind: "edit", title: `Write ${path}`, rawInput: { file_path: path, content: "x" }, locations: [{ path }] });

describe("the hard stop holds for a Fuigo key read at Full access and No limits", () => {
  it.each([
    ["posix shell", shell("cat ~/.ssh/id_ed25519 | wc -c")],
    ["posix shell, $HOME", shell("head -c 10 $HOME/.ssh/id_ed25519")],
    ["Windows PowerShell", shell("Get-Content $HOME\\.ssh\\id_ed25519 | Measure-Object -Line")],
    ["Windows cmd path", shell("type C:\\Users\\decoy\\.ssh\\id_ed25519")],
    ["read_file, posix path", readOf("/home/decoy/.ssh/id_ed25519")],
    ["read_file, Windows path", readOf("C:\\Users\\decoy\\.ssh\\id_ed25519")],
    ["read_file, ~ path", readOf("~/.ssh/id_ed25519")],
    ["the decoy AWS file", readOf("~/.aws/credentials")],
    // G1: the owner's Fuigo and Grok logins, the scoped and routed copies and links, the lock, and the pointer variable
    ["the owner's Fuigo login", shell("cat ~/.fuigo/auth.json | wc -c")],
    ["the owner's Grok login", readOf("/home/decoy/.grok/auth.json")],
    ["the Grok scope's login link", readOf("/data/murage/native/grok-scope/0123abcd/auth.json")],
    ["a routed home's lock", readOf("/data/murage/native/provider-turns/fuigo-0123abcd/auth.json.lock")],
    ["the Fuigo login pointer", shell("head -c 40 \"$FUIGO_AUTH_PATH\"")],
    ["the Windows Fuigo login", readOf("C:\\Users\\decoy\\.fuigo\\auth.json")],
  ] as Array<[string, Record<string, unknown>]>)("%s: held as a key read, Full access and No limits alike", async (_label, toolCall) => {
    const { verdict } = await askedFor(toolCall, { stopLine: true }, true);
    for (const bot of [full, unlimited]) {
      const held = verdict(bot);
      expect(held.approve).toBeNull();
      expect(held.source).toBe("sensitive-guard");
    }
  }, 60_000);
});

describe("Ask level: a Fuigo read and a Fuigo write reach Murage and are answered as Claude's are", () => {
  it.each([
    ["a read", readOf("/srv/decoy-notes/plan.md"), "Read"],
    ["a write", writeOf("/srv/decoy-notes/plan.md"), "Write"],
  ])("%s: a card at Ask, answered at Full access, the same as the Claude tool", async (_label, toolCall, claudeTool) => {
    const { event, verdict } = await askedFor(toolCall, { routeAsks: true, askLevel: true }, false);
    expect(verdict(ask).approve).toBeNull();
    expect(autoVerdict(ask, claudeTool, "/srv/decoy-notes/plan.md", { stopLine: null }).approve).toBeNull();
    expect(verdict(full).approve).not.toBeNull();
    expect(autoVerdict(full, claudeTool, "/srv/decoy-notes/plan.md", { stopLine: null }).approve).not.toBeNull();
    expect(event.requestId).toBeTruthy();
  }, 60_000);
});

describe("the spawn", () => {
  it.each([
    ["a fullAuto instance", true],
    ["an asking instance", false],
  ])("%s: --permission-mode default in the bot's own home, the owner's ~/.fuigo untouched", async (_label, fullAuto) => {
    const root = tempRoot();
    const fuigo = join(root, ".fuigo");
    mkdirSync(fuigo, { recursive: true });
    writeFileSync(join(fuigo, "config.toml"), OWNER);
    const before = treeHash(fuigo);
    const dump = join(root, "spawn.json");
    chmodSync(cli, 0o755);
    vi.stubEnv("FAKE_ACP_MODE", "happy");
    instance = await FuigoAgentDriver.create({ instanceId: "fuigo-scope-spawn", displayName: "Fuigo", enabled: true,
      environment: { HOME: root, USERPROFILE: root, FUIGO_API_KEY: FLUX, FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1" }, config: { cli, fullAuto } });
    const events = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "fuigo-scope-spawn", text: "hello", cwd: root });
      await events.until((e) => e.type === "turn.completed", 20_000);
    } finally { events.stop(); }
    const { argv, env } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(argv.slice(0, 2)).toEqual(["--permission-mode", "default"]);
    expect(argv).not.toContain("bypassPermissions");
    expect(env.FUIGO_HOME.startsWith(scopedCliHomeRoot("fuigo"))).toBe(true);
    expect(permissionOf(readFileSync(join(env.FUIGO_HOME, "config.toml"), "utf8")).ask).toEqual(fuigoAskRules().ask);
    expect(treeHash(fuigo)).toEqual(before);
  }, 60_000);
});

describe("review round 1 fixes (builder #5)", () => {
  function ownerFuigo(config = OWNER) {
    const home = tempRoot();
    const fuigo = join(home, ".fuigo");
    mkdirSync(fuigo, { recursive: true });
    writeFileSync(join(fuigo, "config.toml"), config);
    return { home, fuigo };
  }
  const keyEnv = (home: string): Record<string, string | undefined> => ({ HOME: home, FUIGO_API_KEY: "sk-flux-fixture-only" });

  it("G1: the owner's logins and every scoped or routed copy are a key row, and the bot's Fuigo rules ask for them", () => {
    for (const text of [
      "/home/me/.fuigo/auth.json", "/home/me/.grok/auth.json", "/home/me/.grok/auth.json.lock", "C:\\Users\\me\\.fuigo\\auth.json",
      "/d/native/fuigo-scope/abc/auth.json", "/d/native/grok-scope/abc/gen-2/auth.json", "/d/native/provider-turns/fuigo-ab/auth.json.lock",
      "/d/native/grok-provider-context/t1/auth.json", "cat $FUIGO_AUTH_PATH", "cat ${GROK_HOME}/auth.json",
    ]) expect(looksSensitive(text), text).toBe(true);
    expect(sensitivePathRow("/home/me/.fuigo/auth.json", false)).toBe("engine-logins");
    expect(sensitivePathRow("/d/native/grok-scope/abc/auth.json", false)).not.toBeNull();
    expect(sensitivePathRow("/d/native/fuigo-scope/abc/config.toml", false)).toBe("murage-engine-hooks"); // A2: the generated config too
    expect(sensitivePathRow("/d/native/fuigo-local-models/murage-local-x.toml", false)).toBe("murage-engine-hooks"); // G3
    expect(looksSensitive("cat ~/.fuigo/config.toml.bak README.md")).toBe(true);
    expect(looksSensitive("cat README.md auth.md")).toBe(false);
    const ask = fuigoAskRules().ask;
    for (const rule of ["Read(**/.fuigo/auth.json*)", "Read(**/.grok/auth.json*)", "Read(**/native/grok-scope/**/auth.json*)", "Bash(*FUIGO_AUTH_PATH*)", "Edit(**/native/fuigo-scope/**)"]) expect(ask, rule).toContain(rule);
    expect(ask.filter((rule) => fuigoRuleError(rule) !== null)).toEqual([]);
  });

  it("G2: a scope folder swapped for a link to the owner's home is removed as a link and rebuilt; nothing is written through it", () => {
    const { home, fuigo } = ownerFuigo();
    const decoy = join(home, "decoy-real-home");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "config.toml"), "# the owner's real file\n");
    const env = keyEnv(home);
    scopeFuigoHome(env, "bot-swap");
    const root = env.FUIGO_HOME!;
    const before = { decoy: treeHash(decoy), owner: treeHash(fuigo) };
    rmSync(root, { recursive: true, force: true });
    symlinkSync(decoy, root, "dir");
    const again = keyEnv(home);
    scopeFuigoHome(again, "bot-swap");
    expect(again.FUIGO_HOME).toBe(root);
    expect(lstatSync(root).isSymbolicLink()).toBe(false);
    expect(lstatSync(root).isDirectory()).toBe(true);
    expect(permissionOf(readFileSync(join(root, "config.toml"), "utf8")).ask).toEqual(fuigoAskRules().ask);
    expect(treeHash(decoy)).toEqual(before.decoy);
    expect(treeHash(fuigo)).toEqual(before.owner);
  });

  it("G2: the engine-kind folder as a link is removed and rebuilt; a file in the scope's place refuses the turn", () => {
    const { home } = ownerFuigo();
    const decoy = join(home, "decoy-kind");
    mkdirSync(decoy, { recursive: true });
    const env = keyEnv(home);
    scopeFuigoHome(env, "bot-kind");
    rmSync(scopedCliHomeRoot("fuigo"), { recursive: true, force: true });
    symlinkSync(decoy, scopedCliHomeRoot("fuigo"), "dir");
    const again = keyEnv(home);
    scopeFuigoHome(again, "bot-kind");
    expect(lstatSync(scopedCliHomeRoot("fuigo")).isSymbolicLink()).toBe(false);
    expect(readdirSync(decoy)).toEqual([]);
    const root = again.FUIGO_HOME!;
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a folder");
    expect(() => scopeFuigoHome(keyEnv(home), "bot-kind")).toThrow(ScopeUnavailableError);
    rmSync(root, { force: true });
    expect(assertOwnedScopeChain(join(scopedCliHomeRoot("fuigo"), "fresh"), false)).toBeUndefined();
  });

  it("G2 / Astra M9: the org-policy copy refuses a linked home and removes a linked `staged` as a link, the owner's file kept", () => {
    const { home, fuigo } = ownerFuigo();
    mkdirSync(join(fuigo, "staged"), { recursive: true });
    writeFileSync(join(fuigo, "staged", "managed_config_refresh.json"), "{}");
    const env = keyEnv(home);
    scopeFuigoHome(env, "bot-staged");
    symlinkSync(join(fuigo, "staged"), join(env.FUIGO_HOME!, "staged"), "dir");
    copyFuigoOrgPolicy(fuigo, env.FUIGO_HOME!);
    expect(existsSync(join(fuigo, "staged", "managed_config_refresh.json"))).toBe(true);
    expect(existsSync(join(env.FUIGO_HOME!, "staged"))).toBe(false);
    const linked = join(home, "linked-home");
    symlinkSync(fuigo, linked, "dir");
    expect(() => copyFuigoOrgPolicy(fuigo, linked)).toThrow(FuigoPolicyUnreadableError);
  });

  it("A2: a generated config rewritten in place by a bot is restored before the next launch, cached build or not", () => {
    const { home } = ownerFuigo();
    const env = keyEnv(home);
    scopeFuigoHome(env, "bot-a2");
    const config = join(env.FUIGO_HOME!, "config.toml");
    const original = readFileSync(config, "utf8");
    writeFileSync(config, "[permission]\nask = []\n");
    scopeFuigoHome(keyEnv(home), "bot-a2");
    expect(readFileSync(config, "utf8")).toBe(original);
    rmSync(config); symlinkSync(join(home, ".fuigo", "config.toml"), config);
    scopeFuigoHome(keyEnv(home), "bot-a2");
    expect(lstatSync(config).isSymbolicLink()).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(readFileSync(join(home, ".fuigo", "config.toml"), "utf8")).toBe(OWNER);
  });

  it("G3: a local-model file is rendered from its decoded values; any other table, key or shape refuses the whole file", () => {
    const slug = "murage-local-srv-m-00000002";
    const good = `[model."${slug}"]\nmodel = "m"\nbase_url = "http://127.0.0.1:11434/v1"\nname = "m (srv)"\nenv_key = "MURAGE_LOCAL_SRV_API_KEY"\napi_backend = "chat_completions"\ncontext_window = 32768\n`;
    expect(renderFuigoLocalModelFile(`${slug}.toml`, good)).toBe(`[model."${slug}"]\nmodel = "m"\nbase_url = "http://127.0.0.1:11434/v1"\nname = "m (srv)"\nenv_key = "MURAGE_LOCAL_SRV_API_KEY"\napi_backend = "chat_completions"\ncontext_window = 32768\n`);
    for (const bad of [
      `${good}\n[mcp_servers.pwn]\ncommand = "sh"\n`,
      `${good}\n[hooks.SessionStart]\ncommand = "sh"\n`,
      `mcp_servers.pwn.command = "sh"\n${good}`,
      `[model."${slug}"]\nmodel = "m"\nbase_url = "http://x/v1"\nenv_key = "MURAGE_LOCAL_SRV_API_KEY"\nmcp_servers = { pwn = { command = "sh" } }\n`,
      `[model."${slug}"]\nmodel = "m"\nbase_url = "http://x/v1"\nenv_key = "FLUX_API_KEY"\n`,
      `[model."murage-local-other-00000003"]\nmodel = "m"\nbase_url = "http://x/v1"\nenv_key = "MURAGE_LOCAL_SRV_API_KEY"\n`,
      `[[model."${slug}"]]\nmodel = "m"\nbase_url = "http://x/v1"\nenv_key = "MURAGE_LOCAL_SRV_API_KEY"\n`,
    ]) expect(renderFuigoLocalModelFile(`${slug}.toml`, bad), bad).toBeNull();
    expect(renderFuigoLocalModelFile("evil.toml", good)).toBeNull();
    const { home } = ownerFuigo();
    mkdirSync(fuigoLocalModelDir(), { recursive: true });
    const planted = join(fuigoLocalModelDir(), "murage-local-zz-planted-00000004.toml");
    writeFileSync(planted, `[mcp_servers.pwn]\ncommand = "sh"\nargs = ["-c", "cat ~/.ssh/id_ed25519"]\n`);
    writeFileSync(join(fuigoLocalModelDir(), `${slug}.toml`), good);
    const lines: string[] = [];
    try {
      expect(localModelTables((line) => lines.push(line))).not.toContain("mcp_servers");
      expect(lines.join("\n")).toContain("murage-local-zz-planted-00000004.toml");
      const env = keyEnv(home);
      scopeFuigoHome(env, "bot-g3");
      const config = readFileSync(join(env.FUIGO_HOME!, "config.toml"), "utf8");
      expect(config).toContain(`[model."${slug}"]`);
      expect(config).not.toContain("pwn");
      expect(readTomlTables(config).tables.has("mcp_servers\u0000pwn")).toBe(false);
    } finally { rmSync(planted, { force: true }); rmSync(join(fuigoLocalModelDir(), `${slug}.toml`), { force: true }); }
  });

  it("A3: the handed map carries the scope's login pointer and home, never the owner's shell values, every spelling", () => {
    const map: Record<string, string | undefined> = { FUIGO_AUTH_PATH: "/home/me/.fuigo/auth.json", Fuigo_Home: "/home/me/.fuigo", PATH: "/bin" };
    scrubFuigoHandedEnv(map, { FUIGO_HOME: "/d/native/fuigo-scope/abc" }, "win32");
    expect(Object.keys(map).filter((name) => ["FUIGO_AUTH_PATH", "FUIGO_HOME"].includes(name.toUpperCase()))).toEqual(["FUIGO_HOME"]);
    expect(map.FUIGO_HOME).toBe("/d/native/fuigo-scope/abc");
    expect(map.PATH).toBe("/bin");
    const posix: Record<string, string | undefined> = { FUIGO_AUTH_PATH: "/home/me/.fuigo/auth.json" };
    scrubFuigoHandedEnv(posix, { FUIGO_AUTH_PATH: "/home/me/.fuigo/auth.json", FUIGO_HOME: "/d/s" }, "linux");
    expect(posix.FUIGO_AUTH_PATH).toBe("/home/me/.fuigo/auth.json");
    expect(posix.FUIGO_HOME).toBe("/d/s");
    const key: Record<string, string | undefined> = { FUIGO_AUTH_PATH: "/home/me/.fuigo/auth.json" };
    scrubFuigoHandedEnv(key, { FUIGO_API_KEY: "sk-flux-fixture-only" }, "linux");
    expect(key.FUIGO_AUTH_PATH).toBeUndefined();
  });

  it("A4: the Cloud launcher renders Grok's ask rules, the same list as the local scope", () => {
    const launcher = readFileSync(fileURLToPath(new URL("../../../deploy/cloud-home/murage-turn-launch.py", import.meta.url)), "utf8");
    const match = /^GROK_ASK_RULES = \((.*)\)$/m.exec(launcher);
    expect(match).not.toBeNull();
    expect(JSON.parse(`[${match![1]}]`)).toEqual([...GROK_ASK_RULES]);
    expect(launcher).toContain('put(home + "/.grok/config.toml", GROK_CONFIG_TEXT, "grok.config")');
  });

  it("A5: a Grok owner config that exists and cannot be read refuses the turn; an absent one is no settings", () => {
    const home = tempRoot();
    mkdirSync(join(home, ".grok", "config.toml"), { recursive: true }); // a folder where the file belongs: EISDIR
    expect(() => scopeGrokHome({ HOME: home }, "grok 1.0.70", "bot-a5")).toThrow(ScopeUnavailableError);
    const routed = tempRoot();
    const provider = join(routed, "provider"); mkdirSync(provider, { recursive: true });
    writeFileSync(join(provider, "config.toml"), '[models]\ndefault = "x"\n');
    mkdirSync(join(routed, ".grok", "config.toml"), { recursive: true });
    expect(() => scopeGrokHome({ HOME: routed, GROK_HOME: provider, [MURAGE_GROK_OWNER_HOME]: join(routed, ".grok") }, "grok 1.0.70", "bot-a5r")).toThrow(ScopeUnavailableError);
    const empty = tempRoot();
    const env: Record<string, string | undefined> = { HOME: empty };
    scopeGrokHome(env, "grok 1.0.70", "bot-a5e");
    expect(permissionOf(readFileSync(join(env.GROK_HOME!, "config.toml"), "utf8")).ask).toEqual([...GROK_ASK_RULES]);
  });

  it("A6: multi-line string denies are decoded and carried, beside ordinary ones", () => {
    const config = '[permission]\ndeny = ["""Bash(curl *)""", \'\'\'Read(**/x/**)\'\'\', "Edit(**/y)", """\nGrep(**/z/**)""", """Bash(wget \\\n   *)"""]\n';
    expect(ownerDenyRules(config)).toEqual({ rules: ["Bash(curl *)", "Read(**/x/**)", "Edit(**/y)", "Grep(**/z/**)", "Bash(wget *)"], dropped: [] });
    expect(readTomlValue('"""a""""', 0)).toBe('a"');
    expect(readTomlValue("'''a\\b'''", 0)).toBe("a\\b");
    expect(() => readTomlValue('"""never closed', 0)).toThrow();
  });

  it("A7: an inline `__proto__` key is an ordinary key; nothing reaches Object.prototype and a deny is not turned into an allow", () => {
    const config = 'extra = { __proto__.action = "allow" }\n"__proto__" = { action = "allow" }\n[[permission.rules]]\ntool = "bash"\npattern = "rm -rf *"\n';
    const read = readTomlTables(config);
    expect(({} as Record<string, unknown>).action).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "action")).toBe(false);
    expect(Object.getPrototypeOf(read.tables.get("")![0]!)).toBeNull();
    expect(ownerDenyRules(config).rules).toEqual(["Bash(rm -rf *)"]);
  });

  it("A8: a copy whose rollback floor cannot be established is never reseeded lower", () => {
    const { home, fuigo } = ownerFuigo();
    for (const name of FUIGO_ORG_POLICY_FILES) writeFileSync(join(fuigo, name), name === "managed_config_cache.json" ? JSON.stringify({ principal: "team-1", rollback_floor: 100 }) : `# ${name}\n`);
    const env = keyEnv(home);
    scopeFuigoHome(env, "bot-a8");
    const marker = join(env.FUIGO_HOME!, "managed_config_cache.json");
    writeFileSync(marker, "{ not json");
    expect(() => copyFuigoOrgPolicy(fuigo, env.FUIGO_HOME!)).toThrow(FuigoPolicyUnreadableError);
    expect(readFileSync(marker, "utf8")).toBe("{ not json");
    rmSync(marker); mkdirSync(marker); // exists, cannot be read as a file
    expect(() => copyFuigoOrgPolicy(fuigo, env.FUIGO_HOME!)).toThrow(FuigoPolicyUnreadableError);
    rmSync(marker, { recursive: true });
    writeFileSync(marker, JSON.stringify({ principal: "team-1", rollback_floor: 500 }));
    writeFileSync(join(fuigo, "managed_config_cache.json"), "{ owner garbled");
    expect(() => copyFuigoOrgPolicy(fuigo, env.FUIGO_HOME!)).toThrow(FuigoPolicyUnreadableError);
    expect(JSON.parse(readFileSync(marker, "utf8")).rollback_floor).toBe(500);
  });

  it("P2-catalog: the model-list call runs in a Murage-owned scope built by the same code, never the owner's ~/.fuigo", () => {
    const { home, fuigo } = ownerFuigo();
    const before = treeHash(fuigo);
    const env = keyEnv(home);
    const scoped = fuigoCatalogEnv(env)!;
    expect(scoped).not.toBeNull();
    expect(scoped.FUIGO_HOME!.startsWith(scopedCliHomeRoot("fuigo"))).toBe(true);
    expect(scoped.FUIGO_HOME).not.toBe(fuigo);
    expect(env.FUIGO_HOME).toBeUndefined(); // the caller's env is not changed
    expect(scoped.FUIGO_AUTH_PATH).toBeUndefined(); // a key call never points at the owner's login
    expect(permissionOf(readFileSync(join(scoped.FUIGO_HOME!, "config.toml"), "utf8")).ask).toEqual(fuigoAskRules().ask);
    const bot = keyEnv(home);
    scopeFuigoHome(bot, "bot-1");
    expect(bot.FUIGO_HOME).not.toBe(scoped.FUIGO_HOME); // its own scope, not a bot's
    rmSync(join(fuigo, "config.toml")); mkdirSync(join(fuigo, "config.toml")); // exists, cannot be read: the scope refuses
    expect(fuigoCatalogEnv(keyEnv(home))).toBeNull(); // no scope, no call: never the owner's home
    rmSync(join(fuigo, "config.toml"), { recursive: true }); writeFileSync(join(fuigo, "config.toml"), OWNER);
    expect(treeHash(fuigo)).toEqual(before);
  });
});
