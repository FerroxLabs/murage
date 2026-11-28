// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN 2026-11-22T19:56Z (bld1022-mcp-connect): the Connect click works in BOTH places. Desktop goes through the shell bridge as before;
// a plain Cloud browser (no shell) reaches the home's connect route through the real api() with its owner fresh-code step, and never
// shows the desktop-only line. Nothing here injects the transport: fetch answers like the home, api() and the owner-code flow are real.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpDraftCard } from "@/components/McpDraftCard";
import { api } from "@/state/store";
import { inspectInput, signInTo, type ProbeView } from "./mcp-add-flow";
import { runConnect, type ConnectState } from "./mcp-cloud-connect";
import { getOwnerCodeSession, ownerCodeActions, OWNER_PROOF_HEADER } from "./owner-code";
import { newCardState } from "./mcp-card-view";

const AUTHORIZE = "https://auth.example.test/authorize?state=abc&code_challenge=xyz";
const CONNECT = "/api/cloud/mcp/servers/notes_svc/connect";
const PROOF = { payload: "eyJwIjoxfQ", signature: "c2ln" };
const home = { querySelector: () => ({ getAttribute: () => "home-1" }) } as unknown as Document;
const notHome = { querySelector: () => null } as unknown as Document;
const refusal = { error: "Needs a code.", code: "email_code", actToken: "tok.sig", label: "mcp_connect", labelArg: "notes_svc" };
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
const ready = () => vi.waitFor(() => expect(getOwnerCodeSession()?.phase).toBe("ready"));

/** A Cloud home that answers like the real one: the connect route wants a fresh code, then returns the authorize url. */
function stubHome(listing: Array<"needs-sign-in" | "ready">) {
  const seen: Array<{ url: string; init: any }> = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    seen.push({ url, init });
    if (url === CONNECT) return init?.headers?.[OWNER_PROOF_HEADER] ? answer(200, { url: AUTHORIZE }) : answer(403, refusal);
    if (url === "/api/cloud/owner-code/send") return answer(200, { challengeId: "c1", maskedEmail: "s***@gmail.com", resendIn: 30 });
    if (url === "/api/cloud/owner-code/verify") return answer(200, { proof: PROOF });
    if (url === "/api/mcp/servers") return answer(200, { servers: [{ name: "notes_svc", kind: "remote", auth: "oauth", status: listing.shift() ?? "ready" }] });
    return answer(404, {});
  });
  return seen;
}
afterEach(() => { vi.unstubAllGlobals(); ownerCodeActions.cancel(); });

describe("a plain cloud browser (no shell): the three clicks reach the home", () => {
  it("add-card sign-in: connect, the fresh code, the same request with the proof, then connected", async () => {
    vi.stubGlobal("document", home);
    const seen = stubHome(["needs-sign-in", "ready"]);
    const open = vi.fn(() => ({}));
    vi.stubGlobal("window", { open });
    const run = signInTo({ api }, "notes_svc");
    await ready();
    ownerCodeActions.submit("123456");
    expect(await run).toEqual({ ok: true });
    const sent = seen.map((s) => s.url).filter((u) => u !== "/api/mcp/servers");
    expect(sent.filter((u) => !u.includes("secret"))).toEqual([CONNECT, "/api/cloud/owner-code/send", "/api/cloud/owner-code/verify", CONNECT]);
    const connects = seen.filter((s) => s.url === CONNECT);
    expect(connects[0]!.init.method).toBe("POST");
    expect(connects[1]!.init.headers[OWNER_PROOF_HEADER]).toBeTruthy();
    expect(open).toHaveBeenCalledWith(AUTHORIZE, "_blank");
  });

  it("settings click: runConnect through the real api() ends connected and never says desktop only", async () => {
    vi.stubGlobal("document", home);
    stubHome(["needs-sign-in", "ready"]);
    vi.stubGlobal("window", { open: () => ({}) });
    const seen: ConnectState[] = [];
    const run = runConnect({
      name: "notes_svc", host: "notes.example.test", stopped: () => false, sleep: async () => {}, pollMs: 10, timeoutMs: 100,
      set: (s) => { seen.push(s); },
      signedIn: async () => { const r = await api("/api/mcp/servers") as { servers: Array<{ status: string }> }; return r.servers[0]!.status === "ready"; },
    });
    await ready();
    ownerCodeActions.submit("123456");
    await run;
    expect(seen.map((s) => s.phase)).toEqual(["connecting", "waiting", "connected"]);
    expect(JSON.stringify(seen)).not.toMatch(/desktop/i);
  });

  it("the add card's sign-in button is live in a browser on a Cloud home, and shows no desktop-only line", async () => {
    vi.stubGlobal("document", home);
    vi.stubGlobal("window", {});
    const probe: ProbeView = { ok: false, error: "", reason: "needs-sign-in", signIn: { host: "notes.example.test" } };
    const fake = async () => ({ ok: true, drafts: [{ name: "notes_svc", probe }], noteKeys: [] });
    const found = await inspectInput({ api: fake as never }, JSON.stringify({ mcpServers: { notes_svc: { url: "https://notes.example.test/mcp" } } }));
    if (!found.ok) throw new Error(found.message);
    const state = { ...newCardState(found.drafts[0]!), probe, tested: true };
    const out = renderToStaticMarkup(createElement(McpDraftCard, { state, actions: new Proxy({}, { get: () => () => {} }) as never }));
    expect(out).toContain("Sign in");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Sign in/);
    expect(out).not.toMatch(/computer app|desktop/i);
  });
});

describe("the desktop shell path is unchanged", () => {
  it("with the shell present the bridge signs in and the home route is not called", async () => {
    vi.stubGlobal("document", notHome);
    const seen = stubHome([]);
    const bridge = { signIn: vi.fn(async () => ({ ok: true })) };
    expect(await signInTo({ api, bridge: bridge as never }, "notes_svc")).toEqual({ ok: true });
    expect(bridge.signIn).toHaveBeenCalledWith("notes_svc");
    expect(seen.filter((s) => s.url === CONNECT)).toEqual([]);
  });
  it("no shell and not a Cloud home: still the plain desktop-only failure, nothing fetched", async () => {
    vi.stubGlobal("document", notHome);
    const seen = stubHome([]);
    expect(await signInTo({ api }, "notes_svc")).toEqual({ ok: false, message: "", cancelled: false });
    expect(seen.filter((s) => s.url === CONNECT)).toEqual([]);
  });
});
