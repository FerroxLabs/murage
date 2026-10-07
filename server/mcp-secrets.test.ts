// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV } from "./config.ts";
import type { StoredRemoteMcpServer } from "./mcp-registry.ts";
import {
  MCP_SECRETS_ENV,
  clearAllMcpServerSecrets,
  clearMcpServerSecrets,
  currentAccessToken,
  getMcpServerSecrets,
  heldSignInFacts,
  loadMcpSecretsFromEnv,
  mcpSecretPresence,
  replaceAllMcpServerSecrets,
  resolveDialUrl,
  resolveRequestAuth,
  secretsBoundTo,
  sanitizeSecretDoc,
  setMcpServerSecrets,
} from "./mcp-secrets.ts";
import { fixtureDumpEnvironment } from "./testing/fixture-dump.ts";

afterEach(() => clearAllMcpServerSecrets());

const remote = (over: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer => ({
  url: "https://cloud.comfy.org/mcp", auth: "header", headers: { "X-API-Key": true }, enabled: true, ...over,
});

describe("loading from the environment", () => {
  it("reads MURAGE_MCP_SERVER_SECRETS once and deletes it from the environment", () => {
    const env: NodeJS.ProcessEnv = { [MCP_SECRETS_ENV]: JSON.stringify({ comfy: { headers: { "X-API-Key": "k-1" }, oauth: { accessToken: "at-1", expiresAt: 5 } } }) };
    expect(loadMcpSecretsFromEnv(env)).toEqual({ loaded: 1 });
    expect(env[MCP_SECRETS_ENV]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("k-1");
    expect(getMcpServerSecrets("comfy")).toEqual({ headers: { "X-API-Key": "k-1" }, oauth: { accessToken: "at-1", expiresAt: 5 } });
    expect(loadMcpSecretsFromEnv(env)).toEqual({ loaded: 0 }); // nothing left to read; existing state is untouched
    expect(getMcpServerSecrets("comfy")).toBeDefined();
  });
  it("deletes the variable even when it is unreadable, loads nothing, and never echoes the content", () => {
    for (const raw of ["{not json", "[1,2]", '"text"', "null"]) {
      const env: NodeJS.ProcessEnv = { [MCP_SECRETS_ENV]: raw };
      expect(loadMcpSecretsFromEnv(env)).toEqual({ loaded: 0 });
      expect(env[MCP_SECRETS_ENV]).toBeUndefined();
    }
  });
  it("a spawned child's environment lacks it: it is on the strip list", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain(MCP_SECRETS_ENV);
    const env: Record<string, string | undefined> = { [MCP_SECRETS_ENV]: "{}", PATH: "/bin" };
    stripWorkspaceCredentialEnv(env);
    expect(env[MCP_SECRETS_ENV]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    const windows: Record<string, string | undefined> = { Murage_Mcp_Server_Secrets: "{}" };
    stripWorkspaceCredentialEnv(windows, "win32");
    expect(Object.keys(windows)).toEqual([]);
  });
  it("the fixture dump never lists it", () => {
    process.env[MCP_SECRETS_ENV] = "canary";
    try {
      expect(Object.keys(fixtureDumpEnvironment())).not.toContain(MCP_SECRETS_ENV);
      expect(JSON.stringify(fixtureDumpEnvironment())).not.toContain("canary");
    } finally {
      delete process.env[MCP_SECRETS_ENV];
    }
  });
});

describe("sanitizeSecretDoc keeps only what the harness may hold", () => {
  it("drops a refresh token, a client secret and anything unknown", () => {
    expect(sanitizeSecretDoc({
      headers: { "X-API-Key": "k", Empty: "", Num: 5 }, url: "https://x/s/abc", extra: "x",
      oauth: { accessToken: "at", expiresAt: 10, refreshToken: "rt-SECRET", clientSecret: "cs-SECRET", issuer: "https://as" },
    })).toEqual({ headers: { "X-API-Key": "k" }, url: "https://x/s/abc", oauth: { accessToken: "at", expiresAt: 10 } });
    expect(JSON.stringify(sanitizeSecretDoc({ oauth: { accessToken: "at", refreshToken: "rt-SECRET" } }))).not.toContain("rt-SECRET");
  });
  it("keeps when the access token was issued and the scope it carries, and nothing malformed", () => {
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", issuedAt: 1_700_000_000_000, scope: "a b", refreshToken: "rt-SECRET" } }))
      .toEqual({ oauth: { accessToken: "at", issuedAt: 1_700_000_000_000, scope: "a b" } });
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", signedInAt: 7, refreshToken: "rt" } })).toEqual({ oauth: { accessToken: "at", signedInAt: 7 } });
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", signedInAt: "7" } })).toEqual({ oauth: { accessToken: "at" } });
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", issuedAt: "5", scope: 7 } })).toEqual({ oauth: { accessToken: "at" } });
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", issuedAt: Number.POSITIVE_INFINITY, scope: "a\u0000b" } })).toEqual({ oauth: { accessToken: "at" } });
    expect(sanitizeSecretDoc({ oauth: { accessToken: "at", scope: "s".repeat(2_001) } })).toEqual({ oauth: { accessToken: "at" } });
  });
  it("heldSignInFacts says when the held token was issued and its scope, never the token", () => {
    setMcpServerSecrets("facts", { origin: "https://a.example", oauth: { accessToken: "at-SECRET", issuedAt: 42, scope: "x" } });
    try {
      expect(heldSignInFacts("facts")).toEqual({ issuedAt: 42, scope: "x" });
      expect(JSON.stringify(heldSignInFacts("facts"))).not.toContain("at-SECRET");
      expect(heldSignInFacts("nobody")).toEqual({});
    } finally {
      clearMcpServerSecrets("facts");
    }
  });
  it("returns null for junk and for an empty doc, and ignores __proto__", () => {
    for (const raw of [null, 3, "x", [], {}, { headers: {} }, { oauth: { refreshToken: "rt" } }, { oauth: { accessToken: "" } }]) expect(sanitizeSecretDoc(raw)).toBeNull();
    const headers = JSON.parse('{"__proto__":"x","X-K":"v"}');
    expect(sanitizeSecretDoc({ headers })).toEqual({ headers: { "X-K": "v" } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("the in-memory store", () => {
  it("set, merge-free replace, clear and replace-all", () => {
    setMcpServerSecrets("a", { headers: { K: "1" } });
    setMcpServerSecrets("b", { headers: { K: "2" } });
    setMcpServerSecrets("a", { headers: { K: "3" } });
    expect(getMcpServerSecrets("a")).toEqual({ headers: { K: "3" } });
    clearMcpServerSecrets("a");
    expect(getMcpServerSecrets("a")).toBeUndefined();
    setMcpServerSecrets("b", {});
    expect(getMcpServerSecrets("b")).toBeUndefined();
    replaceAllMcpServerSecrets({ c: { headers: { K: "x" } }, d: { junk: 1 } });
    expect(getMcpServerSecrets("c")).toBeDefined();
    expect(getMcpServerSecrets("d")).toBeUndefined();
    replaceAllMcpServerSecrets({});
    expect(getMcpServerSecrets("c")).toBeUndefined();
  });
  it("presence says yes or no and carries no value", () => {
    setMcpServerSecrets("a", { headers: { "X-API-Key": "k" }, oauth: { accessToken: "at" } });
    const presence = mcpSecretPresence();
    expect(presence.hasHeader("a", "X-API-Key")).toBe(true);
    expect(presence.hasHeader("a", "Other")).toBe(false);
    expect(presence.hasHeader("none", "X-API-Key")).toBe(false);
    expect(presence.hasOAuth("a")).toBe(true);
    expect(presence.hasOAuth("none")).toBe(false);
    expect(JSON.stringify(Object.values(presence).map((fn) => String(fn)))).not.toContain("at");
  });
  it("an access token is current until its expiry", () => {
    setMcpServerSecrets("a", { oauth: { accessToken: "at-1", expiresAt: 1_000 } });
    expect(currentAccessToken("a", 999)).toBe("at-1");
    expect(currentAccessToken("a", 1_000)).toBeUndefined();
    setMcpServerSecrets("b", { oauth: { accessToken: "at-2" } });
    expect(currentAccessToken("b", Number.MAX_SAFE_INTEGER)).toBe("at-2");
    expect(currentAccessToken("zzz")).toBeUndefined();
  });
});

describe("resolving what to dial and what to send", () => {
  it("a masked link is dialed from the stored copy, and is undialable without one", () => {
    const masked = remote({ url: "https://h.example/s/•••/mcp", urlSecret: true });
    expect(resolveDialUrl("a", masked)).toBeNull();
    setMcpServerSecrets("a", { origin: "https://h.example", url: "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp" });
    expect(resolveDialUrl("a", masked)).toBe("https://h.example/s/abcdefghijklmnopqrstuvwx/mcp");
  });
  it("a plain link is dialed as written, and a dev entry that keeps the full link in config is dialable", () => {
    expect(resolveDialUrl("a", remote())).toBe("https://cloud.comfy.org/mcp");
    expect(resolveDialUrl("a", remote({ url: "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp", urlSecret: true }))).toBe("https://h.example/s/abcdefghijklmnopqrstuvwx/mcp");
  });
  it("headers come from the store, then from a dev string in config, and a missing one is named", () => {
    setMcpServerSecrets("a", { origin: "https://cloud.comfy.org", headers: { "X-API-Key": "from-store" } });
    expect(resolveRequestAuth("a", remote())).toEqual({ headers: { "X-API-Key": "from-store" }, missing: [] });
    expect(resolveRequestAuth("zzz", remote({ headers: { "X-API-Key": "dev-string" } }))).toEqual({ headers: { "X-API-Key": "dev-string" }, missing: [] });
    expect(resolveRequestAuth("zzz", remote({ headers: { "X-API-Key": true, "X-Other": true } }))).toEqual({ headers: {}, missing: ["X-API-Key", "X-Other"] });
    setMcpServerSecrets("a", { origin: "https://cloud.comfy.org", headers: { "X-API-Key": "s" } });
    expect(resolveRequestAuth("a", remote({ headers: { "X-API-Key": "dev", "X-Other": true } })).headers).toEqual({ "X-API-Key": "s" });
  });
  it("a bearer is sent only for oauth entries and only while current", () => {
    setMcpServerSecrets("a", { origin: "https://cloud.comfy.org", oauth: { accessToken: "at-1", expiresAt: 10_000 } });
    const oauth = remote({ auth: "oauth", headers: {} });
    expect(resolveRequestAuth("a", oauth, 1_000)).toEqual({ headers: {}, bearer: "at-1", missing: [] });
    expect(resolveRequestAuth("a", oauth, 10_000)).toEqual({ headers: {}, missing: [] });
    expect(resolveRequestAuth("a", remote({ auth: "none", headers: {} }), 1_000).bearer).toBeUndefined();
  });
});

describe("module hygiene", () => {
  it("never logs and never writes a file", () => {
    const source = readFileSync(new URL("./mcp-secrets.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/console\.|writeFile|appendFile|node:fs/);
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
  });
});

describe("H2: a saved secret is bound to the origin it was issued for", () => {
  const A = "https://a.example";
  const B = "https://b.example";

  it("sanitizeSecretDoc keeps an origin (normalized) and drops anything that is not one; an origin alone is not a doc", () => {
    expect(sanitizeSecretDoc({ origin: "https://A.example:443/some/path?x=1", headers: { K: "v" } })).toEqual({ origin: A, headers: { K: "v" } });
    expect(sanitizeSecretDoc({ origin: "ftp://a.example", headers: { K: "v" } })).toEqual({ headers: { K: "v" } });
    expect(sanitizeSecretDoc({ origin: "nonsense", headers: { K: "v" } })).toEqual({ headers: { K: "v" } });
    expect(sanitizeSecretDoc({ origin: A })).toBeNull();
  });

  it("secretsBoundTo needs the same scheme, host and port, and a doc with no origin is bound to nothing", () => {
    expect(secretsBoundTo({ origin: A }, `${A}/mcp`)).toBe(true);
    expect(secretsBoundTo({ origin: A }, "https://a.example:8443/mcp")).toBe(false);
    expect(secretsBoundTo({ origin: A }, "http://a.example/mcp")).toBe(false);
    expect(secretsBoundTo({ origin: A }, `${B}/mcp`)).toBe(false);
    expect(secretsBoundTo({ origin: A }, "https://a.example.evil.test/mcp")).toBe(false);
    expect(secretsBoundTo({}, `${A}/mcp`)).toBe(false);
    expect(secretsBoundTo(undefined, `${A}/mcp`)).toBe(false);
  });

  it("REV2-1: an edit of the link to another origin sends the old key nowhere", () => {
    setMcpServerSecrets("comfy", { origin: A, headers: { "X-API-Key": "KEY-FOR-A" } });
    const atA = remote({ url: `${A}/mcp` });
    const atB = remote({ url: `${B}/mcp` });
    expect(resolveRequestAuth("comfy", atA)).toEqual({ headers: { "X-API-Key": "KEY-FOR-A" }, missing: [] });
    expect(resolveRequestAuth("comfy", atB)).toEqual({ headers: {}, missing: ["X-API-Key"] });
    expect(mcpSecretPresence().hasHeader("comfy", "X-API-Key", `${B}/mcp`)).toBe(false);
    expect(mcpSecretPresence().hasHeader("comfy", "X-API-Key", `${A}/mcp`)).toBe(true);
  });

  it("the same for an access token", () => {
    setMcpServerSecrets("comfy", { origin: A, oauth: { accessToken: "at-for-a" } });
    expect(resolveRequestAuth("comfy", remote({ url: `${A}/mcp`, auth: "oauth", headers: {} })).bearer).toBe("at-for-a");
    expect(resolveRequestAuth("comfy", remote({ url: `${B}/mcp`, auth: "oauth", headers: {} })).bearer).toBeUndefined();
    expect(mcpSecretPresence().hasOAuth("comfy", `${B}/mcp`)).toBe(false);
  });

  it("a doc with no origin is sent nowhere, even to the entry it was saved for", () => {
    setMcpServerSecrets("comfy", { headers: { "X-API-Key": "k" }, oauth: { accessToken: "t" } });
    expect(resolveRequestAuth("comfy", remote({ url: `${A}/mcp` })).headers).toEqual({});
    expect(resolveRequestAuth("comfy", remote({ url: `${A}/mcp`, auth: "oauth", headers: {} })).bearer).toBeUndefined();
  });

  it("REV2-1b: a stored full link never overrides an edit, and only serves the masked link it stands for, on its own origin", () => {
    setMcpServerSecrets("zap", { origin: A, url: `${A}/s/AbCdEf0123456789XyZabcdef/mcp` });
    // an edited plain link is dialed as written
    expect(resolveDialUrl("zap", remote({ url: `${B}/mcp` }))).toBe(`${B}/mcp`);
    expect(resolveDialUrl("zap", remote({ url: `${A}/other` }))).toBe(`${A}/other`);
    // a masked link on the same origin is served by it
    expect(resolveDialUrl("zap", remote({ url: `${A}/s/•••/mcp`, urlSecret: true }))).toBe(`${A}/s/AbCdEf0123456789XyZabcdef/mcp`);
    // a masked link edited to another origin gets nothing
    expect(resolveDialUrl("zap", remote({ url: `${B}/s/•••/mcp`, urlSecret: true }))).toBeNull();
    // a held link that names another origin than its own doc is refused
    setMcpServerSecrets("odd", { origin: A, url: `${B}/s/AbCdEf0123456789XyZabcdef/mcp` });
    expect(resolveDialUrl("odd", remote({ url: `${A}/s/•••/mcp`, urlSecret: true }))).toBeNull();
  });
});
