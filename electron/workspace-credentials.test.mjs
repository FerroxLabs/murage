import { describe, expect, it } from "vitest";

import {
  migrateMcpServerSecrets,
  dropMcpServerSecrets,
  migrateWorkspaceCredentials,
  projectMcpServerSecrets,
  workspaceCredentialEnv,
  WORKSPACE_CREDENTIALS,
} from "./workspace-credentials.mjs";

describe("workspace credential migration", () => {
  it("migrates Firecrawl custody through reboot and clear without changing other search credentials", () => {
    const config = { webSearch: { provider: "firecrawl", firecrawlApiKey: "fake-firecrawl", tavilyApiKey: "fake-tavily" } };
    const migrated = migrateWorkspaceCredentials(config, {});
    expect(migrated.config).toEqual({ webSearch: { provider: "firecrawl" } });
    expect(migrated.credentials).toEqual({ firecrawlSearchApiKey: "fake-firecrawl", tavilySearchApiKey: "fake-tavily" });
    const reboot = migrateWorkspaceCredentials({ webSearch: { provider: "firecrawl", firecrawlApiKey: "" } }, migrated.credentials);
    expect(workspaceCredentialEnv(reboot.credentials)).toEqual({ MURAGE_FIRECRAWL_SEARCH_KEY: "fake-firecrawl", MURAGE_TAVILY_SEARCH_KEY: "fake-tavily" });
    const cleared = migrateWorkspaceCredentials({ webSearch: { provider: "firecrawl", firecrawlApiKey: "" } }, { tavilySearchApiKey: "fake-tavily" });
    expect(workspaceCredentialEnv(cleared.credentials)).toEqual({ MURAGE_TAVILY_SEARCH_KEY: "fake-tavily" });
    expect(cleared.config.webSearch.provider).toBe("firecrawl");
  });
  it("migrates Telegram custody without changing the target or resurrecting cleared tokens", () => {
    const migrated = migrateWorkspaceCredentials({ telegram: { botToken: "fake-bot-token", targetBotId: "chosen-bot" } }, {});
    expect(migrated.config).toEqual({ telegram: { targetBotId: "chosen-bot" } });
    expect(migrated.credentials).toEqual({ telegramBotToken: "fake-bot-token" });
    const reboot = migrateWorkspaceCredentials({ telegram: { botToken: "", targetBotId: "chosen-bot" } }, migrated.credentials);
    expect(workspaceCredentialEnv(reboot.credentials)).toEqual({ MURAGE_TELEGRAM_BOT_TOKEN: "fake-bot-token" });
    const cleared = migrateWorkspaceCredentials({ telegram: { botToken: "", targetBotId: "chosen-bot" } }, {});
    expect(workspaceCredentialEnv(cleared.credentials)).toEqual({});
    expect(cleared.config.telegram.targetBotId).toBe("chosen-bot");
  });
  it("moves search keys into the encrypted document and preserves provider choice across tombstone/reboot/clear", () => {
    const config = { webSearch: { provider: "exa", tavilyApiKey: "fake-tavily", exaApiKey: "fake-exa" } };
    const migrated = migrateWorkspaceCredentials(config, {});
    expect(migrated.config).toEqual({ webSearch: { provider: "exa" } });
    expect(migrated.credentials).toEqual({ tavilySearchApiKey: "fake-tavily", exaSearchApiKey: "fake-exa" });
    expect(config.webSearch.tavilyApiKey).toBe("fake-tavily");
    const reboot = migrateWorkspaceCredentials({ webSearch: { provider: "exa", tavilyApiKey: "", exaApiKey: "" } }, migrated.credentials);
    expect(reboot.credentials).toEqual(migrated.credentials);
    expect(workspaceCredentialEnv(reboot.credentials)).toEqual({ MURAGE_TAVILY_SEARCH_KEY: "fake-tavily", MURAGE_EXA_SEARCH_KEY: "fake-exa" });
    // credential:set removes the actual encrypted entry on clear; its
    // plaintext tombstone must not resurrect that key at the next boot.
    const cleared = migrateWorkspaceCredentials({ webSearch: { provider: "exa", tavilyApiKey: "" } }, { exaSearchApiKey: "fake-exa" });
    expect(workspaceCredentialEnv(cleared.credentials)).toEqual({ MURAGE_EXA_SEARCH_KEY: "fake-exa" });
    expect(cleared.config.webSearch.provider).toBe("exa");
  });

  it("moves every plaintext secret into the store and deletes the field", () => {
    const config = {
      xai: { key: "xai-secret", url: "https://api.example.test/v1" },
      box: { token: "box-secret" },
      tts: { key: "tts-secret", voice: "narrator" },
      imageGen: { key: "image-secret" },
      opencodeGo: { apiKey: "ocg-secret" },
      profile: { name: "Ada" },
    };
    const result = migrateWorkspaceCredentials(config, {});
    expect(result.configChanged).toBe(true);
    expect(result.credentialsChanged).toBe(true);
    expect(result.credentials).toEqual({
      xaiApiKey: "xai-secret",
      boxToken: "box-secret",
      ttsKey: "tts-secret",
      opencodeGoApiKey: "ocg-secret",
      openaiImageApiKey: "image-secret",
    });
    // secrets are DELETED (not blanked) so "" stays meaningful as "cleared";
    // non-secret siblings (endpoint url, chosen voice) stay in the file
    expect(result.config).toEqual({
      xai: { url: "https://api.example.test/v1" },
      box: {},
      tts: { voice: "narrator" },
      imageGen: {},
      opencodeGo: {},
      profile: { name: "Ada" },
    });
    // inputs are never mutated — main.mjs decides which files to rewrite
    expect(config.xai.key).toBe("xai-secret");
  });

  it("is idempotent: a second boot over migrated output changes nothing", () => {
    const first = migrateWorkspaceCredentials(
      { xai: { key: "xai-secret" }, tts: { key: "tts-secret", voice: "narrator" } },
      {},
    );
    const second = migrateWorkspaceCredentials(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.credentials).toEqual(first.credentials);
    expect(second.config).toEqual(first.config);
  });

  it("treats a saved non-empty value as newest intent and overwrites the store", () => {
    // mid-session key change: the server persisted the new key to config.json;
    // the stale stored secret must not win at the next boot
    const result = migrateWorkspaceCredentials(
      { box: { token: "box-NEW" } },
      { boxToken: "box-OLD", xaiApiKey: "xai-keep" },
    );
    expect(result.credentials).toEqual({ boxToken: "box-NEW", xaiApiKey: "xai-keep" });
    expect(result.config.box).toEqual({});
  });

  it("treats an empty saved value as no information and keeps the stored secret", () => {
    // The packaged app tombstones every external-mode save as "" in
    // config.json while the real key goes to credentials.bin — a boot that
    // read "" as "cleared" would delete freshly saved keys on every restart.
    const result = migrateWorkspaceCredentials(
      { xai: { key: "" }, tts: { key: "   " } },
      { xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" },
    );
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual({ xaiApiKey: "xai-OLD", ttsKey: "tts-OLD", boxToken: "box-keep" });
    // the swept field itself is still removed from the file
    expect(result.config).toEqual({ xai: {}, tts: {} });
    expect(result.configChanged).toBe(true);
  });

  it("keeps the packaged save → restart cycle lossless end to end", () => {
    // first boot migrates the plaintext key in and sweeps the field
    const boot = migrateWorkspaceCredentials({ opencodeGo: { apiKey: "ocg-secret" } }, {});
    expect(boot.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });

    // an external-mode save commits the key to the store and leaves a ""
    // tombstone in config.json; the next boot must not read it as a clear
    const afterTombstone = migrateWorkspaceCredentials(
      { opencodeGo: { apiKey: "" }, profile: { name: "Ada" } },
      { opencodeGoApiKey: "ocg-secret" },
    );
    expect(afterTombstone.credentials).toEqual({ opencodeGoApiKey: "ocg-secret" });
    expect(afterTombstone.credentialsChanged).toBe(false);
  });

  it("keeps stored secrets when the field is absent (already migrated)", () => {
    const stored = { xaiApiKey: "xai-keep", boxToken: "box-keep" };
    const result = migrateWorkspaceCredentials({ profile: { name: "Ada" } }, stored);
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.credentials).toEqual(stored);
  });

  it("leaves non-string junk for the server's schema instead of destroying it", () => {
    const result = migrateWorkspaceCredentials({ xai: { key: 42 }, box: "not-an-object" }, {});
    expect(result.configChanged).toBe(false);
    expect(result.credentialsChanged).toBe(false);
    expect(result.config.xai.key).toBe(42);
  });
});

describe("workspace credential env", () => {
  it("maps each stored secret to exactly its server env var", () => {
    expect(
      workspaceCredentialEnv({
        xaiApiKey: "xai-secret",
        boxToken: "box-secret",
        ttsKey: "tts-secret",
        opencodeGoApiKey: "ocg-secret",
        openaiImageApiKey: "image-secret",
        composioApiKey: "ak_handled-separately",
      }),
    ).toEqual({
      XAI_API_KEY: "xai-secret",
      BOX_TOKEN: "box-secret",
      MURAGE_TTS_KEY: "tts-secret",
      OPENCODE_API_KEY: "ocg-secret",
      MURAGE_OPENAI_IMAGE_KEY: "image-secret",
    });
  });

  it("emits nothing for absent or empty secrets", () => {
    expect(workspaceCredentialEnv({})).toEqual({});
    expect(workspaceCredentialEnv({ xaiApiKey: "" })).toEqual({});
    expect(workspaceCredentialEnv(undefined)).toEqual({});
  });

  it("covers every credential the migration table declares", () => {
    const credentials = Object.fromEntries(WORKSPACE_CREDENTIALS.map((c) => [c.name, `v-${c.name}`]));
    const env = workspaceCredentialEnv(credentials);
    expect(Object.keys(env).sort()).toEqual(WORKSPACE_CREDENTIALS.map((c) => c.env).sort());
  });
});

describe("servers added by link: custody (spec MCP-LINK 3.4)", () => {
  const TOKEN_URL = "https://mcp.zapier.com/api/mcp/s/abcdefghijklmnopqrstuvwx/mcp";
  const config = () => ({
    mcpServers: {
      keyed: { url: "https://x.example/mcp", auth: "header", headers: { "X-API-Key": "sk-live-PLAINTEXT", "X-Keep": true }, enabled: true },
      zap: { url: TOKEN_URL, enabled: true },
      queryKey: { url: "https://q.example/mcp?key=QSECRET", enabled: true },
      plain: { url: "https://cloud.comfy.org/mcp", enabled: false },
      notes: { command: "npx", env: { NOTES_TOKEN: "stdio-plaintext-stays-for-T16" } },
    },
  });

  it("moves a string header value into the store and leaves true behind", () => {
    const migrated = migrateMcpServerSecrets(config(), {});
    expect(migrated.config.mcpServers.keyed.headers).toEqual({ "X-API-Key": true, "X-Keep": true });
    expect(migrated.credentials.mcpServerSecrets.keyed).toEqual({ headers: { "X-API-Key": "sk-live-PLAINTEXT" }, origin: "https://x.example" });
    expect(migrated.configChanged && migrated.credentialsChanged).toBe(true);
    expect(JSON.stringify(migrated.config)).not.toContain("sk-live-PLAINTEXT");
  });

  it("moves a secret-bearing link into the store and leaves a masked, marked link", () => {
    const migrated = migrateMcpServerSecrets(config(), {});
    expect(migrated.config.mcpServers.zap).toEqual({ url: "https://mcp.zapier.com/api/mcp/s/\u2022\u2022\u2022/mcp", urlSecret: true, enabled: true });
    expect(migrated.credentials.mcpServerSecrets.zap).toEqual({ url: TOKEN_URL, origin: "https://mcp.zapier.com" });
    expect(migrated.config.mcpServers.queryKey).toMatchObject({ url: "https://q.example/mcp", urlSecret: true });
    expect(migrated.credentials.mcpServerSecrets.queryKey.url).toBe("https://q.example/mcp?key=QSECRET");
    expect(JSON.stringify(migrated.config)).not.toMatch(/abcdefghijklmnopqrstuvwx|QSECRET/);
  });

  it("leaves a plain link alone", () => {
    const migrated = migrateMcpServerSecrets(config(), {});
    expect(migrated.config.mcpServers.plain).toEqual({ url: "https://cloud.comfy.org/mcp", enabled: false });
    expect(migrated.credentials.mcpServerSecrets.plain).toBeUndefined();
  });

  it("a second run is a no-op and true placeholders stay", () => {
    const first = migrateMcpServerSecrets(config(), {});
    const second = migrateMcpServerSecrets(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(second.credentials).toEqual(first.credentials);
  });

  it("a newer plaintext value overwrites the stored one, and merges beside other stored headers", () => {
    const credentials = { mcpServerSecrets: { keyed: { origin: "https://x.example", headers: { "X-Old": "keep-me", "X-API-Key": "stale" } } } };
    const migrated = migrateMcpServerSecrets(config(), credentials);
    expect(migrated.credentials.mcpServerSecrets.keyed.headers).toEqual({ "X-Old": "keep-me", "X-API-Key": "sk-live-PLAINTEXT" });
    expect(credentials.mcpServerSecrets.keyed.headers["X-API-Key"]).toBe("stale"); // input untouched
  });

  it("an empty string header never drops a stored secret", () => {
    const credentials = { mcpServerSecrets: { keyed: { origin: "https://x.example", headers: { "X-API-Key": "stored" } } } };
    const migrated = migrateMcpServerSecrets({ mcpServers: { keyed: { url: "https://x.example/mcp", headers: { "X-API-Key": "" } } } }, credentials);
    expect(migrated.credentialsChanged).toBe(false);
    expect(migrated.credentials.mcpServerSecrets.keyed.headers["X-API-Key"]).toBe("stored");
  });

  it("does nothing while the encrypted store is unavailable, so the plaintext is never the only lost copy", () => {
    const input = config();
    const migrated = migrateMcpServerSecrets(input, {}, { storeAvailable: false });
    expect(migrated.configChanged).toBe(false);
    expect(migrated.credentialsChanged).toBe(false);
    expect(migrated.config).toEqual(config());
    expect(JSON.stringify(migrated.config)).toContain("sk-live-PLAINTEXT");
  });

  it("tolerates a config with no servers, junk entries and __proto__", () => {
    expect(migrateMcpServerSecrets({}, {}).configChanged).toBe(false);
    expect(migrateMcpServerSecrets({ mcpServers: { a: 5, b: null, c: [], d: { url: 5 } } }, {}).configChanged).toBe(false);
    const hostile = JSON.parse('{"mcpServers":{"__proto__":{"url":"https://x.example/mcp?k=1"}}}');
    expect(migrateMcpServerSecrets(hostile, {}).credentialsChanged).toBe(false);
    expect(({}).polluted).toBeUndefined();
  });

  it("the server child gets header values, the link and the access token, and never a refresh token or client secret", () => {
    const credentials = {
      mcpServerSecrets: {
        comfy: {
          headers: { "X-API-Key": "k-1" }, url: TOKEN_URL,
          oauth: { issuer: "https://as", clientId: "c", clientSecret: "CLIENT-SECRET", refreshToken: "REFRESH-SECRET", accessToken: "at-1", expiresAt: 99 },
        },
        empty: { oauth: { refreshToken: "only-a-refresh-token" } },
      },
    };
    const env = workspaceCredentialEnv(credentials);
    expect(JSON.parse(env.MURAGE_MCP_SERVER_SECRETS)).toEqual({ comfy: { headers: { "X-API-Key": "k-1" }, url: TOKEN_URL, oauth: { accessToken: "at-1", expiresAt: 99 } } });
    expect(env.MURAGE_MCP_SERVER_SECRETS).not.toMatch(/REFRESH-SECRET|CLIENT-SECRET|only-a-refresh-token/);
    expect(workspaceCredentialEnv({})).toEqual({});
    expect(workspaceCredentialEnv({ mcpServerSecrets: {} })).toEqual({});
  });

  it("projectMcpServerSecrets hands over when the access token was issued and its scope, never the refresh token", () => {
    expect(projectMcpServerSecrets({ a: { origin: "https://a.example", oauth: { accessToken: "at", issuedAt: 7, scope: "x y", refreshToken: "rt-SECRET", clientId: "c" } } }))
      .toEqual({ a: { origin: "https://a.example", oauth: { accessToken: "at", issuedAt: 7, scope: "x y" } } });
    expect(projectMcpServerSecrets({ a: { oauth: { accessToken: "at", signedInAt: 9, refreshToken: "rt" } } })).toEqual({ a: { oauth: { accessToken: "at", signedInAt: 9 } } });
    expect(projectMcpServerSecrets({ a: { oauth: { accessToken: "at", issuedAt: "7", scope: 5 } } })).toEqual({ a: { oauth: { accessToken: "at" } } });
    expect(projectMcpServerSecrets({ a: { oauth: { accessToken: "at", issuedAt: Number.NaN, scope: "a\nb" } } })).toEqual({ a: { oauth: { accessToken: "at" } } });
  });

  it("projectMcpServerSecrets accepts the stored JSON text and survives junk", () => {
    expect(projectMcpServerSecrets(JSON.stringify({ a: { headers: { K: "v" } } }))).toEqual({ a: { headers: { K: "v" } } });
    for (const junk of [undefined, null, 4, "{nope", "[]", [], { a: 1 }, { a: { headers: { K: 5 } } }]) expect(projectMcpServerSecrets(junk)).toEqual({});
  });

  it("H2: every secret the migration stores is bound to the origin of the link it came from", () => {
    const migrated = migrateMcpServerSecrets({ mcpServers: {
      keyed: { url: "https://x.example:8443/mcp", headers: { "X-API-Key": "k1" } },
      qs: { url: "https://q.example/mcp?key=Q1" },
    } }, {});
    expect(migrated.credentials.mcpServerSecrets.keyed.origin).toBe("https://x.example:8443");
    expect(migrated.credentials.mcpServerSecrets.qs.origin).toBe("https://q.example");
  });

  it("H2: the projection for the server child carries the origin, and a doc that is only an origin is not projected", () => {
    const env = workspaceCredentialEnv({ mcpServerSecrets: {
      a: { origin: "https://a.example", headers: { K: "v" } },
      b: { origin: "https://b.example" },
    } });
    expect(JSON.parse(env.MURAGE_MCP_SERVER_SECRETS)).toEqual({ a: { origin: "https://a.example", headers: { K: "v" } } });
  });

  it("H2: secrets of a server that is no longer in config are dropped at boot, and none come back for a new server with that name", () => {
    const credentials = { mcpServerSecrets: {
      gone: { origin: "https://gone.example", headers: { K: "old-key" } },
      kept: { origin: "https://kept.example", headers: { K: "kept-key" } },
    } };
    const migrated = migrateMcpServerSecrets({ mcpServers: { kept: { url: "https://kept.example/mcp", headers: { K: true } } } }, credentials);
    expect(migrated.credentialsChanged).toBe(true);
    expect(Object.keys(migrated.credentials.mcpServerSecrets)).toEqual(["kept"]);
    expect(credentials.mcpServerSecrets.gone).toBeDefined(); // input untouched
    // even with no servers section at all
    const none = migrateMcpServerSecrets({}, credentials);
    expect(none.credentialsChanged).toBe(true);
    expect(none.credentials.mcpServerSecrets).toEqual({});
    // and a config that was never given a server leaves empty credentials alone
    expect(migrateMcpServerSecrets({}, {}).credentialsChanged).toBe(false);
  });

  it("H2: a stored doc whose origin is not the entry's origin is dropped at boot (the link was edited while the app was closed)", () => {
    const credentials = { mcpServerSecrets: { comfy: { origin: "https://a.example", headers: { K: "key-for-a" } } } };
    const migrated = migrateMcpServerSecrets({ mcpServers: { comfy: { url: "https://b.example/mcp", headers: { K: true } } } }, credentials);
    expect(migrated.credentials.mcpServerSecrets).toEqual({});
    const same = migrateMcpServerSecrets({ mcpServers: { comfy: { url: "https://a.example/other", headers: { K: true } } } }, credentials);
    expect(same.credentialsChanged).toBe(false);
  });

  it("N2: a stale doc for another origin is dropped before a plaintext header is merged, so A's key never resolves for B", () => {
    const credentials = { mcpServerSecrets: { comfy: { origin: "https://a.example", headers: { "X-API-Key": "KEY-FOR-A" } } } };
    const config = { mcpServers: { comfy: { url: "https://b.example/mcp", auth: "header", headers: { "X-API-Key": true, "X-Team": "team-1" }, enabled: true } } };
    const migrated = migrateMcpServerSecrets(config, credentials);
    expect(migrated.credentials.mcpServerSecrets.comfy).toEqual({ origin: "https://b.example", headers: { "X-Team": "team-1" } });
    expect(JSON.stringify(migrated.credentials)).not.toContain("KEY-FOR-A");
    expect(migrated.config.mcpServers.comfy.headers).toEqual({ "X-API-Key": true, "X-Team": true });
    expect(credentials.mcpServerSecrets.comfy.headers["X-API-Key"]).toBe("KEY-FOR-A"); // input untouched
  });

  it("N2: the same for a masked link with a hand-added query, and for a newly split secret link", () => {
    const masked = "https://b.example/api/mcp/s/\u2022\u2022\u2022/mcp";
    const stale = { mcpServerSecrets: { zap: { origin: "https://a.example", url: "https://a.example/api/mcp/s/AbCdEf0123456789XyZabcdef/mcp", headers: { K: "KEY-FOR-A" } } } };
    const extras = migrateMcpServerSecrets({ mcpServers: { zap: { url: `${masked}?key=HAND-ADDED`, urlSecret: true } } }, stale);
    expect(JSON.stringify(extras.credentials)).not.toMatch(/KEY-FOR-A|AbCdEf0123456789XyZabcdef|a\.example/);
    const split = migrateMcpServerSecrets({ mcpServers: { zap: { url: "https://b.example/mcp?key=NEWQUERYKEY" } } }, stale);
    expect(split.credentials.mcpServerSecrets.zap).toEqual({ origin: "https://b.example", url: "https://b.example/mcp?key=NEWQUERYKEY" });
    expect(JSON.stringify(split.credentials)).not.toContain("KEY-FOR-A");
  });

  it("N2: a doc with no origin is dropped, never merged into and stamped", () => {
    const credentials = { mcpServerSecrets: { comfy: { headers: { "X-API-Key": "UNBOUND-KEY" } } } };
    const merged = migrateMcpServerSecrets({ mcpServers: { comfy: { url: "https://b.example/mcp", headers: { "X-API-Key": true, "X-Team": "team-1" } } } }, credentials);
    expect(merged.credentials.mcpServerSecrets.comfy).toEqual({ origin: "https://b.example", headers: { "X-Team": "team-1" } });
    const alone = migrateMcpServerSecrets({ mcpServers: { comfy: { url: "https://b.example/mcp", headers: { "X-API-Key": true } } } }, credentials);
    expect(alone.credentialsChanged).toBe(true);
    expect(alone.credentials.mcpServerSecrets).toEqual({});
  });

  it("N2: a doc for the entry's own origin still takes the merge", () => {
    const credentials = { mcpServerSecrets: { comfy: { origin: "https://b.example", headers: { "X-API-Key": "KEY-FOR-B" } } } };
    const migrated = migrateMcpServerSecrets({ mcpServers: { comfy: { url: "https://B.example:443/mcp", headers: { "X-API-Key": true, "X-Team": "team-1" } } } }, credentials);
    expect(migrated.credentials.mcpServerSecrets.comfy).toEqual({ origin: "https://b.example", headers: { "X-API-Key": "KEY-FOR-B", "X-Team": "team-1" } });
  });

  it("L3: a query or userinfo added by hand to an already masked link moves into the stored link", () => {
    const credentials = { mcpServerSecrets: { zap: { origin: "https://mcp.zapier.com", url: TOKEN_URL } } };
    const masked = "https://mcp.zapier.com/api/mcp/s/\u2022\u2022\u2022/mcp";
    const migrated = migrateMcpServerSecrets({ mcpServers: { zap: { url: `${masked}?key=HAND-ADDED`, urlSecret: true } } }, credentials);
    expect(migrated.config.mcpServers.zap.url).toBe(masked);
    expect(migrated.credentials.mcpServerSecrets.zap.url).toBe(`${TOKEN_URL}?key=HAND-ADDED`);
    expect(JSON.stringify(migrated.config)).not.toContain("HAND-ADDED");
    const userinfo = migrateMcpServerSecrets({ mcpServers: { zap: { url: masked.replace("https://", "https://me:pw@"), urlSecret: true } } }, credentials);
    expect(userinfo.config.mcpServers.zap.url).toBe(masked);
    expect(JSON.stringify(userinfo.config)).not.toContain("pw@");
    expect(new URL(userinfo.credentials.mcpServerSecrets.zap.url).password).toBe("pw");
    // a masked link with nothing added is left alone
    expect(migrateMcpServerSecrets({ mcpServers: { zap: { url: masked, urlSecret: true } } }, credentials).configChanged).toBe(false);
  });

  it("L3: a link with an all-digit token of 16 to 23 characters is masked and moved", () => {
    for (const digits of ["1234567890123456", "12345678901234567890", "12345678901234567890123"]) {
      const migrated = migrateMcpServerSecrets({ mcpServers: { acct: { url: `https://h.example/u/${digits}/mcp` } } }, {});
      expect(migrated.config.mcpServers.acct.urlSecret).toBe(true);
      expect(JSON.stringify(migrated.config)).not.toContain(digits);
      expect(migrated.credentials.mcpServerSecrets.acct.url).toBe(`https://h.example/u/${digits}/mcp`);
    }
  });

  it("H2: dropMcpServerSecrets removes one server's doc, keeps the rest, changes nothing it was given, and ignores bad names", () => {
    const credentials = { other: "x", mcpServerSecrets: { a: { origin: "https://a.example", headers: { K: "1" } }, b: { origin: "https://b.example", headers: { K: "2" } } } };
    const next = dropMcpServerSecrets(credentials, "a");
    expect(next.mcpServerSecrets).toEqual({ b: credentials.mcpServerSecrets.b });
    expect(next.other).toBe("x");
    expect(credentials.mcpServerSecrets.a).toBeDefined();
    expect(dropMcpServerSecrets(credentials, "nosuch")).toBe(credentials);
    for (const bad of ["", "A", "__proto__", "a b", 5, undefined]) expect(dropMcpServerSecrets(credentials, bad)).toBe(credentials);
    expect(dropMcpServerSecrets({}, "a")).toEqual({});
  });
});

describe("command servers: env values leave config.json (MCP-LINK T16)", () => {
  const config = () => ({
    mcpServers: {
      notes: { command: "npx", args: ["-y", "notes"], env: { NOTES_TOKEN: "nt-PLAINTEXT", MODE: "ro", KEEP: true } },
      bare: { command: "x" },
      keyed: { url: "https://x.example/mcp", headers: { "X-API-Key": true } },
    },
  });

  it("moves every string env value into the store and leaves true behind", () => {
    const migrated = migrateMcpServerSecrets(config(), { mcpServerSecrets: { notes: { env: { KEEP: "kept-value" } } } });
    expect(migrated.config.mcpServers.notes).toEqual({ command: "npx", args: ["-y", "notes"], env: { NOTES_TOKEN: true, MODE: true, KEEP: true } });
    expect(migrated.credentials.mcpServerSecrets.notes).toEqual({ env: { KEEP: "kept-value", NOTES_TOKEN: "nt-PLAINTEXT", MODE: "ro" } });
    expect(migrated.config.mcpServers.bare).toEqual({ command: "x" });
    expect(JSON.stringify(migrated.config)).not.toContain("nt-PLAINTEXT");
    expect(migrated.configChanged && migrated.credentialsChanged).toBe(true);
  });

  it("a second run is a no-op, and a stored env doc survives the stale-doc sweep", () => {
    const first = migrateMcpServerSecrets(config(), {});
    const second = migrateMcpServerSecrets(first.config, first.credentials);
    expect(second.configChanged).toBe(false);
    expect(second.credentialsChanged).toBe(false);
    expect(second.credentials.mcpServerSecrets.notes.env.NOTES_TOKEN).toBe("nt-PLAINTEXT");
  });

  it("does nothing while the store is unavailable", () => {
    const migrated = migrateMcpServerSecrets(config(), {}, { storeAvailable: false });
    expect(migrated.configChanged).toBe(false);
    expect(JSON.stringify(migrated.config)).toContain("nt-PLAINTEXT");
  });

  it("a link doc under a command server's name is dropped, and env never rides a link doc", () => {
    const credentials = { mcpServerSecrets: {
      notes: { origin: "https://old.example", headers: { K: "OLD" } },
      keyed: { origin: "https://x.example", headers: { "X-API-Key": "k" }, env: { STRAY: "s" } },
      gone: { env: { A: "1" } },
    } };
    const migrated = migrateMcpServerSecrets(config(), credentials);
    expect(migrated.credentials.mcpServerSecrets.notes).toEqual({ env: { NOTES_TOKEN: "nt-PLAINTEXT", MODE: "ro" } });
    expect(migrated.credentials.mcpServerSecrets.keyed).toEqual({ origin: "https://x.example", headers: { "X-API-Key": "k" } });
    expect(migrated.credentials.mcpServerSecrets.gone).toBeUndefined();
  });

  it("the server child gets the env values of command servers", () => {
    const env = workspaceCredentialEnv({ mcpServerSecrets: { notes: { env: { NOTES_TOKEN: "nt" }, savedAt: 5 } } });
    expect(JSON.parse(env.MURAGE_MCP_SERVER_SECRETS)).toEqual({ notes: { env: { NOTES_TOKEN: "nt" } } });
  });

  it("a stale drop keeps a doc saved after the change it reports", () => {
    const credentials = { mcpServerSecrets: { notes: { env: { A: "1" }, savedAt: 100 } } };
    expect(dropMcpServerSecrets(credentials, "notes", 100)).toBe(credentials);
    expect(dropMcpServerSecrets(credentials, "notes", 101).mcpServerSecrets.notes).toBeUndefined();
    expect(dropMcpServerSecrets(credentials, "notes").mcpServerSecrets.notes).toBeUndefined();
  });
});
