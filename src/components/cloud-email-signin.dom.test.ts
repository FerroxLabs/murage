// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { BotEmailAccountCard } from "./BotEmailSettings";
import { resetHeldEmailStatus } from "../lib/bot-email";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../state/store", async original => ({ ...await original<typeof import("../state/store")>(), useStore: () => ({ state: { config: { flux: { configured: true } }, bots: [] }, dispatch: vi.fn() }), api: fixture.api }));
const BASE = "/api/email/owner-signin";
let connected: boolean, signoutState: string;
let available: boolean, fail: boolean, hold: boolean, release: ((value: unknown) => void) | undefined;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers(); connected = false; signoutState = "disconnecting"; available = false; fail = false; hold = false; release = undefined; resetHeldEmailStatus();
  const meta = document.createElement("meta"); meta.name = "murage-home-id"; meta.content = "fixture-home"; document.head.append(meta);
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === BASE) { if (hold) return new Promise(() => {}); if (fail) throw new Error("offline"); return { connected, available, ttlMs: available ? 30_000 : 0 }; }
    if (path === `${BASE}/sign-out`) return new Promise(resolve => { release = resolve; });
    if (path === `${BASE}/start`) return new Promise(resolve => { release = resolve; });
    if (path.startsWith(`${BASE}/attempts/`) && connected) return { requestId: "unlink-1", state: signoutState };
    if (path.startsWith(`${BASE}/attempts/`)) return { requestId: "fixture-1", state: "code", userCode: "ABCD-1234", verificationUrl: "https://flux.test/device" };
    if (path.startsWith("/api/email/status")) throw { status: 404 };
    throw new Error(`Unexpected request ${path} ${init?.method ?? "GET"}`);
  });
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); document.head.querySelectorAll('meta[name="murage-home-id"]').forEach(node => node.remove()); vi.useRealTimers(); });
const connect = () => [...document.querySelectorAll("button")].find(button => button.textContent === "Connect email account");
const posts = () => fixture.api.mock.calls.filter(([path, init]) => path === `${BASE}/start` && init?.method === "POST");
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await settle(); }
async function open() { mount(h(BotEmailAccountCard, { status: { kind: "off" } })); await tick(); }

describe("Cloud BotEmailSettings device-code connect", () => {
  it("404 capability state shows no button or connection promise, and a later valid report reveals it", async () => {
    await open();
    expect(connect()).toBeUndefined();
    expect(document.body.textContent).toContain("Email connection is not available on this Cloud home yet.");
    expect(document.body.textContent).not.toContain("Connect your Flux Router account");
    available = true; await tick(5_000); expect(connect()).toBeDefined(); expect(posts()).toHaveLength(0);
  });
  it("availability loss or a failed local read hides a previously available button", async () => {
    available = true; await open(); expect(connect()).toBeDefined();
    available = false; await tick(5_000); expect(connect()).toBeUndefined();
    available = true; await tick(5_000); expect(connect()).toBeDefined();
    fail = true; await tick(5_000); expect(connect()).toBeUndefined();
    fail = false; await tick(5_000); expect(connect()).toBeDefined();
    hold = true; await tick(30_000); expect(connect()).toBeUndefined();
  });
  it("one click posts once, a rapid double click cannot start twice, and the code and link use plain words", async () => {
    available = true; await open(); const button = connect()!; expect(button).toBeDefined();
    act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick(); expect(posts()).toHaveLength(1);
    await act(async () => { release!({ requestId: "fixture-1", state: "waiting" }); }); await tick(2_000);
    expect(document.body.textContent).toContain("and enter this code: ABCD-1234.");
    expect(document.querySelector('a[href="https://flux.test/device"]')?.textContent).toBe("Flux Router sign-in");
    expect(posts()).toHaveLength(1);
  });
  it("the Cloud card does not use the desktop sign-in bridge and the desktop card keeps its existing stub", async () => {
    const start = vi.fn(); window.muragebox = { emailOwnerSignin: { start } } as unknown as NonNullable<Window["muragebox"]>;
    available = true; await open(); expect(connect()).toBeDefined(); expect(start).not.toHaveBeenCalled();
    cleanup(); document.head.querySelector('meta[name="murage-home-id"]')!.remove(); fixture.api.mockClear();
    await open(); expect(connect()).toBeUndefined(); expect(fixture.api.mock.calls.some(([path]) => path === BASE)).toBe(false);
    expect(document.querySelector('[data-testid="bot-email-account-stub"]')).not.toBeNull();
    delete window.muragebox;
  });
});

describe("M1 Cloud email sign-out control", () => {
  it("only a connected home offers sign-out, double click posts once, and completion uses plain states", async () => {
    connected = true; await open();
    const buttons = [...document.querySelectorAll("button")].filter(button => button.textContent === "Sign out of email");
    expect(buttons).toHaveLength(1); expect(connect()).toBeUndefined();
    act(() => { buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await tick();
    expect(fixture.api.mock.calls.filter(([path]) => path === `${BASE}/sign-out`)).toHaveLength(1);
    expect(document.body.textContent).toContain("Signing out of email.");
    await act(async () => { release!({ requestId: "unlink-1", state: "disconnecting" }); });
    signoutState = "unlinked"; await tick(2_000);
    expect(document.body.textContent).toContain("Signed out of email.");
    expect([...document.querySelectorAll("button")].filter(button => button.textContent === "Sign out of email")).toHaveLength(0);
  });
  it("the connected account keeps its email controls and has one sign-out button", async () => {
    connected = true;
    mount(h(BotEmailAccountCard, { status: { kind: "on", view: { enabled: true, accountState: "active", termsVersion: null, limits: {}, removing: [], rows: [], ownerSignedIn: true } } }));
    await tick();
    expect(document.querySelector('[data-testid="bot-email-account"]')).not.toBeNull();
    expect([...document.querySelectorAll("button")].filter(button => button.textContent === "Sign out of email")).toHaveLength(1);
    expect(connect()).toBeUndefined();
  });
  it("a disconnected home has no sign-out button", async () => {
    await open(); expect(document.body.textContent).not.toContain("Sign out of email");
  });
});
