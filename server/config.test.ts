import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customMcpServers,
  DATA_DIR,
  instanceConfigs,
  isValidSshAlias,
  loadBrowserProfileIdAliases,
  loadConfig,
  localVmMaxInstances,
  localVmMode,
  parseConfigPatch,
  parseStoredConfig,
  PROVIDER_CREDENTIAL_ENV,
  roomTurnTimeoutMinutes,
  showToolCallsEnabled,
  saveConfig,
  skillRecorderEnabled,
  builtInBrowserEnabled,
  browserProfilePartitionId,
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  browserProfileRoutingConflict,
  stripRoutingEnv,
  stripWorkspaceCredentialEnv,
  syncCredentialEnv,
  vpsSshAlias,
  withInstanceCli,
  WORKSPACE_CREDENTIAL_ENV,
  ROUTING_ENV,
  type AppConfig,
} from "./config.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

describe("explicit web search configuration", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); vi.stubEnv("MURAGE_TAVILY_SEARCH_KEY", undefined); vi.stubEnv("MURAGE_EXA_SEARCH_KEY", undefined); vi.stubEnv("MURAGE_FIRECRAWL_SEARCH_KEY", undefined); });
  afterEach(() => { rmSync(file, { force: true }); vi.unstubAllEnvs(); });

  it("preserves, hydrates, rotates and clears Firecrawl keys independently of provider selection", () => {
    saveConfig(parseConfigPatch({ webSearch: { provider: "firecrawl", firecrawlApiKey: "file-firecrawl", exaApiKey: "file-exa" } }));
    saveConfig({ webSearch: { provider: "auto" } });
    expect(loadConfig().webSearch).toEqual({ provider: "auto", firecrawlApiKey: "file-firecrawl", exaApiKey: "file-exa" });
    vi.stubEnv("MURAGE_FIRECRAWL_SEARCH_KEY", "encrypted-firecrawl");
    expect(loadConfig().webSearch?.firecrawlApiKey).toBe("encrypted-firecrawl");
    syncCredentialEnv({ webSearch: { firecrawlApiKey: "rotated-firecrawl" } });
    expect(loadConfig().webSearch?.firecrawlApiKey).toBe("rotated-firecrawl");
    saveConfig({ webSearch: { firecrawlApiKey: "" } });
    syncCredentialEnv({ webSearch: { firecrawlApiKey: "" } });
    expect(process.env.MURAGE_FIRECRAWL_SEARCH_KEY).toBeUndefined();
    expect(loadConfig().webSearch).toEqual({ provider: "auto", firecrawlApiKey: "", exaApiKey: "file-exa" });
    const env = { MURAGE_FIRECRAWL_SEARCH_KEY: "private-firecrawl", FIRECRAWL_API_KEY: "external-mcp-key" };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ FIRECRAWL_API_KEY: "external-mcp-key" });
    expect(() => parseConfigPatch({ webSearch: { firecrawlApiKey: 1 } })).toThrow();
  });

  it("persists and reloads selected search keys while provider-only updates preserve them", () => {
    saveConfig({ webSearch: { provider: "tavily", tavilyApiKey: "fake-tavily-key", exaApiKey: "fake-exa-key" } });
    expect(loadConfig().webSearch).toEqual({ provider: "tavily", tavilyApiKey: "fake-tavily-key", exaApiKey: "fake-exa-key" });
    saveConfig({ webSearch: { provider: "exa" } });
    expect(loadConfig().webSearch).toEqual({ provider: "exa", tavilyApiKey: "fake-tavily-key", exaApiKey: "fake-exa-key" });
    expect(JSON.parse(readFileSync(file, "utf8")).webSearch).toEqual(loadConfig().webSearch);
  });

  it("persists explicit empty-key clearing without removing the other provider key", () => {
    saveConfig({ webSearch: { provider: "tavily", tavilyApiKey: "fake-tavily-key", exaApiKey: "fake-exa-key" } });
    saveConfig({ webSearch: { provider: "off", tavilyApiKey: "" } });
    expect(loadConfig().webSearch).toEqual({ provider: "off", tavilyApiKey: "", exaApiKey: "fake-exa-key" });
  });

  it("supports key-only encrypted credential updates without changing the selected provider", () => {
    saveConfig({ webSearch: { provider: "exa", tavilyApiKey: "file-tavily", exaApiKey: "file-exa" } });
    const patch = parseConfigPatch({ webSearch: { tavilyApiKey: "new-tavily" } });
    saveConfig(patch);
    expect(loadConfig().webSearch).toEqual({ provider: "exa", tavilyApiKey: "new-tavily", exaApiKey: "file-exa" });
    expect(parseStoredConfig({ webSearch: { tavilyApiKey: "fixture" } }).webSearch?.provider).toBeUndefined();
  });

  it("hydrates and synchronizes only Murage-specific search keys and strips them from children", () => {
    saveConfig({ webSearch: { provider: "tavily", tavilyApiKey: "", exaApiKey: "" } });
    vi.stubEnv("TAVILY_API_KEY", "existing-engine-key");
    vi.stubEnv("EXA_API_KEY", "existing-mcp-key");
    vi.stubEnv("MURAGE_TAVILY_SEARCH_KEY", "encrypted-tavily");
    vi.stubEnv("MURAGE_EXA_SEARCH_KEY", "encrypted-exa");
    expect(loadConfig().webSearch).toEqual({ provider: "tavily", tavilyApiKey: "encrypted-tavily", exaApiKey: "encrypted-exa" });
    syncCredentialEnv({ webSearch: { tavilyApiKey: "rotated-tavily" } });
    expect(loadConfig().webSearch?.tavilyApiKey).toBe("rotated-tavily");
    syncCredentialEnv({ webSearch: { tavilyApiKey: "" } });
    expect(process.env.MURAGE_TAVILY_SEARCH_KEY).toBeUndefined();
    expect(loadConfig().webSearch?.tavilyApiKey).toBe("");
    expect(loadConfig().webSearch?.exaApiKey).toBe("encrypted-exa");
    const env = { MURAGE_TAVILY_SEARCH_KEY: "private-tavily", MURAGE_EXA_SEARCH_KEY: "private-exa", TAVILY_API_KEY: process.env.TAVILY_API_KEY, EXA_API_KEY: process.env.EXA_API_KEY };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ TAVILY_API_KEY: "existing-engine-key", EXA_API_KEY: "existing-mcp-key" });
  });

  it("validates the strict provider schema and leaves legacy engine search unchanged", () => {
    expect(parseStoredConfig({}).webSearch).toBeUndefined();
    for (const provider of ["engine", "tavily", "exa", "off"]) expect(parseConfigPatch({ webSearch: { provider } }).webSearch?.provider).toBe(provider);
    expect(() => parseConfigPatch({ webSearch: { provider: "unknown" } })).toThrow();
    expect(() => parseConfigPatch({ webSearch: { provider: "tavily", arbitraryEndpoint: "https://example.invalid" } })).toThrow();
    expect(() => parseConfigPatch({ webSearch: { provider: "exa", exaApiKey: 1 } })).toThrow();
    vi.stubEnv("TAVILY_API_KEY", "ambient-engine-tavily-key");
    vi.stubEnv("EXA_API_KEY", "ambient-engine-exa-key");
    expect(loadConfig().webSearch).toBeUndefined();
    const inherited = { TAVILY_API_KEY: process.env.TAVILY_API_KEY, EXA_API_KEY: process.env.EXA_API_KEY };
    stripWorkspaceCredentialEnv(inherited);
    expect(inherited).toEqual({ TAVILY_API_KEY: "ambient-engine-tavily-key", EXA_API_KEY: "ambient-engine-exa-key" });
  });
});

describe("notification preference configuration", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); });
  afterEach(() => { rmSync(file, { force: true }); });
  it("persists privacy and quiet hours while partial changes preserve false preferences", () => {
    const quietHours = { enabled: true, start: "22:00", end: "07:00", timeZone: "Asia/Bangkok" };
    saveConfig({ notifications: { attention: true, completion: false, failures: false, previewContent: false, quietHours } });
    const patch = parseConfigPatch({ notifications: { attention: false } });
    expect(patch.notifications).toEqual({ attention: false });
    saveConfig(patch);
    expect(loadConfig().notifications).toEqual({ attention: false, completion: false, failures: false, previewContent: false, quietHours });
    expect(JSON.parse(readFileSync(file, "utf8")).notifications).toEqual(loadConfig().notifications);
    expect(parseStoredConfig({}).notifications).toBeUndefined();
  });
  it.each([
    { enabled: true, start: "25:00", end: "07:00", timeZone: "UTC" },
    { enabled: true, start: "22:00", end: "07:00", timeZone: "Not/A_Zone" },
    { enabled: true, start: "22:00", end: "22:00", timeZone: "UTC" },
  ])("refuses invalid quiet-hours configuration without changing stored bytes: %j", quietHours => {
    writeFileSync(file, "{}");
    expect(() => saveConfig({ notifications: { quietHours } })).toThrow();
    expect(() => parseConfigPatch({ notifications: { quietHours } })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{}");
  });
});

describe("Telegram credential configuration", () => {
  const file = join(DATA_DIR, "config.json");
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); vi.stubEnv("MURAGE_TELEGRAM_BOT_TOKEN", undefined); });
  afterEach(() => { rmSync(file, { force: true }); vi.unstubAllEnvs(); });
  it("preserves target choice on key saves, hydrates private boot credentials and clears explicitly", () => {
    saveConfig({ telegram: { targetBotId: "fixture-bot", botToken: "old-fixture-token" } });
    saveConfig(parseConfigPatch({ telegram: { botToken: "new-fixture-token" } }));
    expect(loadConfig().telegram).toEqual({ targetBotId: "fixture-bot", botToken: "new-fixture-token" });
    vi.stubEnv("MURAGE_TELEGRAM_BOT_TOKEN", "encrypted-fixture-token");
    expect(loadConfig().telegram?.botToken).toBe("encrypted-fixture-token");
    saveConfig({ telegram: { botToken: "" } }); syncCredentialEnv({ telegram: { botToken: "" } });
    expect(loadConfig().telegram).toEqual({ targetBotId: "fixture-bot", botToken: "" });
    syncCredentialEnv({ telegram: { botToken: "rotated-fixture-token" } });
    expect(loadConfig().telegram?.botToken).toBe("rotated-fixture-token");
    const childEnv = { MURAGE_TELEGRAM_BOT_TOKEN: "private", TELEGRAM_BOT_TOKEN: "independent-tool" };
    stripWorkspaceCredentialEnv(childEnv);
    expect(childEnv).toEqual({ TELEGRAM_BOT_TOKEN: "independent-tool" });
  });
  it("rejects malformed and oversized fields without adding polling defaults", () => {
    expect(parseStoredConfig({}).telegram).toBeUndefined();
    const invalid: Array<Record<string, string | number | boolean>> = [{ botToken: 1 }, { botToken: "x".repeat(257) }, { targetBotId: "x".repeat(161) }, { polling: true }];
    for (const telegram of invalid) expect(() => parseConfigPatch({ telegram })).toThrow();
  });
});

describe("saved configuration recovery", () => {
  const file = join(DATA_DIR, "config.json");
  let loadConfig: typeof import("./config.ts").loadConfig;
  beforeEach(async () => {
    // setup.ts imports config before this file's fs mock. Reload the reader
    // so injected read errors hit the production read, not the assertion's
    // later inspection of unchanged bytes.
    vi.mocked(readFileSync).mockReset();
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
    vi.resetModules();
    loadConfig = (await import("./config.ts")).loadConfig;
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(file, { recursive: true, force: true });
  });
  afterEach(async () => {
    vi.mocked(readFileSync).mockReset();
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
    vi.unstubAllEnvs();
    rmSync(file, { recursive: true, force: true });
  });

  it("allows a truly missing file and valid empty config without requiring modern fields", () => {
    vi.stubEnv("XAI_API_KEY", "fixture-env-key");
    expect(loadConfig().xai?.key).toBe("fixture-env-key");
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "{}");
    expect(loadConfig().xai?.key).toBe("fixture-env-key");
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it.each([
    ["", "invalid-json"], ["{", "invalid-json"], ['{"private":"never-echo-this",', "invalid-json"],
    ["null", "invalid-shape"], ["[]", "invalid-shape"], ['"private-root"', "invalid-shape"],
    ['{"instances":{"bad":{"driver":42}}}', "invalid-shape"], ['{"profile":[]}', "invalid-shape"],
  ])("preserves damaged bytes and reports a sanitized recovery error for %j", (raw, reason) => {
    writeFileSync(file, raw);
    let failure: unknown;
    try { loadConfig(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "PERSISTED_STATE_RECOVERY_REQUIRED", filePath: file, reason });
    expect(String(failure)).not.toMatch(/never-echo-this|private-root|Unexpected token/);
    expect((failure as Error).cause).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOENT"])("does not discard an existing config after read error %s", (code) => {
    const raw = '{"profile":{"name":"Fixture owner"}}';
    writeFileSync(file, raw);
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("fixture read failed"), { code }); });
    expect(() => loadConfig()).toThrowError(expect.objectContaining({
      code: "PERSISTED_STATE_RECOVERY_REQUIRED", filePath: file, reason: "unreadable", readErrorCode: code,
    }));
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it.skipIf(process.platform === "win32")("does not mistake a dangling config link for a first run", () => {
    const target = join(DATA_DIR, "absent-config-target");
    symlinkSync(target, file);
    expect(() => loadConfig()).toThrowError(expect.objectContaining({ reason: "unreadable" }));
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

describe("legacy directory migration scope", () => {
  let fixtureHome: string;
  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "murage-config-migration-"));
    vi.stubEnv("HOME", fixtureHome);
    vi.stubEnv("USERPROFILE", fixtureHome);
    vi.stubEnv("MURAGE_DATA_DIR", undefined);
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(fixtureHome, { recursive: true, force: true });
  });
  const seedLegacy = () => {
    const legacy = join(fixtureHome, ".opengrokbot");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.json"), '{"profile":{"name":"Legacy fixture"}}');
    return legacy;
  };

  it("migrates the intended default directory and keeps valid legacy settings", async () => {
    const legacy = seedLegacy();
    const config = await import("./config.ts");
    config.ensureDirs();
    expect(existsSync(legacy)).toBe(false);
    expect(config.loadConfig().profile?.name).toBe("Legacy fixture");
    expect(existsSync(join(config.DATA_DIR, "events"))).toBe(true);
  });

  it.each(["custom", ".murage"])("an explicit %s override never adopts the default legacy directory", async (directory) => {
    const legacy = seedLegacy();
    const target = join(fixtureHome, directory);
    vi.stubEnv("MURAGE_DATA_DIR", target);
    const config = await import("./config.ts");
    config.ensureDirs();
    expect(readFileSync(join(legacy, "config.json"), "utf8")).toBe('{"profile":{"name":"Legacy fixture"}}');
    expect(existsSync(join(config.DATA_DIR, "config.json"))).toBe(false);
    expect(existsSync(join(config.DATA_DIR, "events"))).toBe(true);
  });

  it("does not migrate a legacy directory owned by another lease holder", async () => {
    const legacy = seedLegacy();
    const { acquireDataDirLease } = await import("../electron/data-dir-lease.mjs");
    const held = acquireDataDirLease(legacy);
    try {
      const config = await import("./config.ts");
      expect(() => config.ensureDirs()).toThrowError(expect.objectContaining({ code: "PERSISTED_STATE_RECOVERY_REQUIRED" }));
      expect(readFileSync(join(legacy, "config.json"), "utf8")).toContain("Legacy fixture");
      expect(existsSync(config.DATA_DIR)).toBe(false);
    } finally { held.release(); }
  });
});

describe("configuration boundaries", () => {
  it("keeps supported stored settings and drops unrelated top-level data", () => {
    expect(
      parseStoredConfig({
        profile: { name: "Ada", email: "ada@example.com" },
        instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
        unrelated: { secret: "not part of the config contract" },
      }),
    ).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("rejects malformed stored instances and API patches", () => {
    expect(() => parseStoredConfig({ instances: { claude: { driver: 42 } } })).toThrow("instances.claude.driver");
    expect(() => parseStoredConfig({ browserProfiles: [{ id: "../evil", name: "Unsafe" }] })).toThrow(
      "browserProfiles.0.id",
    );
    expect(() => parseConfigPatch({ opencodeGo: { apiKey: 42 } })).toThrow("opencodeGo.apiKey");
    expect(() => parseConfigPatch({ profile: [] })).toThrow("profile");
  });

  it("canonicalizes legacy browser profile ids without dropping other stored settings", () => {
    expect(parseStoredConfig({
      profile: { name: "Ada", email: "ada@example.com" },
      rooms: { turnTimeoutMinutes: 20 },
      features: { browser: true },
      browserProfiles: [
        { id: "Work", name: " Work " },
        { id: "Work", name: "Second workspace" },
      ],
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    })).toEqual({
      profile: { name: "Ada", email: "ada@example.com" },
      rooms: { turnTimeoutMinutes: 20 },
      features: { browser: true },
      browserProfiles: [
        { id: "work", name: "Work", partitionId: "Work" },
        { id: "work-2", name: "Second workspace" },
      ],
      instances: { claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } },
    });
  });

  it("preserves an unambiguous uppercase profile's exact durable partition", () => {
    const config = parseStoredConfig({
      browserProfiles: [{ id: "ClientA", name: "Client A" }],
    });
    expect(config.browserProfiles).toEqual([
      { id: "clienta", name: "Client A", partitionId: "ClientA" },
    ]);
    expect(browserProfilePartitionId(config.browserProfiles![0]!)).toBe("ClientA");
    expect(browserProfilePartitionTarget(config, "clienta")).toEqual({
      profileId: "clienta",
      partitionId: "ClientA",
    });
  });

  it("isolates case-colliding legacy profiles instead of sharing an account", () => {
    const config = parseStoredConfig({
      browserProfiles: [
        { id: "Work", name: "Uppercase" },
        { id: "work", name: "Canonical" },
      ],
    });
    expect(config.browserProfiles).toEqual([
      { id: "work-2", name: "Uppercase" },
      { id: "work", name: "Canonical" },
    ]);
    const partitions = config.browserProfiles!.map(browserProfilePartitionId);
    expect(new Set(partitions.map((id) => id.toLowerCase())).size).toBe(partitions.length);
  });

  it("reserves explicit suffix ids while isolating a case collision", () => {
    const config = parseStoredConfig({
      browserProfiles: [
        { id: "Work", name: "Uppercase" },
        { id: "work", name: "Canonical" },
        { id: "work-2", name: "Explicit suffix" },
      ],
    });
    expect(config.browserProfiles).toEqual([
      { id: "work-3", name: "Uppercase" },
      { id: "work", name: "Canonical" },
      { id: "work-2", name: "Explicit suffix" },
    ]);
    const partitions = config.browserProfiles!.map(browserProfilePartitionId);
    expect(new Set(partitions.map((id) => id.toLowerCase())).size).toBe(3);
  });

  it("round-trips migrated partition aliases idempotently", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "ClientA", name: "Client A" },
        { id: "Personal", name: "Personal" },
      ],
    });
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("keeps explicit suffix partitions owned by their own canonical profile", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "Foo", name: "Case collision" },
        { id: "FOO-2", name: "Explicit suffix" },
        { id: "foo", name: "Canonical" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: "foo-3", name: "Case collision" },
      { id: "foo-2", name: "Explicit suffix", partitionId: "FOO-2" },
      { id: "foo", name: "Canonical" },
    ]);
    const profiles = once.browserProfiles!;
    for (const [index, profile] of profiles.entries()) {
      const partition = browserProfilePartitionId(profile).toLowerCase();
      expect(
        profiles.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === partition),
      ).toBe(false);
    }
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("keeps legacy Guest isolated from an explicit Guest-2 profile", () => {
    const once = parseStoredConfig({
      browserProfiles: [
        { id: "Guest", name: "Legacy guest account" },
        { id: "Guest-2", name: "Explicit guest suffix" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: "guest-3", name: "Legacy guest account", partitionId: "Guest" },
      { id: "guest-2", name: "Explicit guest suffix", partitionId: "Guest-2" },
    ]);
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("repairs a prior cross-mapped partition without moving either exact legacy account", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      browserProfiles: [
        { id: "foo-2", name: "First", partitionId: "foo-2-2" },
        { id: "foo-2-2", name: "Second", partitionId: "FOO-2" },
        { id: "foo", name: "Canonical" },
      ],
    }));
    try {
      const once = loadConfig();
      expect(once.browserProfiles).toEqual([
        { id: "foo-2-3", name: "First", partitionId: "foo-2-2" },
        { id: "foo-2-2-2", name: "Second", partitionId: "FOO-2" },
        { id: "foo", name: "Canonical" },
      ]);
      const aliases = loadBrowserProfileIdAliases();
      const first = browserProfilePartitionTarget(once, aliases.get("foo-2")!);
      const second = browserProfilePartitionTarget(once, aliases.get("foo-2-2")!);
      expect(first).toEqual({ profileId: "foo-2-3", partitionId: "foo-2-2" });
      expect(second).toEqual({ profileId: "foo-2-2-2", partitionId: "FOO-2" });
      // config.json may not have been rewritten when bots.json is. A second
      // hydration of the same raw config must leave migrated references fixed
      // instead of toggling them through the old cross-map again.
      expect(aliases.get(first!.profileId) ?? first!.profileId).toBe(first!.profileId);
      expect(aliases.get(second!.profileId) ?? second!.profileId).toBe(second!.profileId);
      expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("keeps chained partition aliases fixed across repeated raw-config hydration", () => {
    const path = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({
      browserProfiles: [
        { id: "foo", name: "First", partitionId: "Bar" },
        { id: "bar", name: "Second", partitionId: "Baz" },
      ],
    }));
    try {
      const once = loadConfig();
      expect(once.browserProfiles).toEqual([
        { id: "foo", name: "First", partitionId: "Bar" },
        { id: "bar-2", name: "Second", partitionId: "Baz" },
      ]);
      const aliases = loadBrowserProfileIdAliases();
      const hydrate = (id: string) => aliases.get(id) ?? id;
      expect(hydrate("foo")).toBe("foo");
      expect(hydrate(hydrate("foo"))).toBe("foo");
      expect(hydrate("bar")).toBe("bar-2");
      expect(hydrate(hydrate("bar"))).toBe("bar-2");

      const first = browserProfilePartitionTarget(once, hydrate("foo"));
      const second = browserProfilePartitionTarget(once, hydrate("bar"));
      expect(first).toEqual({ profileId: "foo", partitionId: "Bar" });
      expect(second).toEqual({ profileId: "bar-2", partitionId: "Baz" });
      expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("blocks a new logical id from claiming another profile's retained partition", () => {
    const profiles = [
      { id: "client-repaired", name: "Existing", partitionId: "Client" },
      { id: "client", name: "New account" },
    ];
    expect(browserProfileRoutingConflict(profiles)).toMatch(/already used by another durable session/i);
  });

  it("blocks same-write reuse of a legacy partition that is being erased", () => {
    expect(browserProfileReplacementConflict(
      [{ id: "legacy-client", name: "Legacy", partitionId: "Client" }],
      [{ id: "client", name: "New account" }],
    )).toMatch(/delete it first, then add/i);
  });

  it("truncates 40-character collision suffixes without stealing an explicit id", () => {
    const base = "a".repeat(40);
    const explicitSuffix = `${"a".repeat(38)}-2`;
    const once = parseStoredConfig({
      browserProfiles: [
        { id: base.toUpperCase(), name: "Case collision" },
        { id: explicitSuffix.toUpperCase(), name: "Explicit suffix" },
        { id: base, name: "Canonical" },
      ],
    });
    expect(once.browserProfiles).toEqual([
      { id: `${"a".repeat(38)}-3`, name: "Case collision" },
      { id: explicitSuffix, name: "Explicit suffix", partitionId: explicitSuffix.toUpperCase() },
      { id: base, name: "Canonical" },
    ]);
    expect(once.browserProfiles!.every((profile) => profile.id.length <= 40)).toBe(true);
    expect(parseStoredConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("accepts only a simple VPS SSH config alias and exposes no credentials", () => {
    expect(isValidSshAlias("production-vps")).toBe(true);
    expect(isValidSshAlias("prod; reboot")).toBe(false);
    expect(() => parseConfigPatch({ vps: { sshAlias: "prod; reboot" } })).toThrow("vps.sshAlias");
    expect(parseConfigPatch({ vps: { sshAlias: "production-vps" } })).toEqual({
      vps: { sshAlias: "production-vps" },
    });
    expect(vpsSshAlias({ vps: { sshAlias: "production-vps" } })).toBe("production-vps");
    expect(vpsSshAlias({ vps: { sshAlias: "-bad" } })).toBeNull();
  });

  it("accepts a persisted global room turn timeout and supplies the legacy default", () => {
    expect(parseStoredConfig({ rooms: { turnTimeoutMinutes: 20 } })).toEqual({
      rooms: { turnTimeoutMinutes: 20 },
    });
    expect(roomTurnTimeoutMinutes({ rooms: { turnTimeoutMinutes: 20 } })).toBe(20);
    expect(roomTurnTimeoutMinutes({})).toBe(5);
  });

  it.each([0, 1.5, 1441, "20", null])(
    "rejects an invalid room turn timeout: %j",
    (turnTimeoutMinutes) => {
      expect(() => parseConfigPatch({ rooms: { turnTimeoutMinutes } })).toThrow(
        "rooms.turnTimeoutMinutes",
      );
    },
  );

  it("preserves shared Local VM behavior by default and accepts bounded per-bot mode", () => {
    expect(localVmMode({})).toBe("shared");
    expect(localVmMaxInstances({})).toBe(2);
    expect(parseConfigPatch({ localVm: { mode: "per-bot", maxInstances: 4 } })).toEqual({
      localVm: { mode: "per-bot", maxInstances: 4 },
    });
    expect(localVmMode({ localVm: { mode: "per-bot" } })).toBe("per-bot");
    expect(localVmMaxInstances({ localVm: { maxInstances: 3 } })).toBe(3);
  });

  it("keeps experimental features off by default and accepts an explicit opt-in", () => {
    expect(skillRecorderEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { skillRecorder: true } })).toEqual({
      features: { skillRecorder: true },
    });
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
    // the built-in browser is an independent explicit opt-in
    expect(builtInBrowserEnabled({})).toBe(false);
    expect(builtInBrowserEnabled({ features: { skillRecorder: true } })).toBe(false);
    expect(parseConfigPatch({ features: { browser: false } })).toEqual({ features: { browser: false } });
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
    // named browser profiles: the list is the unit, ids are partition-safe
    expect(parseConfigPatch({ browserProfiles: [{ id: "work", name: " Work " }] })).toEqual({
      browserProfiles: [{ id: "work", name: "Work" }],
    });
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "../evil", name: "x" }] })).toThrow(/browserProfiles.*id/i);
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "Work", name: "Work" }] })).toThrow(/browserProfiles.*id/i);
    expect(() => parseConfigPatch({
      browserProfiles: [{ id: "work", name: "Work", partitionId: "OtherAccount" }],
    })).toThrow(/browserProfiles/i);
    expect(() => parseConfigPatch({ browserProfiles: [{ id: "ok", name: "" }] })).toThrow(/browserProfiles.*name/i);
    expect(() => parseConfigPatch({
      browserProfiles: [{ id: "work", name: "Work" }, { id: "work", name: "Work again" }],
    })).toThrow(/browserProfiles.*id.*duplicated/i);
    expect(() => parseConfigPatch({ features: { skillRecorder: "yes" } })).toThrow(
      "features.skillRecorder",
    );
  });

  it("keeps tool-call chips off by default and accepts an explicit opt-in", () => {
    expect(showToolCallsEnabled({})).toBe(false);
    expect(parseConfigPatch({ features: { showToolCalls: true } })).toEqual({
      features: { showToolCalls: true },
    });
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it.each([0, 1.5, 5, "2", null])("rejects an invalid per-bot VM limit: %j", (maxInstances) => {
    expect(() => parseConfigPatch({ localVm: { maxInstances } })).toThrow("localVm.maxInstances");
  });

  it.each(["one-per-bot", "windows", 1, null])("rejects an invalid Local VM mode: %j", (mode) => {
    expect(() => parseConfigPatch({ localVm: { mode } })).toThrow("localVm.mode");
  });
});

describe("default fleet", () => {
  it("ships Qwen and Hermes as custom-only engines", () => {
    const map = instanceConfigs({});
    expect(map.qwen).toEqual({ driver: "qwenAgent", environment: {} });
    expect(map.hermes).toEqual({ driver: "hermesAgent", environment: {} });
  });

  it("ships Cursor as a default-fleet subscription engine", () => {
    const map = instanceConfigs({});
    expect(map.cursor).toEqual({ driver: "cursorAgent", environment: {} });
  });

  it("carries the saved OpenAI-compatible URL into the live default instance", () => {
    const map = instanceConfigs({
      openaiCompat: { key: "secret", url: "https://models.example.test/v1" },
    });
    expect(map.openaiCompat.config).toEqual({ url: "https://models.example.test/v1" });
    expect(map.openaiCompat.environment).toEqual({
      OPENAI_COMPAT_API_KEY: "secret",
      OPENAI_COMPAT_URL: "https://models.example.test/v1",
    });
  });

  it("preserves a per-instance OpenAI-compatible URL override", () => {
    const map = instanceConfigs({
      openaiCompat: { url: "https://workspace.example.test/v1" },
      instances: {
        custom: {
          driver: "openai-compat",
          config: { url: "https://instance.example.test/v1", apiKeyEnv: "CUSTOM_KEY" },
        },
      },
    });
    expect(map.custom.config).toEqual({
      url: "https://instance.example.test/v1",
      apiKeyEnv: "CUSTOM_KEY",
    });
  });

  it("does not retain an injected OpenAI-compatible URL across config refreshes", () => {
    const config: AppConfig = {
      openaiCompat: { url: "https://first.example.test/v1" },
      instances: {
        custom: { driver: "openai-compat" },
      },
    };

    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://first.example.test/v1",
    });
    config.openaiCompat = { url: "https://second.example.test/v1" };
    expect(instanceConfigs(config).custom.config).toEqual({
      url: "https://second.example.test/v1",
    });
    expect(config.instances?.custom.config).toBeUndefined();
  });

  it("adds missing custom-only engines onto an existing product fleet", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    expect(map.claude.driver).toBe("claudeAgent");
    expect(map.qwen?.driver).toBe("qwenAgent");
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(map.cursor?.driver).toBe("cursorAgent");
    expect(map.openaiCompat?.driver).toBe("openai-compat");
  });

  it("does not expand a one-off shadow fleet", () => {
    const map = instanceConfigs({ instances: { ghost: { driver: "not-a-real-driver" } } });
    expect(Object.keys(map)).toEqual(["ghost"]);
  });
});

describe("Instance CLI override", () => {
  it("sets, replaces, and clears config.cli on a default-fleet instance", () => {
    const cfg: AppConfig = {};
    const set = withInstanceCli(cfg, "claude", "/opt/claude-2.1/bin/claude");
    expect(set.ok).toBe(true);
    expect(set.config.instances!.claude.config).toEqual({ cli: "/opt/claude-2.1/bin/claude" });

    const replaced = withInstanceCli(set.config, "claude", "~/bin/claude");
    expect(replaced.config.instances!.claude.config).toEqual({ cli: "~/bin/claude" });

    const cleared = withInstanceCli(replaced.config, "claude", "");
    expect(cleared.config.instances!.claude.config).toBeUndefined();
  });

  it("preserves sibling config keys when clearing only cli", () => {
    const cfg: AppConfig = {
      instances: { claude: { driver: "claudeAgent", config: { cli: "/x/claude", permissionMode: "bypassPermissions" } } },
    };
    const cleared = withInstanceCli(cfg, "claude", "");
    expect(cleared.config.instances!.claude.config).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("leaves the original config untouched and rejects unknown instances", () => {
    const cfg: AppConfig = { instances: { codex: { driver: "codex" } } };
    const result = withInstanceCli(cfg, "codex", "/new/codex");
    expect(result.config.instances!.codex.config).toEqual({ cli: "/new/codex" });
    expect(cfg.instances!.codex.config).toBeUndefined();

    expect(withInstanceCli(cfg, "nope", "/x").ok).toBe(false);
  });

  it("never persists the credential env instanceConfigs injects", () => {
    // instanceConfigs() copies each credential into its consuming driver's
    // environment for the live fleet; withInstanceCli must strip those pairs
    // back out, or saving a CLI override would copy secrets into the
    // instances section of config.json.
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        claude: { driver: "claudeAgent" },
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
      },
    };
    const set = withInstanceCli(cfg, "claude", "/opt/claude");
    expect(set.ok).toBe(true);
    for (const entry of Object.values(set.config.instances!)) {
      expect(entry.environment ?? {}).toEqual({});
    }
    // user-authored env survives
    const custom = { instances: { claude: { driver: "claudeAgent", environment: { MY_FLAG: "1" } } } };
    const kept = withInstanceCli(custom, "claude", "/x");
    expect(kept.config.instances!.claude.environment).toEqual({ MY_FLAG: "1" });
  });
});

describe("OpenCode Go configuration", () => {
  it("injects the key only into OpenCode Go instances", () => {
    const cfg: AppConfig = {
      opencodeGo: { apiKey: "secret-value" },
      instances: {
        opencode: { driver: "opencodeGo" },
        grok: { driver: "grokAgent" },
      },
    };

    const instances = instanceConfigs(cfg);
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "secret-value" });
    expect(instances.grok.environment).toEqual({});
  });
});

describe("credential env narrowing", () => {
  it("injects each credential only into the driver that consumes it", () => {
    const cfg: AppConfig = {
      xai: { key: "SECRET-XAI" },
      box: { token: "SECRET-BOX" },
      opencodeGo: { apiKey: "SECRET-OCG" },
      instances: {
        grokApi: { driver: "grok" },
        computer: { driver: "boxAgent" },
        opencode: { driver: "opencodeGo" },
        claude: { driver: "claudeAgent" },
        codex: { driver: "codex" },
      },
    };
    const instances = instanceConfigs(cfg);
    expect(instances.grokApi.environment).toEqual({ XAI_API_KEY: "SECRET-XAI" });
    expect(instances.computer.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
    expect(instances.opencode.environment).toEqual({ OPENCODE_API_KEY: "SECRET-OCG" });
    // engines that bring their own login receive NO workspace credential
    expect(instances.claude.environment).toEqual({});
    expect(instances.codex.environment).toEqual({});
  });

  it("hands no credential to any default-fleet CLI engine except the Computer", () => {
    // the default `grok` instance is the CLI-login grokAgent, not the
    // API-key driver, so a configured xai key reaches nobody by default
    const cfg: AppConfig = { xai: { key: "SECRET-XAI" }, box: { token: "SECRET-BOX" } };
    const instances = instanceConfigs(cfg);
    for (const [id, entry] of Object.entries(instances)) {
      if (id === "computer") expect(entry.environment).toEqual({ BOX_TOKEN: "SECRET-BOX" });
      else expect(entry.environment).toEqual({});
    }
  });

  it("keeps a per-instance environment while layering the credential on top", () => {
    const cfg: AppConfig = {
      box: { token: "SECRET-BOX" },
      instances: { computer: { driver: "boxAgent", environment: { MY_FLAG: "1" } } },
    };
    expect(instanceConfigs(cfg).computer.environment).toEqual({ MY_FLAG: "1", BOX_TOKEN: "SECRET-BOX" });
  });
});

describe("credential env preference", () => {
  const VARS = [
    "XAI_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_COMPAT_URL",
    "OPENAI_COMPAT_MODEL",
    "OPENAI_COMPAT_PROVIDER",
    "BOX_TOKEN",
    "OPENCODE_API_KEY",
    "MURAGE_TTS_KEY",
    "MURAGE_OPENAI_IMAGE_KEY",
    "COMPOSIO_API_KEY",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });
  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  it("prefers env over the config file for every credential", () => {
    // the desktop shell hands secrets to this process as env (from its
    // OS-encrypted store) and leaves the file without them — env must win
    // even over a leftover plaintext value
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        xai: { key: "file-xai", url: "https://api.example.test/v1" },
        box: { token: "file-box" },
        opencodeGo: { apiKey: "file-ocg" },
        tts: { key: "file-tts", voice: "narrator" },
        imageGen: { key: "file-image" },
      }),
    );
    process.env.XAI_API_KEY = "env-xai";
    process.env.BOX_TOKEN = "env-box";
    process.env.OPENCODE_API_KEY = "env-ocg";
    process.env.MURAGE_TTS_KEY = "env-tts";
    process.env.MURAGE_OPENAI_IMAGE_KEY = "env-image";
    const cfg = loadConfig();
    expect(cfg.xai).toEqual({ key: "env-xai", url: "https://api.example.test/v1" });
    expect(cfg.box).toEqual({ token: "env-box" });
    expect(cfg.opencodeGo).toEqual({ apiKey: "env-ocg" });
    expect(cfg.tts).toEqual({ key: "env-tts", voice: "narrator" });
    expect(cfg.imageGen).toEqual({ key: "env-image" });
  });

  it("falls back to the config file when the env var is unset (dev mode)", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ xai: { key: "file-xai" }, tts: { key: "file-tts" }, imageGen: { key: "file-image" } }),
    );
    const cfg = loadConfig();
    expect(cfg.xai?.key).toBe("file-xai");
    expect(cfg.tts?.key).toBe("file-tts");
    expect(cfg.imageGen?.key).toBe("file-image");
  });

  it("loads legacy browser profiles without resetting config and canonicalizes them on the next write", () => {
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, JSON.stringify({
      xai: { key: "file-xai", url: "https://api.example.test/v1" },
      profile: { name: "Ada" },
      features: { browser: true },
      browserProfiles: [
        { id: "Client", name: "Client one" },
        { id: "Client", name: "Client two" },
      ],
      futureSetting: { keep: true },
    }));

    expect(loadConfig()).toMatchObject({
      xai: { key: "file-xai", url: "https://api.example.test/v1" },
      profile: { name: "Ada" },
      features: { browser: true },
      browserProfiles: [
        { id: "client", name: "Client one", partitionId: "Client" },
        { id: "client-2", name: "Client two" },
      ],
    });

    saveConfig({ features: { showToolCalls: true } });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted).toMatchObject({
      xai: { key: "file-xai", url: "https://api.example.test/v1" },
      profile: { name: "Ada" },
      features: { browser: true, showToolCalls: true },
      browserProfiles: [
        { id: "client", name: "Client one", partitionId: "Client" },
        { id: "client-2", name: "Client two" },
      ],
      futureSetting: { keep: true },
    });

    // A public list replacement cannot choose an alias, but an unchanged id
    // keeps the internal durable partition through a rename.
    saveConfig({ browserProfiles: [
      { id: "client", name: "Renamed client" },
      { id: "client-2", name: "Client two" },
    ] });
    const renamed = JSON.parse(readFileSync(path, "utf8"));
    expect(renamed.browserProfiles).toEqual([
      { id: "client", name: "Renamed client", partitionId: "Client" },
      { id: "client-2", name: "Client two" },
    ]);
  });

  it("treats a blanked file field as absent when env supplies the secret", () => {
    // after migration the desktop shell may leave "" behind (a cleared key
    // that was saved mid-session); the env-injected value must still win
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ xai: { key: "" } }));
    process.env.XAI_API_KEY = "env-xai";
    expect(loadConfig().xai?.key).toBe("env-xai");
  });

  it("syncCredentialEnv keeps process.env in step with a credential save", () => {
    process.env.XAI_API_KEY = "boot-injected";
    process.env.BOX_TOKEN = "boot-injected";
    process.env.COMPOSIO_API_KEY = "boot-injected";
    syncCredentialEnv({
      xai: { key: "just-saved" },
      composio: { apiKey: "ak_just_saved" },
      box: { token: "" },
      profile: { name: "Ada" },
    });
    // a saved value replaces the boot-time one; a cleared value drops it;
    // untouched sections change nothing
    expect(process.env.XAI_API_KEY).toBe("just-saved");
    expect(process.env.COMPOSIO_API_KEY).toBe("ak_just_saved");
    expect(process.env.BOX_TOKEN).toBeUndefined();
    expect(process.env.MURAGE_TTS_KEY).toBeUndefined();
  });

  it("syncCredentialEnv keeps model and provider env in step with a save", () => {
    // loadConfig() prefers OPENAI_COMPAT_MODEL/PROVIDER over the file, so a
    // mid-session save must update them like key/url or the boot-injected
    // values shadow the save until relaunch
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({
      openaiCompat: { model: "vendor/just-saved", provider: "fireworks" },
    });
    expect(process.env.OPENAI_COMPAT_MODEL).toBe("vendor/just-saved");
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBe("fireworks");
  });

  it("syncCredentialEnv clears model and provider env on an empty-string save", () => {
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({ openaiCompat: { model: "", provider: "" } });
    expect(process.env.OPENAI_COMPAT_MODEL).toBeUndefined();
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBeUndefined();
  });

  it("syncCredentialEnv leaves model and provider env untouched when absent from the patch", () => {
    process.env.OPENAI_COMPAT_MODEL = "boot-model";
    process.env.OPENAI_COMPAT_PROVIDER = "boot-provider";
    syncCredentialEnv({ openaiCompat: { key: "just-saved" } });
    expect(process.env.OPENAI_COMPAT_MODEL).toBe("boot-model");
    expect(process.env.OPENAI_COMPAT_PROVIDER).toBe("boot-provider");
  });
});

describe("workspace credential env strip", () => {
  it("removes every workspace credential from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(WORKSPACE_CREDENTIAL_ENV.map((name) => [name, "secret"])),
    };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("covers in-process secrets and private app-state paths", () => {
    // These secrets have no per-driver ACP allowlist entry anywhere — they are
    // consumed in-process (Computer driver / voice module), never by a CLI
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("BOX_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_TTS_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_OPENAI_IMAGE_KEY");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_BROWSER_CONNECTION");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_USER_DATA");
  });

  it("keeps both connected-apps broker tokens out of every engine", () => {
    // Engines DO receive the Flux API key — `applyFluxSurface` hands it to the
    // claude CLI as ANTHROPIC_API_KEY — which is exactly why connected apps
    // are unlocked by a separate token instead. If that token travelled with
    // the key, any shell command a model ran could reach the owner's Gmail
    // past the per-bot policy that only the harness enforces.
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_COMPOSIO_BROKER_TOKEN");
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_FLUX_COMPOSIO_BROKER_TOKEN");
  });
});

describe("routing env strip", () => {
  it("removes every ambient routing switch from a child env in place", () => {
    const env = {
      PATH: "/usr/bin",
      MY_FLAG: "1",
      ...Object.fromEntries(ROUTING_ENV.map((name) => [name, "http://leftover.example"])),
    };
    stripRoutingEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", MY_FLAG: "1" });
  });

  it("names the switches a provider switcher leaves in the user's shell", () => {
    // cc-switch and friends export these; every spawn path spreads
    // `...process.env`, so leaving any of them would silently redirect a turn
    expect(ROUTING_ENV).toContain("ANTHROPIC_BASE_URL");
    expect(ROUTING_ENV).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(ROUTING_ENV).toContain("ANTHROPIC_MODEL");
    expect(ROUTING_ENV).toContain("OPENAI_BASE_URL");
    expect(ROUTING_ENV).toContain("OPENAI_MODEL");
  });

  it("carries no credential, so the two lists stay disjoint", () => {
    // A routing switch is never allowlistable via a driver's `credentialEnv`:
    // that grant is for keys. Overlap would make one grantable by accident.
    const credentials = new Set<string>([...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV]);
    expect(ROUTING_ENV.filter((name) => credentials.has(name))).toEqual([]);
  });

  it("keeps the routing INPUTS a driver needs to work", () => {
    // Each of these is read by the harness or a driver as a required input,
    // not left behind by a shell overlay — stripping them breaks real turns.
    for (const keep of ["UNSLOTH_STUDIO_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "KIMI_MODEL_BASE_URL", "MINIMAX_BASE_URL"]) {
      expect(ROUTING_ENV).not.toContain(keep);
    }
  });
});

describe("customMcpServers", () => {
  const cfg = (mcpServers: Record<string, unknown>) =>
    ({ mcpServers }) as Parameters<typeof customMcpServers>[0];

  it("normalizes a valid stdio entry and defaults args/env", () => {
    expect(
      customMcpServers(
        cfg({
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "t" } },
          bare: { command: "/usr/local/bin/server" },
        }),
      ),
    ).toEqual({
      notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "t" } },
      bare: { command: "/usr/local/bin/server", args: [], env: {} },
    });
  });

  it("returns {} when the section is absent", () => {
    expect(customMcpServers({} as Parameters<typeof customMcpServers>[0])).toEqual({});
  });

  it("skips disabled entries silently", () => {
    expect(customMcpServers(cfg({ off: { command: "x", enabled: false } }))).toEqual({});
  });

  it("skips reserved names — a custom entry can never shadow a built-in", () => {
    const out = customMcpServers(
      cfg({
        muragebox: { command: "evil" },
        computer: { command: "evil" },
        agents: { command: "evil" },
        fine: { command: "ok" },
      }),
    );
    expect(Object.keys(out)).toEqual(["fine"]);
  });

  it("skips names that could not survive every driver's namespace", () => {
    const out = customMcpServers(
      cfg({
        "Bad.Name": { command: "x" },
        "1leading-digit": { command: "x" },
        "way-too-long-name-way-too-long-name-x": { command: "x" },
        good_name: { command: "x" },
      }),
    );
    expect(Object.keys(out)).toEqual(["good_name"]);
  });

  it("skips saved entries with reserved environment names, preserving valid siblings and the config", () => {
    const config = cfg({
      ...Object.fromEntries([
        "MURAGE_COMMS_TOKEN", "murage_harness_url", "MURAGEBOX_TOKEN", "muragebox_url",
        "ELECTRON_RUN_AS_NODE", "electron_run_as_node", "DWEB_URL", "dweb_url",
        "PH_ANDROID_SERIAL", "ph_android_serial",
      ].map((key, index) => [`blocked${index}`, { command: "blocked", env: { [key]: "private-value" } }])),
      notes: { command: "notes", env: { NOTES_TOKEN: "notes-token" } },
    });
    const before = JSON.stringify(config);
    expect(customMcpServers(config)).toEqual({
      notes: { command: "notes", args: [], env: { NOTES_TOKEN: "notes-token" } },
    });
    expect(JSON.stringify(config)).toBe(before);
  });

  it("skips url transports with a teaching message, not a crash", () => {
    expect(customMcpServers(cfg({ api: { url: "https://x/mcp" } }))).toEqual({});
  });

  it("skips malformed entries without dropping the valid ones", () => {
    const out = customMcpServers(
      cfg({
        broken: { args: ["no-command"] },
        alsoBad: "not-an-object",
        keeper: { command: "ok" },
      }),
    );
    expect(Object.keys(out)).toEqual(["keeper"]);
  });
});
