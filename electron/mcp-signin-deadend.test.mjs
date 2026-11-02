// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What an owner is told when a server's sign-in cannot start: a server that
// shared no sign-in details and a server that turns new apps away get different
// sentences, the browser is not opened for either, and the log names the step.
import http from "node:http";

import { describe, expect, it, vi } from "vitest";

import { discoverAuthorization } from "./mcp-signin/discovery.mjs";
import { createMcpServers } from "./mcp-signin/service.mjs";

const SERVER = "https://mcp.example/mcp";
const ISSUER = "https://auth.example";
const NO_DETAILS = "mcp.example did not share the details Murage needs to sign in. If it gave you a key or token, use that instead.";
const NO_NEW_APPS = "mcp.example does not let new apps sign in on their own. If it gave you a key or token, use that instead.";

const PRM = { resource: SERVER, authorization_servers: [ISSUER] };
const META = {
  issuer: ISSUER, code_challenge_methods_supported: ["S256"],
  authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
};

const reply = (status, body) => ({ status, headers: {}, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

/** A request function answering from a table of url -> [status, body]. */
function site(table) {
  return async ({ url }) => {
    const answer = table[url];
    if (answer instanceof Error) throw answer;
    return answer ? reply(answer[0], answer[1]) : reply(404, "not found");
  };
}

const withDocs = (more = {}) => site({
  "https://mcp.example/.well-known/oauth-protected-resource/mcp": [200, PRM],
  [`${ISSUER}/.well-known/oauth-authorization-server`]: [200, META],
  ...more,
});

function service(request, entry = { name: "ts", kind: "remote", auth: "oauth", url: SERVER }, saved = {}) {
  const log = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  const commits = [];
  const clearTimer = vi.fn();
  let document = saved;
  const mcp = createMcpServers({
    readDocument: () => document,
    updateDocument: async (derive) => { document = derive(document); },
    commit: async (route, init) => {
      commits.push({ route, ...init });
      if (route === "/api/mcp/servers") return { status: 200, body: { servers: [entry] } };
      if (route.endsWith("/oauth-target")) return { status: 200, body: { url: SERVER } };
      return { status: 200, body: {} };
    },
    openExternal,
    createServer: () => http.createServer(),
    request,
    log,
    platform: "darwin",
    env: {},
    setTimeout: () => ({ timer: true }),
    clearTimeout: clearTimer,
  });
  return { mcp, log, openExternal, commits, clearTimer, document: () => document };
}

describe("a server that shared no sign-in details", () => {
  it.each([
    ["404", [404, "not found"]],
    ["a gateway error", [502, "bad gateway"]],
    ["a web page", [200, "<html>log in</html>"]],
  ])("%s is not said to turn apps away", async (_label, answer) => {
    const request = async () => reply(answer[0], answer[1]);
    const found = await discoverAuthorization({ url: SERVER }, { request });
    expect(found).toMatchObject({ ok: false, error: "no-sign-in-details", step: "resource-details", message: NO_DETAILS });
  });

  it("names the second step when only the authorization server's details are missing", async () => {
    const request = site({ "https://mcp.example/.well-known/oauth-protected-resource/mcp": [200, PRM] });
    const found = await discoverAuthorization({ url: SERVER }, { request });
    expect(found).toMatchObject({ error: "no-sign-in-details", step: "authorization-details", message: NO_DETAILS });
  });

  it("still says the server could not be reached when nothing answered", async () => {
    const request = async () => { throw new Error("offline"); };
    const found = await discoverAuthorization({ url: SERVER }, { request });
    expect(found.error).toBe("network");
    expect(found.message).toBe("Murage could not reach mcp.example. Check your connection and try again.");
  });

  it("stops before the browser and logs the step with no address", async () => {
    const { mcp, log, openExternal } = service(site({}));
    const result = await mcp.signIn("ts");
    expect(result).toEqual({ ok: false, error: "no-sign-in-details", message: NO_DETAILS });
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("mcp server ts: sign-in stopped at resource-details");
    expect(JSON.stringify(log.mock.calls)).not.toContain("mcp.example");
  });
});

describe("a server that turns new apps away", () => {
  it("says so when there is no registration endpoint", async () => {
    const { mcp, log, openExternal } = service(withDocs());
    const result = await mcp.signIn("ts");
    expect(result).toEqual({ ok: false, error: "no-registration", message: NO_NEW_APPS });
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("mcp server ts: sign-in stopped at no-registration");
  });

  it("says so when registration is refused", async () => {
    const request = withDocs({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: [200, { ...META, registration_endpoint: `${ISSUER}/register` }],
      [`${ISSUER}/register`]: [403, "{}"],
    });
    const { mcp, openExternal } = service(request);
    const result = await mcp.signIn("ts");
    expect(result).toEqual({ ok: false, error: "no-registration", message: NO_NEW_APPS });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("a pasted token", () => {
  it("reaches the harness in the header the snippet named", async () => {
    const entry = { name: "hermes", kind: "remote", auth: "header", url: SERVER, headerNames: ["Authorization"] };
    const { mcp, commits } = service(site({}), entry);
    expect(await mcp.saveSecrets("hermes", { headers: { Authorization: "Bearer tok-1" } })).toEqual({ ok: true });
    const pushed = commits.find((call) => call.route === "/api/mcp/servers/hermes/secrets");
    expect(pushed).toMatchObject({ method: "PUT", body: { headers: { Authorization: "Bearer tok-1" } } });
  });

  it("saves nothing when the entry moved after the card's save", async () => {
    const entry = { name: "hermes", kind: "remote", auth: "header", url: "https://other.example/mcp", headerNames: ["Authorization"], rev: "bbbbbbbbbbbb" };
    const { mcp, commits, document } = service(site({}), entry);
    const result = await mcp.saveSecrets("hermes", { headers: { Authorization: "Bearer tok-1" }, rev: "aaaaaaaaaaaa" });
    expect(result).toMatchObject({ ok: false, error: "stale" });
    expect(document()).toEqual({});
    expect(commits.filter((call) => call.route.endsWith("/secrets"))).toEqual([]);
  });

  it("a command entry moved since the PUT takes nothing", async () => {
    const entry = { name: "notes", kind: "stdio", command: "npx", args: [], envKeys: ["NOTES_TOKEN"], rev: "bbbbbbbbbbbb" };
    const { mcp, commits, document } = service(site({}), entry);
    const result = await mcp.saveSecrets("notes", { env: { NOTES_TOKEN: "tok-1" }, rev: "aaaaaaaaaaaa" });
    expect(result).toMatchObject({ ok: false, error: "stale" });
    expect(document()).toEqual({});
    expect(commits.filter((call) => call.route.endsWith("/secrets"))).toEqual([]);
  });

  it("is refused when the save names no revision", async () => {
    const entry = { name: "hermes", kind: "remote", auth: "header", url: SERVER, headerNames: ["Authorization"], rev: "bbbbbbbbbbbb" };
    const { mcp, document } = service(site({}), entry);
    expect(await mcp.saveSecrets("hermes", { headers: { Authorization: "Bearer tok-1" }, rev: "" })).toMatchObject({ ok: false, error: "stale" });
    expect(document()).toEqual({});
  });
});

describe("a key that replaces a sign-in", () => {
  const REVOKE = `${ISSUER}/revoke`;
  const TOKEN_URL = `${ISSUER}/token`;
  const KEYED = { name: "ts", kind: "remote", auth: "header", url: SERVER, headerNames: ["Authorization"] };
  const signedIn = () => ({
    mcpServerSecrets: {
      ts: {
        origin: "https://mcp.example", savedAt: 1,
        oauth: {
          issuer: ISSUER, clientId: "client-1", resource: SERVER, tokenEndpoint: TOKEN_URL, revocationEndpoint: REVOKE,
          accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000, issuedAt: 1, signedInAt: 1,
        },
      },
    },
  });
  /** Every request, with the revoked tokens picked out of the form. */
  function server() {
    const seen = [];
    const request = async (call) => { seen.push(call); return reply(200, "{}"); };
    return { seen, request, revoked: () => seen.filter((call) => call.url === REVOKE).map((call) => new URLSearchParams(call.body).get("token")) };
  }

  it("revokes the grant, forgets the tokens and stops the renewals", async () => {
    const { seen, request, revoked } = server();
    const { mcp, commits, clearTimer, document } = service(request, KEYED, signedIn());
    await mcp.resume({ now: Date.now() });
    expect(await mcp.saveSecrets("ts", { headers: { Authorization: "Bearer tok-1" } })).toEqual({ ok: true });

    expect(revoked()).toEqual(["refresh-1", "access-1"]);
    const doc = document().mcpServerSecrets.ts;
    expect(doc.headers).toEqual({ Authorization: "Bearer tok-1" });
    expect(doc.oauth).toMatchObject({ clientId: "client-1" });
    expect(doc.oauth).not.toHaveProperty("accessToken");
    expect(doc.oauth).not.toHaveProperty("refreshToken");
    expect(clearTimer).toHaveBeenCalled();

    const pushed = commits.filter((call) => call.route === "/api/mcp/servers/ts/secrets" && call.method === "PUT").at(-1);
    expect(pushed.body).toMatchObject({ headers: { Authorization: "Bearer tok-1" } });
    expect(JSON.stringify(pushed.body)).not.toContain("access-1");

    await mcp.refresh("ts");
    expect(seen.filter((call) => call.url === TOKEN_URL)).toEqual([]);
  });

  it("keeps the sign-in of an entry that still signs in", async () => {
    const { request, revoked } = server();
    const entry = { name: "ts", kind: "remote", auth: "oauth", url: SERVER, headerNames: ["X-Extra"] };
    const { mcp, document } = service(request, entry, signedIn());
    expect(await mcp.saveSecrets("ts", { headers: { "X-Extra": "value" } })).toEqual({ ok: true });
    expect(revoked()).toEqual([]);
    expect(document().mcpServerSecrets.ts.oauth.accessToken).toBe("access-1");
  });

  it("forgets the tokens and still saves the key when the revoke cannot reach the server", async () => {
    const request = async () => { throw new Error("offline"); };
    const { mcp, log, document } = service(request, KEYED, signedIn());
    expect(await mcp.saveSecrets("ts", { headers: { Authorization: "Bearer tok-1" } })).toEqual({ ok: true });
    expect(document().mcpServerSecrets.ts.oauth).not.toHaveProperty("accessToken");
    expect(log).toHaveBeenCalledWith("mcp server ts: an old sign-in could not be revoked");
  });

  it("revokes when the harness's word that the entry changed lands before the key", async () => {
    const { request, revoked } = server();
    const { mcp, document } = service(request, KEYED, signedIn());
    await mcp.resume({ now: Date.now() });
    await mcp.handleSecretsStale({ name: "ts", at: Date.now() + 1 });
    expect(revoked()).toEqual(["refresh-1", "access-1"]);
    expect(document().mcpServerSecrets.ts).toBeUndefined();
  });

  it("leaves a sign-in saved after the change alone", async () => {
    const { request, revoked } = server();
    const saved = signedIn();
    saved.mcpServerSecrets.ts.savedAt = 500;
    const { mcp, document } = service(request, KEYED, saved);
    await mcp.handleSecretsStale({ name: "ts", at: 100 });
    expect(revoked()).toEqual([]);
    expect(document().mcpServerSecrets.ts.oauth.accessToken).toBe("access-1");
  });
});
