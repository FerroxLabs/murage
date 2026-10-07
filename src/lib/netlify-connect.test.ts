// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it, vi } from "vitest";
import type { McpBridge } from "./mcp-bridge";
import { connectWithSignIn, connectWithToken, readableToken, type ConnectDeps } from "./netlify-connect";

const CTX = { botId: "bot-1", threadId: "thread-1", messageId: "msg-1" };
const SECRET = "nfp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // secret-scan: fixture
const ok = { ok: true } as const;

function deps(options: { check?: unknown; existing?: boolean; foreign?: boolean; bridge?: Record<string, unknown> | null } = {}) {
  const requests: Array<{ path: string; method: string; body: string }> = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    requests.push({ path, method: init?.method ?? "GET", body: init?.body ?? "" });
    if (path === "/api/publish/netlify/check") return options.check ?? { connected: true, via: "token" };
    if (path === "/api/mcp/servers" && !init?.method) return { servers: [{ name: "publish-netlify", command: options.foreign ? "evil" : "node", args: ["-e", "0"] }] };
    if (path === "/api/mcp/servers" && init?.method === "POST" && options.existing) throw Object.assign(new Error("An MCP server with that name already exists."), { status: 409 });
    return { servers: [] };
  });
  const bridge = options.bridge === null ? undefined : { saveSecrets: vi.fn(async () => ok), signIn: vi.fn(async () => ok), ...options.bridge } as unknown as McpBridge;
  return { requests, api, bridge, deps: { api, bridge } as ConnectDeps };
}

describe("sign in with Netlify", () => {
  it("adds the Netlify link switched off, signs in through the existing flow, then asks the server to check", async () => {
    const d = deps({ check: { connected: true, via: "sign-in" } });
    expect(await connectWithSignIn(d.deps, CTX)).toEqual({ state: "connected", via: "sign-in" });
    const create = d.requests.find(r => r.path === "/api/mcp/servers")!;
    expect(JSON.parse(create.body)).toEqual({ name: "netlify", url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", enabled: false });
    expect(d.bridge!.signIn).toHaveBeenCalledWith("netlify");
    expect(d.requests.map(r => r.path)).toEqual(["/api/mcp/servers", "/api/publish/netlify/check"]);
    expect(JSON.parse(d.requests[1]!.body)).toEqual(CTX);
  });

  it("an existing link is reused, not an error", async () => {
    const d = deps({ existing: true });
    expect((await connectWithSignIn(d.deps, CTX)).state).toBe("connected");
    expect(d.bridge!.signIn).toHaveBeenCalledOnce();
  });

  it("an existing Netlify link that was switched on is switched off before signing in", async () => {
    const d = deps({ existing: true });
    await connectWithSignIn(d.deps, CTX);
    const patch = d.requests.find(r => r.method === "PATCH")!;
    expect(patch.path).toBe("/api/mcp/servers/netlify");
    expect(JSON.parse(patch.body)).toEqual({ enabled: false });
  });

  it("when Netlify's sign-in token is not accepted by its API, the card moves on to pasting a token", async () => {
    const d = deps({ check: { connected: false, reason: "rejected", via: "sign-in" } });
    expect(await connectWithSignIn(d.deps, CTX)).toEqual({ state: "needs-token", why: "sign-in-not-enough" });
  });

  it("closing the browser window is not an error", async () => {
    const d = deps({ bridge: { signIn: vi.fn(async () => ({ ok: false, error: "cancelled", message: "Sign-in cancelled." })) } });
    expect(await connectWithSignIn(d.deps, CTX)).toEqual({ state: "start" });
    expect(d.requests.some(r => r.path === "/api/publish/netlify/check")).toBe(false);
  });

  it("another sign-in failure shows the shell's plain sentence and offers the token instead", async () => {
    const d = deps({ bridge: { signIn: vi.fn(async () => ({ ok: false, error: "network", message: "Could not reach Netlify." })) } });
    expect(await connectWithSignIn(d.deps, CTX)).toEqual({ state: "start", error: "Could not reach Netlify." });
  });

  it("without the desktop shell there is no sign-in, only the token", async () => {
    const d = deps({ bridge: null });
    expect(await connectWithSignIn(d.deps, CTX)).toEqual({ state: "needs-token", why: "no-shell" });
    expect(d.requests).toEqual([]);
  });
});

describe("paste a Netlify access token", () => {
  it("with the desktop shell, the value goes to the shell's secret store and never into a request", async () => {
    const d = deps();
    expect(await connectWithToken(d.deps, `  ${SECRET}\n`, CTX)).toEqual({ state: "connected", via: "token" });
    expect(d.requests.map(r => r.path)).toEqual(["/api/mcp/servers", "/api/publish/netlify/check"]);
    expect(JSON.parse(d.requests[0]!.body)).toMatchObject({ name: "publish-netlify", env: { NETLIFY_AUTH_TOKEN: true }, enabled: false });
    expect(d.bridge!.saveSecrets).toHaveBeenCalledWith("publish-netlify", { env: { NETLIFY_AUTH_TOKEN: SECRET } });
    expect(JSON.stringify(d.requests)).not.toContain(SECRET);
  });

  it("an entry that already exists just gets the new value", async () => {
    const d = deps({ existing: true });
    expect((await connectWithToken(d.deps, SECRET, CTX)).state).toBe("connected");
    expect(d.bridge!.saveSecrets).toHaveBeenCalledOnce();
    expect(JSON.stringify(d.requests)).not.toContain(SECRET);
  });

  it("a different command already holding the token entry's name never receives the value", async () => {
    const d = deps({ existing: true, foreign: true });
    expect(await connectWithToken(d.deps, SECRET, CTX)).toEqual({ state: "needs-token", why: "save-failed" });
    expect(d.bridge!.saveSecrets).not.toHaveBeenCalled();
  });

  it("a token Netlify rejects is said plainly and nothing is echoed", async () => {
    const d = deps({ check: { connected: false, reason: "rejected", via: "token" } });
    const result = await connectWithToken(d.deps, SECRET, CTX);
    expect(result).toEqual({ state: "needs-token", why: "token-rejected" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("Netlify being out of reach is not blamed on the token", async () => {
    const d = deps({ check: { connected: false, reason: "unreachable", via: "token" } });
    expect(await connectWithToken(d.deps, SECRET, CTX)).toEqual({ state: "needs-token", why: "unreachable" });
  });

  it("a value that cannot be a token is turned back before anything is sent", async () => {
    for (const bad of ["", "   ", "two words", "a".repeat(600), "line\nbreak"]) {
      const d = deps();
      expect(await connectWithToken(d.deps, bad, CTX)).toEqual({ state: "needs-token", why: "token-shape" });
      expect(d.requests).toEqual([]);
    }
    expect(readableToken(` ${SECRET} `)).toBe(SECRET);
  });

  it("in a dev launch with no shell the value rides in the body to the harness's own store, and still never to the check", async () => {
    const d = deps({ bridge: null });
    expect((await connectWithToken(d.deps, SECRET, CTX)).state).toBe("connected");
    expect(JSON.parse(d.requests[0]!.body).env).toEqual({ NETLIFY_AUTH_TOKEN: SECRET });
    expect(d.requests[1]!.body).not.toContain(SECRET);
  });

  it("a failed save says so in a plain sentence, without the value", async () => {
    const d = deps({ bridge: { saveSecrets: vi.fn(async () => ({ ok: false, error: "storage", message: "Could not save that." })) } });
    const result = await connectWithToken(d.deps, SECRET, CTX);
    expect(result).toEqual({ state: "needs-token", why: "save-failed", error: "Could not save that." });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
