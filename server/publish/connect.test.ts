// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it, vi } from "vitest";
import { clearAllMcpServerSecrets, setMcpServerSecrets } from "../mcp-secrets.ts";
import { checkNetlifyConnection } from "./connect.ts";
import { NETLIFY_PAT_SERVER } from "./token.ts";

afterEach(() => clearAllMcpServerSecrets());
const link = { netlify: { url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", headers: {}, enabled: false } };
const respond = (status: number) => vi.fn<typeof fetch>(async () => new Response("{}", { status }));

it("says nothing is connected when there is no sign-in and no pasted token, and makes no call", async () => {
  const fetchImpl = respond(200);
  expect(await checkNetlifyConnection({ servers: link, fetchImpl })).toEqual({ connected: false, reason: "none" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("a pasted token Netlify accepts is connected, and the token goes only to Netlify's user endpoint", async () => {
  setMcpServerSecrets(NETLIFY_PAT_SERVER, { env: { NETLIFY_AUTH_TOKEN: "pat-123" } });
  const fetchImpl = respond(200);
  const result = await checkNetlifyConnection({ servers: {}, fetchImpl });
  expect(result).toEqual({ connected: true, via: "token" });
  expect(JSON.stringify(result)).not.toContain("pat-123");
  expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual(["https://api.netlify.com/api/v1/user"]);
});

it("the Netlify sign-in token works for the REST API: connected through the sign-in", async () => {
  setMcpServerSecrets("netlify", { oauth: { accessToken: "oauth-1" } });
  expect(await checkNetlifyConnection({ servers: link, fetchImpl: respond(200) })).toEqual({ connected: true, via: "sign-in" });
});

it("the Netlify sign-in token is not accepted by the REST API: not connected, and the card can offer the paste field", async () => {
  setMcpServerSecrets("netlify", { oauth: { accessToken: "oauth-1" } });
  for (const status of [401, 403]) expect(await checkNetlifyConnection({ servers: link, fetchImpl: respond(status) })).toEqual({ connected: false, reason: "rejected", via: "sign-in" });
});

it("a pasted token Netlify rejects is named as rejected, and Netlify being down is not blamed on the token", async () => {
  setMcpServerSecrets(NETLIFY_PAT_SERVER, { env: { NETLIFY_AUTH_TOKEN: "pat-123" } });
  expect(await checkNetlifyConnection({ servers: {}, fetchImpl: respond(401) })).toEqual({ connected: false, reason: "rejected", via: "token" });
  expect(await checkNetlifyConnection({ servers: {}, fetchImpl: respond(500) })).toEqual({ connected: false, reason: "unreachable", via: "token" });
  expect(await checkNetlifyConnection({ servers: {}, fetchImpl: vi.fn<typeof fetch>(async () => { throw new Error("offline"); }) })).toEqual({ connected: false, reason: "unreachable", via: "token" });
});
