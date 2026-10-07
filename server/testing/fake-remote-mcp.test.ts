// SPDX-License-Identifier: AGPL-3.0-or-later
// Proves the T15 fixture itself behaves like the servers it stands in for, so
// the T4/T7/T11 tests that lean on it are leaning on something checked. No
// engines here: plain HTTP against the fake on 127.0.0.1.
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMFY_VERBATIM_401,
  fakeBrowserApprove,
  startFakeRemoteMcp,
  type FakeRemoteMcp,
} from "./fake-remote-mcp.ts";

let fake: FakeRemoteMcp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, redirect: "manual" });
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function signIn(f: FakeRemoteMcp, scope?: string) {
  const prm = (await (await fetch(`${f.origin}/mcp/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[]; resource: string };
  const meta = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
  const redirectUri = "http://127.0.0.1:45555/callback";
  const client = (await (await post(meta.registration_endpoint!, JSON.stringify({ client_name: "Murage", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }))).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const authorize = new URL(meta.authorization_endpoint!);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: s256(verifier), code_challenge_method: "S256", state, resource: prm.resource, ...(scope ? { scope } : {}) })) authorize.searchParams.set(key, value);
  const approved = await fakeBrowserApprove(authorize.toString());
  return { meta, client, verifier, state, redirectUri, approved, resource: prm.resource };
}
const tokenRequest = (endpoint: string, params: Record<string, string>) =>
  fetch(endpoint, { method: "POST", body: new URLSearchParams(params), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("fake remote MCP: the MCP endpoint", () => {
  it("serves initialize, tools/list and tools/call over streamable HTTP with no auth", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const init = await post(fake.mcpUrl, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    expect((await post(fake.mcpUrl, rpc("notifications/initialized", undefined, undefined), { "mcp-session-id": session! })).status).toBe(202);
    const list = (await (await post(fake.mcpUrl, rpc("tools/list", {}, 2), { "mcp-session-id": session! })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["echo", "sum"]);
    const call = (await (await post(fake.mcpUrl, rpc("tools/call", { name: "sum", arguments: { a: 2, b: 3 } }, 3), { "mcp-session-id": session! })).json()) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]!.text).toBe("5");
    expect(fake.toolCalls).toEqual([{ name: "sum", arguments: { a: 2, b: 3 } }]);
  });

  it("can answer in an SSE frame instead of JSON", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", respondWith: "sse" });
    const response = await post(fake.mcpUrl, rpc("tools/list", {}, 7));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toMatch(/^event: message\ndata: \{.*"id":7.*\}\n\n$/s);
  });

  it("delays initialize when asked", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", initializeDelayMs: 250 });
    const started = Date.now();
    await post(fake.mcpUrl, rpc("initialize", {}));
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it("returns an oversize body when asked, and an oversize metadata document", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", oversizeMcpBytes: 300_000, oversizeMetadataBytes: 100_000 });
    expect((await (await post(fake.mcpUrl, rpc("tools/list", {}))).text()).length).toBeGreaterThan(300_000);
    expect((await (await fetch(`${fake.origin}/mcp/.well-known/oauth-protected-resource`)).text()).length).toBeGreaterThan(100_000);
  });

  it("answers 3xx on the MCP path (moved) and from a redirect trap, and counts the hits", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", mcpMovedTo: "https://new.example/mcp" });
    const moved = await post(fake.mcpUrl, rpc("initialize", {}));
    expect(moved.status).toBe(307);
    expect(moved.headers.get("location")).toBe("https://new.example/mcp");
    const trap = await fetch(`${fake.origin}/redirect-trap`, { redirect: "manual" });
    expect(trap.status).toBe(302);
    expect(trap.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
    expect(fake.redirectTrapHits).toBe(1);
  });
});

describe("fake remote MCP: 401 variants", () => {
  it("ComfyUI verbatim: the 401, the www-authenticate header and the JSON body", async () => {
    fake = await startFakeRemoteMcp({ auth: "both", unauthorized: "comfy-verbatim" });
    const response = await post(fake.mcpUrl, rpc("initialize", {}));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(COMFY_VERBATIM_401.headers["www-authenticate"]);
    expect(await response.text()).toBe(COMFY_VERBATIM_401.body);
    expect(COMFY_VERBATIM_401.headers["www-authenticate"]).toBe(
      'Bearer realm="comfy-cloud-mcp", resource_metadata="https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource", scope="comfy-mcp:tools:call"',
    );
    expect(JSON.parse(COMFY_VERBATIM_401.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authentication required. Provide an X-API-Key header or Authorization: Bearer token." },
      id: null,
    });
  });

  it("comfy variant points resource_metadata at this server, plain has no challenge, api-key-only names the header", async () => {
    fake = await startFakeRemoteMcp({ auth: "both", unauthorized: "comfy" });
    const comfy = await post(fake.mcpUrl, rpc("initialize", {}));
    expect(comfy.headers.get("www-authenticate")).toContain(`resource_metadata="${fake.origin}/mcp/.well-known/oauth-protected-resource"`);
    fake.options.unauthorized = "plain";
    const plain = await post(fake.mcpUrl, rpc("initialize", {}));
    expect(plain.status).toBe(401);
    expect(plain.headers.get("www-authenticate")).toBeNull();
    fake.options.unauthorized = "api-key-only";
    const keyed = await post(fake.mcpUrl, rpc("initialize", {}));
    expect(keyed.headers.get("www-authenticate")).toBeNull();
    expect(await keyed.text()).toContain("X-API-Key");
  });

  it("api key mode accepts only the right key in the right header", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "k-123", apiKeyHeader: "x-api-key" });
    expect((await post(fake.mcpUrl, rpc("tools/list", {}))).status).toBe(401);
    expect((await post(fake.mcpUrl, rpc("tools/list", {}), { "x-api-key": "wrong" })).status).toBe(401);
    expect((await post(fake.mcpUrl, rpc("tools/list", {}), { authorization: "Bearer k-123" })).status).toBe(401);
    expect((await post(fake.mcpUrl, rpc("tools/list", {}), { "x-api-key": "k-123" })).status).toBe(200);
  });
});

describe("fake remote MCP: OAuth", () => {
  it("serves PRM and both metadata styles, and leaves the other out", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", asMetadata: "rfc8414" });
    const prm = (await (await fetch(`${fake.origin}/mcp/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: fake.mcpUrl, authorization_servers: [fake.issuer], bearer_methods_supported: ["header"] });
    expect((await fetch(`${fake.origin}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect((await fetch(`${fake.origin}/.well-known/openid-configuration`)).status).toBe(404);
    fake.options.asMetadata = "oidc";
    expect((await fetch(`${fake.origin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const oidc = (await (await fetch(`${fake.origin}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(oidc).toMatchObject({ issuer: fake.issuer, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(oidc.registration_endpoint).toBe(`${fake.origin}/oauth/register`);
    expect(oidc.revocation_endpoint).toBe(`${fake.origin}/oauth/revoke`);
  });

  it("can omit registration and revocation, advertise no S256, or lie about the issuer or resource", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", dcr: false, revocation: false, pkceMethods: ["plain"], issuerOverride: "https://evil.example", prmResource: "https://other.example/mcp" });
    const meta = (await (await fetch(`${fake.origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
    expect(meta.revocation_endpoint).toBeUndefined();
    expect(meta.code_challenge_methods_supported).toEqual(["plain"]);
    expect(meta.issuer).toBe("https://evil.example");
    expect(((await (await fetch(`${fake.origin}/mcp/.well-known/oauth-protected-resource`)).json()) as { resource: string }).resource).toBe("https://other.example/mcp");
  });

  it("runs DCR, authorize with PKCE, code exchange, bearer MCP call, refresh with rotation, replay refused and revocation", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "bearer-resource-metadata" });
    expect((await post(fake.mcpUrl, rpc("tools/list", {}))).status).toBe(401);

    const flow = await signIn(fake);
    expect(fake.registrations).toHaveLength(1);
    expect(flow.approved.state).toBe(flow.state);
    expect(flow.approved.redirectUrl.startsWith(flow.redirectUri)).toBe(true);
    expect(flow.approved.code).toBeTruthy();

    // Wrong verifier is refused; the code is single-use even so.
    const bad = await tokenRequest(flow.meta.token_endpoint!, { grant_type: "authorization_code", code: flow.approved.code!, code_verifier: "x".repeat(43), redirect_uri: flow.redirectUri, client_id: flow.client.client_id, resource: flow.resource });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");

    const again = await signIn(fake);
    const ok = await tokenRequest(again.meta.token_endpoint!, { grant_type: "authorization_code", code: again.approved.code!, code_verifier: again.verifier, redirect_uri: again.redirectUri, client_id: again.client.client_id, resource: again.resource });
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });

    const authed = await post(fake.mcpUrl, rpc("tools/list", {}), { authorization: `Bearer ${tokens.access_token}` });
    expect(authed.status).toBe(200);
    expect((await post(fake.mcpUrl, rpc("tools/list", {}), { authorization: "Bearer nope" })).status).toBe(401);

    // Refresh rotates: the old refresh token dies, the new one works.
    const refreshed = await tokenRequest(again.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: again.client.client_id, resource: again.resource });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const replay = await tokenRequest(again.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: again.client.client_id });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");

    // Forced expiry makes the old access token a 401 with invalid_token.
    fake.expireAccessTokens();
    const expired = await post(fake.mcpUrl, rpc("tools/list", {}), { authorization: `Bearer ${next.access_token}` });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const revoke = await tokenRequest(again.meta.token_endpoint!.replace("/token", "/revoke"), { token: next.refresh_token, token_type_hint: "refresh_token", client_id: again.client.client_id });
    expect(revoke.status).toBe(200);
    expect(fake.revocations).toEqual([next.refresh_token]);
    const dead = await tokenRequest(again.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: again.client.client_id });
    expect(dead.status).toBe(400);
    expect(fake.tokenRequests.map((entry) => entry.grant_type)).toEqual(["authorization_code", "authorization_code", "refresh_token", "refresh_token", "refresh_token"]);
  });

  it("checks redirect_uri against the registration, requires S256, and can deny", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    const flow = await signIn(fake);
    const base = new URL(flow.meta.authorization_endpoint!);
    const make = (extra: Record<string, string>) => {
      const url = new URL(base);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: flow.client.client_id, redirect_uri: flow.redirectUri, code_challenge: s256("v".repeat(43)), code_challenge_method: "S256", state: "s", ...extra })) url.searchParams.set(key, value);
      return url.toString();
    };
    expect((await fetch(make({ redirect_uri: "http://127.0.0.1:1/other" }), { redirect: "manual" })).status).toBe(400);
    const noPkce = await fakeBrowserApprove(make({ code_challenge_method: "plain" }));
    expect(noPkce.error).toBe("invalid_request");
    fake.options.approve = "deny";
    expect((await fakeBrowserApprove(make({}))).error).toBe("access_denied");
  });

  it("adds iss to the callback when the AS advertises it", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", issParameter: true });
    const flow = await signIn(fake);
    expect(flow.approved.redirectUrl).toContain(`iss=${encodeURIComponent(fake.issuer)}`);
  });

  it("refresh modes: keep the token, fail with invalid_grant, or answer 503", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", refreshMode: "keep" });
    const flow = await signIn(fake);
    const first = (await (await tokenRequest(flow.meta.token_endpoint!, { grant_type: "authorization_code", code: flow.approved.code!, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, client_id: flow.client.client_id })).json()) as { refresh_token: string };
    const kept = (await (await tokenRequest(flow.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: flow.client.client_id })).json()) as { refresh_token: string };
    expect(kept.refresh_token).toBe(first.refresh_token);
    fake.options.refreshMode = "unavailable";
    expect((await tokenRequest(flow.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: flow.client.client_id })).status).toBe(503);
    fake.options.refreshMode = "invalid-grant";
    const gone = await tokenRequest(flow.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: flow.client.client_id });
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("returns 403 insufficient_scope for a tool that needs more access, and a wider token passes", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", requireScopeForTool: { tool: "sum", scope: "tools:write" } });
    const narrow = await signIn(fake, "tools:call");
    const token = (await (await tokenRequest(narrow.meta.token_endpoint!, { grant_type: "authorization_code", code: narrow.approved.code!, code_verifier: narrow.verifier, redirect_uri: narrow.redirectUri, client_id: narrow.client.client_id, scope: "tools:call" })).json()) as { access_token: string };
    const denied = await post(fake.mcpUrl, rpc("tools/call", { name: "sum", arguments: { a: 1, b: 1 } }, 4), { authorization: `Bearer ${token.access_token}` });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", scope="tools:write"');
    const wide = await signIn(fake, "tools:call tools:write");
    const wideToken = (await (await tokenRequest(wide.meta.token_endpoint!, { grant_type: "authorization_code", code: wide.approved.code!, code_verifier: wide.verifier, redirect_uri: wide.redirectUri, client_id: wide.client.client_id, scope: "tools:call tools:write" })).json()) as { access_token: string };
    expect((await post(fake.mcpUrl, rpc("tools/call", { name: "sum", arguments: { a: 1, b: 1 } }, 5), { authorization: `Bearer ${wideToken.access_token}` })).status).toBe(200);
  });

  it("revokeRefreshTokens makes the next refresh invalid_grant (the sign-in has ended)", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    const flow = await signIn(fake);
    const tokens = (await (await tokenRequest(flow.meta.token_endpoint!, { grant_type: "authorization_code", code: flow.approved.code!, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, client_id: flow.client.client_id })).json()) as { refresh_token: string };
    fake.revokeRefreshTokens();
    const res = await tokenRequest(flow.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: flow.client.client_id });
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("fake remote MCP: wave 3 switches for the sign-in tests (T11)", () => {
  it("metadataIssuer changes only the metadata's issuer; the PRM still names the real one", async () => {
    fake = await startFakeRemoteMcp({ metadataIssuer: "https://someone-else.example" });
    const prm = (await (await fetch(`${fake.origin}/mcp/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual([fake.origin]);
    const meta = (await (await fetch(`${fake.origin}/.well-known/oauth-authorization-server`)).json()) as { issuer: string };
    expect(meta.issuer).toBe("https://someone-else.example");
  });

  it("issValue puts another iss on the callback, and authorize requests are recorded", async () => {
    fake = await startFakeRemoteMcp({ issParameter: true, issValue: "https://evil.example" });
    const flow = await signIn(fake, "tools:call");
    expect(flow.approved.iss).toBe("https://evil.example");
    expect(fake.authorizeRequests).toHaveLength(1);
    expect(fake.authorizeRequests[0]).toMatchObject({ client_id: flow.client.client_id, scope: "tools:call", resource: flow.resource, code_challenge_method: "S256" });
  });

  it("revocationStatus makes revocation fail and records the form; the token stays alive", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", revocationStatus: 503 });
    const flow = await signIn(fake);
    const tokens = (await (await tokenRequest(flow.meta.token_endpoint!, { grant_type: "authorization_code", code: flow.approved.code!, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, client_id: flow.client.client_id })).json()) as { access_token: string; refresh_token: string };
    const revoked = await tokenRequest(flow.meta.revocation_endpoint!, { token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: flow.client.client_id });
    expect(revoked.status).toBe(503);
    expect(fake.revocations).toEqual([]);
    expect(fake.revocationRequests).toEqual([{ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: flow.client.client_id }]);
    expect((await tokenRequest(flow.meta.token_endpoint!, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: flow.client.client_id })).status).toBe(200);
  });

  it("tokenDelayMs holds the token endpoint's answer", async () => {
    fake = await startFakeRemoteMcp({ tokenDelayMs: 120 });
    const started = Date.now();
    await tokenRequest(`${fake.origin}/oauth/token`, { grant_type: "nothing" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});

describe("fake remote MCP: legacy HTTP+SSE", () => {
  it("answers POST on the MCP url with 405, streams an endpoint event on GET, and returns replies on the stream", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    expect((await post(fake.mcpUrl, rpc("initialize", {}))).status).toBe(405);
    const stream = await fetch(fake.mcpUrl, { headers: { accept: "text/event-stream" } });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = async (until: RegExp) => {
      while (!until.test(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    };
    await read(/event: endpoint\ndata: .+\n\n/);
    const endpoint = /event: endpoint\ndata: (.+)\n/.exec(text)![1]!;
    expect(endpoint.startsWith("/messages?sessionId=")).toBe(true);
    const accepted = await post(new URL(endpoint, fake.origin).toString(), rpc("tools/list", {}, 9));
    expect(accepted.status).toBe(202);
    await read(/"id":9/);
    expect(text).toMatch(/event: message\ndata: \{.*"id":9.*"echo".*\}/s);
    await reader.cancel();
  });

  it("can announce an endpoint on another origin, and answer the GET with a different status", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", sseEndpoint: "cross-origin", legacyPostStatus: 404 });
    expect((await post(fake.mcpUrl, rpc("initialize", {}))).status).toBe(404);
    const stream = await fetch(fake.mcpUrl, { headers: { accept: "text/event-stream" } });
    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("data: http://evil.example/messages?sessionId=");
    await reader.cancel();
  });
});

describe("fake remote MCP: bookkeeping", () => {
  it("records every request and never loses a token it issued", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    const flow = await signIn(fake);
    const tokens = (await (await tokenRequest(flow.meta.token_endpoint!, { grant_type: "authorization_code", code: flow.approved.code!, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, client_id: flow.client.client_id })).json()) as { access_token: string; refresh_token: string };
    expect(fake.issuedAccessTokens()).toEqual([tokens.access_token]);
    expect(fake.issuedRefreshTokens()).toEqual([tokens.refresh_token]);
    await post(fake.mcpUrl, rpc("tools/list", {}), { authorization: `Bearer ${tokens.access_token}` });
    const last = fake.requests.at(-1)!;
    expect(last).toMatchObject({ method: "POST", path: "/mcp" });
    expect(last.headers.authorization).toBe(`Bearer ${tokens.access_token}`);
  });

  it("listens on 127.0.0.1 only and closes cleanly", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    expect(new URL(fake.origin).hostname).toBe("127.0.0.1");
    const origin = fake.origin;
    await fake.close();
    fake = undefined;
    await expect(fetch(`${origin}/mcp`, { method: "POST" })).rejects.toThrow();
  });
});
