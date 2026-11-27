// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// ASTRA 2d43a0c6b9 (fix1022-y10-mcpconnect): the Settings row Connect in a plain Cloud browser, with NOTHING injected between the click and the
// home: the real McpServersPanel and McpConnectButton, the real api() and the real owner fresh-code flow. Only fetch answers, like the home does:
// the connect route refuses once for a fresh code, the owner types it, the same request carries the proof and answers the authorize url, and the
// row reloads signed in. Only useStore (a panel prop source that has nothing to do with sign-in) is replaced.
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount } from "../testing/dom-harness";
import { getOwnerCodeSession, ownerCodeActions, OWNER_PROOF_HEADER } from "../lib/owner-code";
import { McpServersPanel } from "./McpServersPanel";

vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const AUTHORIZE = "https://auth.example.test/authorize?state=abc&code_challenge=xyz";
const CONNECT = "/api/cloud/mcp/servers/notes_svc/connect";
const PROOF = { payload: "eyJwIjoxfQ", signature: "c2ln" };
const refusal = { error: "Needs a code.", code: "email_code", actToken: "tok.sig", label: "mcp_connect", labelArg: "notes_svc" };
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const row = (status: string) => ({ name: "notes_svc", kind: "remote", url: "https://notes.example.test/mcp", host: "notes.example.test", auth: "oauth", headerNames: [], enabled: false, status });
let restore: () => void;
let status = "needs-sign-in";
let seen: Array<{ url: string; init: any }> = [];
const open = vi.fn();

beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  status = "needs-sign-in";
  seen = [];
  open.mockReset().mockImplementation(() => ({ opener: "page" }));
  (window as unknown as { open: unknown }).open = open;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "murage-home-id");
  meta.setAttribute("content", "home-1");
  document.head.append(meta);
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    seen.push({ url, init });
    if (url === CONNECT) return init?.headers?.[OWNER_PROOF_HEADER] ? answer(200, { url: AUTHORIZE }) : answer(403, refusal);
    if (url === "/api/cloud/owner-code/send") return answer(200, { challengeId: "c1", maskedEmail: "s***@example.test", resendIn: 30 });
    if (url === "/api/cloud/owner-code/verify") return answer(200, { proof: PROOF });
    if (url === "/api/mcp/servers") return answer(200, { servers: [row(status)] });
    return answer(200, {});
  });
});
afterEach(() => {
  ownerCodeActions.cancel();
  cleanup();
  document.head.querySelectorAll('meta[name="murage-home-id"]').forEach((m) => m.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const byText = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const connects = () => seen.filter((s) => s.url === CONNECT);

describe("Settings row Connect in a plain cloud browser, nothing injected", () => {
  it("click, fresh owner code, the same request with the proof, the provider opens, and the row reloads signed in", async () => {
    const view = mount(createElement(McpServersPanel));
    await tick(10);
    const button = byText(view.container, "Connect");
    expect(button).toBeTruthy();
    await act(async () => { (button as HTMLElement).click(); await Promise.resolve(); });
    await tick(10);
    expect(getOwnerCodeSession()?.phase).toBe("ready");
    expect(open).not.toHaveBeenCalled();
    await act(async () => { ownerCodeActions.submit("123456"); });
    await tick(10);
    expect(connects()).toHaveLength(2);
    expect(connects()[0]!.init.headers?.[OWNER_PROOF_HEADER]).toBeUndefined();
    expect(connects()[1]!.init.headers[OWNER_PROOF_HEADER]).toBeTruthy();
    expect(open).toHaveBeenCalledWith(AUTHORIZE, "_blank");
    status = "ready";
    await tick(2500);
    expect(byText(view.container, "Connect")).toBeUndefined();
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/computer app|desktop/i);
  });
});
