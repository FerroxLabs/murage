// SPDX-License-Identifier: AGPL-3.0-or-later
// Drift guard (1.0.4 audit 11-4 / 11-2): the launcher's Cloud argv grammar and env allowlist must keep
// accepting what the drivers emit. The Codex and Grok argv are built inline in async driver code, so they
// cannot be called from a test; instead this reads the drivers' source, takes every static `-c` override
// Codex is started with and every literal flag in Grok's spawnArgs, and feeds each through the real
// launcher. A flag added to a driver without a grammar entry fails here, in CI, not on a customer's home.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGrokFluxMemory, grokIsolationArgs } from "../drivers/acp/grok.ts";
import { applyOpenCodeTurnPermission, isolateOpenCodeFromPersonalSetup } from "../drivers/acp/opencode-go.ts";
import { computeFluxSpacePlan, fluxMemoryContextForTurn, fluxMemoryDecision, fuigoConfigOverlay, opencodeConfigOverlay, FLUX_MEMORY_UNKNOWN, FluxMemoryBreaker, type FluxMemorySettings } from "../flux-memory-headers.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { launcherRig, type Rig } from "./engine-launch-fixture.ts";

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
let rig: Rig;
beforeEach(() => { rig = launcherRig(".murage-drift-"); });
afterEach(() => rig.dispose());

describe("Codex argv", () => {
  const text = source("../drivers/codex.ts");
  // Every `"-c", "<literal>"` / `"-c", '<literal>'` pair in the driver (template-literal values, such as
  // model_context_window, are dynamic and covered by the grammar's own integer shape).
  // Not started on a Cloud home: `features.hooks=true` is pushed only for the gated plan, which codex.ts reaches
  // under `!cloudHome` (a Cloud turn keeps the legacy plan), so the launcher grammar rightly does not list it.
  const NOT_ON_CLOUD = new Set(["features.hooks=true"]);
  const overrides = [...text.matchAll(/"-c",\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)].map(m => m[1] !== undefined ? JSON.parse(`"${m[1]}"`) as string : m[2]!).filter(o => !NOT_ON_CLOUD.has(o));
  it("finds the overrides it is meant to guard", () => {
    expect(overrides).toContain("features.memories=false");
    expect(overrides).toContain("features.browser_use=false");
    expect(overrides.length).toBeGreaterThanOrEqual(8);
  });
  it.each(overrides)("the launcher accepts the driver's -c %s", override => {
    const args = ["app-server", "-c", override];
    expect(rig.plan(rig.request("codex", { args })).ok?.args).toEqual(args);
  });
});

describe("Grok argv", () => {
  const text = source("../drivers/acp/grok.ts");
  // spawnArgs is a block body (it runs requireGrokAskHold first) that returns the argv array; read that array, and fail loudly if the shape moves again.
  const start = text.indexOf("spawnArgs: (config, turn, ctx) => {");
  const open = start < 0 ? -1 : text.indexOf("return [", start);
  const close = open < 0 ? -1 : text.indexOf("\n    ];", open);
  const block = open >= 0 && close > open ? text.slice(open, close) : "";
  const flags = [...block.matchAll(/^\s*"(--[a-z-]+)",/gm)].map(m => m[1]!);
  it("finds the flags it is meant to guard", () => { expect(flags).toEqual(expect.arrayContaining(["--permission-mode", "--no-memory"])); });
  it.each(flags)("the launcher accepts the driver's %s", flag => {
    // --no-memory and --no-leader are both required, so every accepted turn carries them.
    const base = ["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio"];
    const args = base.includes(flag) ? base : [flag, ...base];
    expect(rig.plan(rig.request("grokAgent", { args })).ok?.args).toEqual(args);
  });
  // Fable follow-up 1: spawnArgs always emits both on a Cloud home (scopeGrokHome, run by applyMountEnv before the spawn,
  // rejects an unknown or <1.0.50 CLI), so the launcher requires both.
  it.each([
    ["--no-memory", ["--permission-mode", "default", "agent", "--no-leader", "stdio"]],
    ["--no-leader", ["--permission-mode", "default", "--no-memory", "agent", "stdio"]],
  ])("refuses a grok argv missing %s", (flag, args) => {
    expect(rig.plan(rig.request("grokAgent", { args })).error).toContain(`missing ${flag}`);
  });
});

function decisionHeaders(): Record<string, string>[] {
  return [
    fluxMemoryDecision(FLUX_MEMORY_UNKNOWN).headers,
    { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" },
    { "x-flux-memory-app": "murage", "x-flux-memory-space": "space-abc123", "x-flux-memory-read": "space-abc123,space-def456" },
  ];
}

describe("Grok isolation flags (real grokIsolationArgs)", () => {
  // The Cloud image installs Grok 1.0.52 (build-image.sh grok_version), so grokIsolationArgs emits --no-leader and one
  // --plugin-dir <stub> per personal plugin of the owner's. The stub folder is in the server's tmpdir.
  let home: string;
  beforeEach(() => { vi.stubEnv("TMPDIR", "/tmp"); home = mkdtempSync(join(tmpdir(), "drift-grok-home-")); });
  // Remove the home while TMPDIR is still stubbed: it was made under the stubbed TMPDIR, and cleanup admits only paths inside the current one.
  afterEach(() => { removeTempDirSync(home); vi.unstubAllEnvs(); });
  const plugins = (...names: string[]) => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: Object.fromEntries(names.map(n => [`${n}@market`, true])) }));
  };
  const turn = (isolation: string[]) => ["--permission-mode", "default", "--no-memory", "agent", ...isolation, "-m", "grok-4.6", "stdio"];
  const accepted = (args: string[]) => rig.plan(rig.request("grokAgent", { args })).ok?.args;

  it("accepts grokIsolationArgs without personal plugins", () => {
    const isolation = grokIsolationArgs({ HOME: home }, "1.0.52");
    expect(isolation).toEqual(["--no-leader"]);
    expect(accepted(turn(isolation))).toEqual(turn(isolation));
  });
  it("accepts grokIsolationArgs with personal plugins, repeated --plugin-dir included", () => {
    plugins("alpha", "beta.v2");
    const isolation = grokIsolationArgs({ HOME: home }, "1.0.52");
    expect(isolation.filter(a => a === "--plugin-dir")).toHaveLength(2);
    expect(accepted(turn(isolation))).toEqual(turn(isolation));
  });
  it("accepts the 1.0.4x form (--no-leader only) too", () => {
    expect(accepted(turn(grokIsolationArgs({ HOME: home }, "1.0.46")))).toBeTruthy();
  });
  it.each([
    ["a stub outside the stub directory", ["--no-leader", "--plugin-dir", "/etc/murage"]],
    ["a stub under another temp folder", ["--no-leader", "--plugin-dir", "/tmp/evil/alpha"]],
    ["a stub with ..", ["--no-leader", "--plugin-dir", "/tmp/murage-grok-isolation-abc123/../../etc"]],
    ["a stub with .. as the name", ["--no-leader", "--plugin-dir", "/tmp/murage-grok-isolation-abc123/.."]],
    ["a nested stub", ["--no-leader", "--plugin-dir", "/tmp/murage-grok-isolation-abc123/a/b"]],
    ["a relative stub", ["--no-leader", "--plugin-dir", "murage-grok-isolation-abc123/alpha"]],
    ["a stub with a short suffix", ["--no-leader", "--plugin-dir", "/tmp/murage-grok-isolation-abc/alpha"]],
    ["--plugin-dir with no value", ["--no-leader", "--plugin-dir"]],
    ["--plugin-dir given last before the literal", ["--plugin-dir", "agent"]],
    ["--leader", ["--leader"]],
    ["--no-leader=1", ["--no-leader=1"]],
    ["a repeated --no-leader", ["--no-leader", "--no-leader"]],
  ])("refuses %s", (_, isolation) => {
    expect(accepted(turn(isolation))).toBeUndefined();
  });
});

describe("Grok GROK_CONFIG (real applyGrokFluxMemory)", () => {
  const grokEnv = (env: Record<string, string>, engine = "grokAgent") => rig.plan(rig.request(engine, { env })).ok?.env;
  it.each(decisionHeaders())("keeps applyGrokFluxMemory's output for %j", headers => {
    const env: Record<string, string | undefined> = {};
    applyGrokFluxMemory(env, headers);
    expect(grokEnv({ GROK_CONFIG: env.GROK_CONFIG! })).toMatchObject({ GROK_CONFIG: env.GROK_CONFIG });
  });
  const refused = (value: string) => rig.plan(rig.request("grokAgent", { env: { GROK_CONFIG: value } })).error;
  it("refuses the turn for a GROK_CONFIG with an extra key", () => {
    const env: Record<string, string | undefined> = {};
    applyGrokFluxMemory(env, { "x-flux-memory-app": "murage" });
    for (const extra of [{ plugins: ["evil"] }, { models: { extra_headers: { "x-flux-memory-app": "murage" }, base_url: "https://evil.example" } }]) {
      const doc = { ...JSON.parse(env.GROK_CONFIG!), ...extra };
      expect(refused(JSON.stringify(doc))).toContain("GROK_CONFIG is malformed");
    }
  });
  it("refuses the turn for a GROK_CONFIG path, without echoing it", () => {
    const error = refused("/fixture/evil.toml");
    expect(error).toContain("GROK_CONFIG is malformed");
    expect(error).not.toContain("evil.toml");
  });
  it("still runs with no GROK_CONFIG", () => { expect(grokEnv({})).toBeTruthy(); });
  it.each(["claudeAgent", "codex", "kimiAgent", "opencodeGo"])("drops GROK_CONFIG for %s", engine => {
    const env: Record<string, string | undefined> = {};
    applyGrokFluxMemory(env, { "x-flux-memory-app": "murage" });
    expect(grokEnv({ GROK_CONFIG: env.GROK_CONFIG! }, engine)).not.toHaveProperty("GROK_CONFIG");
  });
});

describe("Flux memory overlays", () => {
  // The real overlay builders' output, for the audiences that reach a Cloud home: the launcher keeps it.
  const decisions = [
    fluxMemoryDecision(FLUX_MEMORY_UNKNOWN).headers,
    { "x-flux-memory-app": "murage" },
    { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" },
    { "x-flux-memory-app": "murage", "x-flux-memory-space": "space-abc123", "x-flux-memory-read": "space-abc123,space-def456" },
  ];
  const py = (value: string, fn: string) => rig.py(`print(json.dumps(m.${fn}(sys.argv[2])))`, value).trim() === "true";
  it.each(decisions.map(h => [JSON.stringify(h), h] as const))("accepts fuigoConfigOverlay / opencodeConfigOverlay for %s", (_, headers) => {
    expect(py(fuigoConfigOverlay(headers), "fuigo_config_value")).toBe(true);
    expect(py(opencodeConfigOverlay("flux", headers), "opencode_config_value")).toBe(true);
  });
});

// A bot turn runs with the launcher's own serialization, which is the driver's applyOpenCodeTurnPermission output byte for byte.
const driverTurnConfig = (base: string): string => { const env: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: base }; applyOpenCodeTurnPermission(env); return env.OPENCODE_CONFIG_CONTENT!; };

// Fable follow-up 3: the OpenCode isolation writer (opencode-go.ts isolateOpenCodeFromPersonalSetup) rewrites OPENCODE_CONFIG_CONTENT
// after the memory overlay, adding `mcp:{<owner server>:{enabled:false}}`. Its real output, alone and on top of the overlay,
// must pass the launcher's opencode_config_value, or a Cloud turn with an owner MCP server loses the memory headers (now: is refused).
describe("OpenCode isolation writer (real isolateOpenCodeFromPersonalSetup)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "drift-opencode-home-")); });
  afterEach(() => removeTempDirSync(home));
  const ownerEnv = (names: string[]): Record<string, string | undefined> => {
    const file = join(home, "opencode.json");
    writeFileSync(file, JSON.stringify({ mcp: Object.fromEntries(names.map(n => [n, { type: "local", command: ["x"], enabled: true }])) }));
    return { HOME: home, OPENCODE_CONFIG: file };
  };
  const valid = (value: string) => rig.py("print(json.dumps(m.opencode_config_value(sys.argv[2])))", value).trim() === "true";
  const headers = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };
  it("accepts the isolation writer's output alone", () => {
    const env = ownerEnv(["composio", "my.server"]);
    isolateOpenCodeFromPersonalSetup(env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp).toEqual({ composio: { enabled: false }, "my.server": { enabled: false } });
    expect(valid(env.OPENCODE_CONFIG_CONTENT!)).toBe(true);
  });
  it.each(decisionHeaders().concat([headers]))("accepts the isolation writer on top of the memory overlay for %j", memory => {
    const env = ownerEnv(["composio"]);
    env.OPENCODE_CONFIG_CONTENT = opencodeConfigOverlay("flux", memory);
    isolateOpenCodeFromPersonalSetup(env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).mcp).toEqual({ composio: { enabled: false } });
    expect(valid(env.OPENCODE_CONFIG_CONTENT)).toBe(true);
    expect(rig.plan(rig.request("opencodeGo", { env: { OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT } })).ok?.env).toMatchObject({ OPENCODE_CONFIG_CONTENT: driverTurnConfig(env.OPENCODE_CONFIG_CONTENT) });
  });
});

// 1.0.4: a non-owner turn sends capture off AND inject off; an owner turn sends whatever the gates leave. Every audience's headers,
// built by the real fluxMemoryDecision, must pass all three validators (FUIGO_CONFIG, OPENCODE_CONFIG_CONTENT, GROK_CONFIG).
describe("Flux memory headers per audience (real fluxMemoryDecision)", () => {
  const base: FluxMemorySettings = { killSwitch: false, inject: "on", ownerMemory: "on", spaces: true, external: true };
  const salt = "fixture-salt";
  const spaces = computeFluxSpacePlan({ write: { kind: "bot", bot: "b1" }, read: [{ kind: "bot", bot: "b1" }, { kind: "bot-project", bot: "b1", project: "p1" }, { kind: "team", team: "t1" }, { kind: "shared" }], salt });
  const many = computeFluxSpacePlan({ write: { kind: "bot-team", bot: "b1", team: "t1" }, read: Array.from({ length: 12 }, (_, i) => ({ kind: "bot-project" as const, bot: "b1", project: `p${i}` })), salt });
  const owner = fluxMemoryContextForTurn({ warmIdentity: { audience: "owner", decidedOwner: true } } as never, { spaces });
  const cases: [string, ReturnType<typeof fluxMemoryDecision>][] = [
    ["non-owner", fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: { audience: "non-owner" } } as never, { spaces }), { settings: base })],
    ["non-owner (unproven owner)", fluxMemoryDecision(fluxMemoryContextForTurn({ warmIdentity: { audience: "owner", decidedOwner: false } } as never), { settings: base })],
    ["background", fluxMemoryDecision(fluxMemoryContextForTurn({ background: true } as never), { settings: base })],
    ["owner, capture and inject on", fluxMemoryDecision(owner, { settings: base })],
    ["owner, 8 read spaces", fluxMemoryDecision({ audience: "owner", spaces: many }, { settings: base })],
    ["owner, inject off", fluxMemoryDecision(owner, { settings: { ...base, inject: "off" } })],
    ["owner, asks first (off/off)", fluxMemoryDecision({ ...owner, asksFirst: true }, { settings: base })],
    ["owner, Flux memory off (off/off)", fluxMemoryDecision(owner, { settings: { ...base, external: false } })],
    ["owner, kill switch", fluxMemoryDecision(owner, { settings: { ...base, killSwitch: true } })],
    ["owner, breaker open", fluxMemoryDecision(owner, { settings: base, breaker: { isOpen: () => true } as FluxMemoryBreaker })],
  ];
  const ok = (value: string, fn: string) => rig.py(`print(json.dumps(m.${fn}(sys.argv[2])))`, value).trim() === "true";
  it("pins what each audience emits", () => {
    const by = Object.fromEntries(cases.map(([name, d]) => [name, d.headers]));
    expect(by["non-owner"]).toEqual({ "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" });
    expect(by["owner, capture and inject on"]).toHaveProperty("x-flux-memory-space");
    expect(by["owner, capture and inject on"]).toHaveProperty("x-flux-memory-read");
    expect(by["owner, 8 read spaces"]!["x-flux-memory-read"]!.split(",")).toHaveLength(8);
    expect(by["owner, inject off"]).toMatchObject({ "x-flux-memory-inject": "off" });
  });
  it.each(cases.map(([name, d]) => [name, d.headers] as const))("accepts %s in FUIGO_CONFIG, GROK_CONFIG and OPENCODE_CONFIG_CONTENT", (_, headers) => {
    expect(ok(fuigoConfigOverlay(headers), "fuigo_config_value")).toBe(true);
    expect(ok(opencodeConfigOverlay("flux", headers), "opencode_config_value")).toBe(true);
    const grok: Record<string, string | undefined> = {};
    applyGrokFluxMemory(grok, headers);
    expect(rig.plan(rig.request("grokAgent", { env: { GROK_CONFIG: grok.GROK_CONFIG } })).ok?.env.GROK_CONFIG).toBe(grok.GROK_CONFIG);
    expect(rig.plan(rig.request("fuigoAgent", { env: { FUIGO_CONFIG: fuigoConfigOverlay(headers) } })).ok?.env.FUIGO_CONFIG).toBe(fuigoConfigOverlay(headers));
    expect(rig.plan(rig.request("opencodeGo", { env: { OPENCODE_CONFIG_CONTENT: opencodeConfigOverlay("flux", headers) } })).ok?.env.OPENCODE_CONFIG_CONTENT).toBe(driverTurnConfig(opencodeConfigOverlay("flux", headers)));
  });
});

// B2: applyOpenCodeTurnPermission runs on every OpenCode spawn, so a Cloud OpenCode turn always carries its document.
describe("OpenCode turn permission document (real applyOpenCodeTurnPermission)", () => {
  const valid = (value: string) => rig.py("print(json.dumps(m.opencode_config_value(sys.argv[2])))", value).trim() === "true";
  const headers = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };
  it("accepts the permission document alone and on top of the memory overlay", () => {
    const alone: Record<string, string | undefined> = {};
    applyOpenCodeTurnPermission(alone);
    expect(valid(alone.OPENCODE_CONFIG_CONTENT!)).toBe(true);
    const env: Record<string, string | undefined> = { OPENCODE_CONFIG_CONTENT: opencodeConfigOverlay("flux", headers) };
    applyOpenCodeTurnPermission(env);
    expect(valid(env.OPENCODE_CONFIG_CONTENT!)).toBe(true);
    expect(rig.plan(rig.request("opencodeGo", { env: { OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT } })).ok?.env).toMatchObject({ OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT });
  });
  it("refuses a permission document that lets a tool that acts run unasked, or names an unknown key", () => {
    const env: Record<string, string | undefined> = {};
    applyOpenCodeTurnPermission(env);
    const doc = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(valid(JSON.stringify({ ...doc, permission: { ...doc.permission, bash: "allow" } }))).toBe(false);
    expect(valid(JSON.stringify({ ...doc, agent: { build: { permission: { "*": "allow" } } } }))).toBe(false);
    expect(valid(JSON.stringify({ ...doc, default_agent: "evil" }))).toBe(false);
    expect(valid(JSON.stringify({ ...doc, plugin: ["evil"] }))).toBe(false);
  });
});

// A3/B1: the Flux Memory headers ride the typed route and are rendered as the Codex provider table's http_headers.
describe("Codex route headers", () => {
  const route = (extra: Record<string, unknown>) => ({ provider: "flux-off", baseUrl: "https://api.fluxrouter.ai/v1", model: "flux-auto", apiKey: "fixture-key", label: "Flux Router", ...extra });
  const headers = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };
  it("renders http_headers inside the provider table", () => {
    const planned = rig.plan(rig.request("codex", { render: { route: route({ headers }) } }));
    expect(planned.error).toBeUndefined();
    const config = Object.entries(planned.ok!.files).find(([path]) => path.endsWith("config.toml"))![1] as string;
    expect(config).toContain("[model_providers.flux-off]");
    expect(config).toContain('http_headers = { "x-flux-memory-app" = "murage", "x-flux-memory-capture" = "off", "x-flux-memory-inject" = "off" }');
  });
  it("refuses a header that is not a Murage memory header, and headers on another engine", () => {
    expect(rig.plan(rig.request("codex", { render: { route: route({ headers: { "x-flux-memory-app": "murage", "x-evil": "1" } }) } })).error).toBe("Cloud turn render route headers are not allowed");
    expect(rig.plan(rig.request("fuigoAgent", { render: { route: route({ headers, protocol: "openai" }) } })).error).toBe("Cloud turn render route headers are not allowed");
  });
});
