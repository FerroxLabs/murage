// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, expect, it } from "vitest";
import { clearAllMcpServerSecrets, setMcpServerSecrets } from "../mcp-secrets.ts";
import { NETLIFY_PAT_SERVER, netlifyConnection, netlifyToken } from "./token.ts";

afterEach(() => clearAllMcpServerSecrets());
const link = (url: string, enabled = true) => ({ url, auth: "oauth" as const, headers: {}, enabled });

it("finds nothing when Netlify is not connected", () => {
  expect(netlifyToken({})).toBeUndefined();
});

it("uses the token from the Netlify sign-in when that link is connected and signed in", () => {
  setMcpServerSecrets("netlify", { origin: "https://netlify-mcp.netlify.app", oauth: { accessToken: "oauth-token", expiresAt: Date.now() + 60_000 } });
  expect(netlifyToken({ netlify: link("https://netlify-mcp.netlify.app/mcp") })).toBe("oauth-token");
});

it("ignores an expired sign-in and other servers", () => {
  setMcpServerSecrets("netlify", { oauth: { accessToken: "old", expiresAt: Date.now() - 1 } });
  setMcpServerSecrets("other", { oauth: { accessToken: "other-token" } });
  expect(netlifyToken({ netlify: link("https://netlify-mcp.netlify.app/mcp"), other: link("https://example.com/mcp") })).toBeUndefined();
});

it("uses the sign-in of a link kept switched off, which is how Connect Netlify adds it", () => {
  setMcpServerSecrets("netlify", { oauth: { accessToken: "fresh" } });
  expect(netlifyToken({ netlify: link("https://netlify-mcp.netlify.app/mcp", false) })).toBe("fresh");
});

it("says which way Netlify is connected, never the token", () => {
  const servers = { netlify: link("https://netlify-mcp.netlify.app/mcp", false) };
  expect(netlifyConnection(servers)).toBeUndefined();
  setMcpServerSecrets("netlify", { oauth: { accessToken: "fresh" } });
  expect(netlifyConnection(servers)).toBe("sign-in");
  setMcpServerSecrets(NETLIFY_PAT_SERVER, { env: { NETLIFY_AUTH_TOKEN: "pat" } });
  expect(netlifyConnection(servers)).toBe("token");
  expect(JSON.stringify(netlifyConnection(servers))).not.toContain("pat");
});

it("prefers a pasted personal access token, held with the other secrets", () => {
  setMcpServerSecrets("netlify", { oauth: { accessToken: "oauth-token" } });
  setMcpServerSecrets(NETLIFY_PAT_SERVER, { env: { NETLIFY_AUTH_TOKEN: "  pat-token  " } });
  expect(netlifyToken({ netlify: link("https://netlify-mcp.netlify.app/mcp") })).toBe("pat-token");
});
