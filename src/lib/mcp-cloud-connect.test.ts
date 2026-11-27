import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { McpConnectView } from "@/components/McpConnectButton";
import { connectPath, requestConnect, runConnect, showsConnect, type ConnectState } from "./mcp-cloud-connect";

const AUTHORIZE = "https://auth.example.test/authorize?state=abc&code_challenge=xyz";
const failure = (status: number, error: string) => Object.assign(new Error(error), { status, body: { error } });

// Contract with MurageCloud M1 (cloud-home/mcp-signin-connect.ts): POST, no body, 200 { url }, 403 { error }.
describe("the Cloud MCP connect contract", () => {
  it("posts to the named server's connect route with no body and returns the provider url", async () => {
    const call = vi.fn(async () => ({ url: AUTHORIZE }));
    expect(await requestConnect("notes_svc", call)).toEqual({ ok: true, url: AUTHORIZE });
    expect(connectPath("notes_svc")).toBe("/api/cloud/mcp/servers/notes_svc/connect");
    expect(call).toHaveBeenCalledWith("/api/cloud/mcp/servers/notes_svc/connect", { method: "POST" });
  });

  it("shows the home's one plain line when it answers 403", async () => {
    const line = "That connected tool is no longer here. Refresh the list, then try again.";
    expect(await requestConnect("svc", async () => { throw failure(403, line); })).toEqual({ ok: false, message: line });
  });

  it("refuses an answer without an https url, and a name the route would not match, without sending", async () => {
    for (const body of [{}, null, { url: "http://auth.example.test/a" }, { url: "javascript:alert(1)" }, { url: 7 }]) {
      const result = await requestConnect("svc", async () => body);
      expect(result.ok).toBe(false);
    }
    const call = vi.fn();
    expect((await requestConnect("../x", call)).ok).toBe(false);
    expect((await requestConnect("Bad Name", call)).ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("which rows get the button", () => {
  const row = { kind: "remote", auth: "oauth", status: "needs-sign-in" };
  it("only a Cloud OAuth link that is not signed in", () => {
    expect(showsConnect({ cloud: true, server: row })).toBe(true);
    expect(showsConnect({ cloud: false, server: row })).toBe(false);
    expect(showsConnect({ cloud: true, server: { ...row, status: "ready" } })).toBe(false);
    expect(showsConnect({ cloud: true, server: { ...row, auth: "header" } })).toBe(false);
    expect(showsConnect({ cloud: true, server: { ...row, auth: "none" } })).toBe(false);
    expect(showsConnect({ cloud: true, server: { ...row, kind: "command" } })).toBe(false);
  });
});

describe("the connect states, as the owner sees them", () => {
  const html = (state: ConnectState) => renderToStaticMarkup(createElement(McpConnectView, { state, host: "notes.example.test", onConnect: () => {}, onCancel: () => {} }));
  it("idle: one Connect button", () => { const out = html({ phase: "idle" }); expect(out).toContain(" Connect</button>"); expect(out).toContain("<button"); });
  it("connecting: plain words, no button", () => { const out = html({ phase: "connecting" }); expect(out).toContain("Getting ready"); expect(out).not.toContain("<button"); });
  it("waiting: names the provider, offers open again and cancel", () => {
    const out = html({ phase: "waiting", url: AUTHORIZE });
    expect(out).toContain("Finish signing in at notes.example.test");
    expect(out).toContain(`href="${AUTHORIZE.replace(/&/g, "&amp;")}"`);
    expect(out).toContain("Cancel");
  });
  it("connected: says so", () => expect(html({ phase: "connected" })).toContain("Connected"));
  it("failed: shows the line and a retry button", () => { const out = html({ phase: "failed", message: "Murage could not reach that tool." }); expect(out).toContain("Murage could not reach that tool."); expect(out).toContain("Try again"); });
});

describe("the connect run", () => {
  const base = (overrides: Partial<Parameters<typeof runConnect>[0]> = {}) => {
    const seen: ConnectState[] = [];
    return { seen, deps: { name: "svc", host: "h.example.test", set: (s: ConnectState) => { seen.push(s); }, stopped: () => false, sleep: async () => {}, pollMs: 10, timeoutMs: 50, signedIn: async () => true, call: async () => ({ url: AUTHORIZE }), open: async () => true, ...overrides } };
  };
  it("connecting, waiting for the provider, then connected; opens the provider page once", async () => {
    const open = vi.fn(async () => true);
    const polls = [null, false, true]; const { seen, deps } = base({ open, signedIn: async () => polls.shift() ?? true });
    await runConnect(deps);
    expect(seen.map((s) => s.phase)).toEqual(["connecting", "waiting", "connected"]);
    expect(open).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledWith(AUTHORIZE);
  });
  it("a refused connect fails with the line and never opens a page", async () => {
    const open = vi.fn(); const { seen, deps } = base({ open, call: async () => { throw failure(403, "Sign in is not available on this Murage right now."); } });
    await runConnect(deps);
    expect(seen.at(-1)).toEqual({ phase: "failed", message: "Sign in is not available on this Murage right now." }); expect(open).not.toHaveBeenCalled();
  });
  it("never signing in ends in failed with a retry, not a spinner", async () => {
    const { seen, deps } = base({ signedIn: async () => false });
    await runConnect(deps);
    expect(seen.at(-1)).toMatchObject({ phase: "failed" });
  });
  it("a cancel stops quietly: nothing more is set", async () => {
    let stop = false; const { seen, deps } = base({ signedIn: async () => false, stopped: () => stop, sleep: async () => { stop = true; } });
    await runConnect(deps);
    expect(seen.map((s) => s.phase)).toEqual(["connecting", "waiting"]);
  });
  it("a retry after a failure runs the whole flow again", async () => {
    let n = 0; const { seen, deps } = base({ call: async () => { if (n++ === 0) throw failure(403, "x"); return { url: AUTHORIZE }; } });
    await runConnect(deps); await runConnect(deps);
    expect(seen.map((s) => s.phase)).toEqual(["connecting", "failed", "connecting", "waiting", "connected"]);
  });
});
