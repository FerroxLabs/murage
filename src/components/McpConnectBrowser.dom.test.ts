// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN n4:3745 (bld1022-mcp-connect), ASTRA/OPUS/FABLE b2de00c465: the three clicks in a plain Cloud browser (no shell), through the REAL components.
// The Settings row Connect (McpServersPanel -> McpConnectButton), the add card's Sign in (McpAddSection -> signInTo), a blocked pop-up and Cancel.
// Only the transport is replaced: api() answers like the home. Everything above it (panel, card, flow, runConnect) is production code.
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { McpAddSection } from "./McpAddSection";
import { McpServersPanel } from "./McpServersPanel";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const AUTHORIZE = "https://auth.example.test/authorize?state=abc&code_challenge=xyz";
const CONNECT = "/api/cloud/mcp/servers/notes_svc/connect";
const LINK = "https://notes.example.test/mcp";
const row = (status: string) => ({ name: "notes_svc", kind: "remote", url: LINK, host: "notes.example.test", auth: "oauth", headerNames: [], enabled: false, status });
const probe = { ok: false, error: "", reason: "needs-sign-in", signIn: { host: "notes.example.test" } };
let restore: () => void;
let status = "needs-sign-in";
const calls: string[] = [];
const open = vi.fn();

beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers();
  status = "needs-sign-in";
  calls.length = 0;
  // Like a real browser: a window opened with the "noopener" feature answers null, an ordinary open answers the window.
  open.mockReset().mockImplementation((_url: string, _target?: string, features?: string) => (features?.includes("noopener") ? null : { opener: "page" }));
  vi.stubGlobal("open", open);
  (window as unknown as { open: unknown }).open = open;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "murage-home-id");
  meta.setAttribute("content", "home-1");
  document.head.append(meta);
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === CONNECT) return { url: AUTHORIZE };
    if (path === "/api/mcp/servers" && !init?.method) return { servers: [row(status)] };
    if (path === "/api/mcp/servers" && init?.method === "POST") return { ok: true, name: "notes_svc" };
    if (path === "/api/mcp/inspect") return { ok: true, drafts: [{ name: "notes_svc", probe }], noteKeys: [] };
    if (path.endsWith("/test")) return { ok: true, tools: [] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  document.head.querySelectorAll('meta[name="murage-home-id"]').forEach((m) => m.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fixture.api.mockReset();
});

const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];
const byText = (root: HTMLElement, text: string) => buttons(root).find((b) => b.textContent?.trim().startsWith(text));
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const connects = () => calls.filter((c) => c === `POST ${CONNECT}`).length;
const listings = () => calls.filter((c) => c === "GET /api/mcp/servers").length;

async function openAddCard() {
  const view = mount(createElement(McpAddSection, { onClose: vi.fn(), onChanged: vi.fn(), onNotice: vi.fn() }));
  await settle();
  const box = view.container.querySelector("textarea")!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(box, LINK);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(byText(view.container, "Continue"));
  await tick(10);
  return view;
}

describe("a plain cloud browser (no shell), rendered", () => {
  it("settings row: the Connect click reaches the connect route, opens the provider and the row reloads signed in", async () => {
    const view = mount(createElement(McpServersPanel));
    await tick(10);
    await click(byText(view.container, "Connect"));
    await tick(10);
    expect(connects()).toBe(1);
    expect(open).toHaveBeenCalledWith(AUTHORIZE, "_blank");
    status = "ready";
    await tick(2500);
    expect(byText(view.container, "Connect")).toBeUndefined();
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/computer app|desktop/i);
  });

  it("add card: the Sign in click reaches the connect route and the card is not stuck on the desktop-only line", async () => {
    const view = await openAddCard();
    expect(view.container.textContent).not.toMatch(/computer app|desktop/i);
    await click(byText(view.container, "Sign in"));
    await tick(10);
    expect(connects()).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(open.mock.results[0]!.value).not.toBeNull();
    expect(open.mock.results[0]!.value.opener).toBeNull();
    await tick(2500);
    expect(view.container.querySelector('[data-view="signing"]')).toBeTruthy();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("add card: a blocked pop-up ends at once with a plain line, no poll, and a way to try again", async () => {
    open.mockReturnValue(null);
    const view = await openAddCard();
    await click(byText(view.container, "Sign in"));
    await tick(10);
    expect(connects()).toBe(1);
    const before = listings();
    await tick(10_000);
    expect(listings()).toBe(before);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toMatch(/blocked/i);
    expect(view.container.querySelector('[data-view="signing"]')).toBeNull();
    expect(byText(view.container, "Sign in")).toBeTruthy();
  });

  it("add card: Cancel while waiting stops the poll and returns to Sign in", async () => {
    const view = await openAddCard();
    await click(byText(view.container, "Sign in"));
    await tick(10);
    expect(view.container.querySelector('[data-view="signing"]')).toBeTruthy();
    await click(buttons(view.container).find((b) => b.textContent?.trim() === "Cancel" && b.closest("[data-view]")));
    await tick(10);
    expect(view.container.querySelector('[data-view="signing"]')).toBeNull();
    const before = listings();
    status = "ready";
    await tick(10_000);
    expect(listings()).toBe(before);
    expect(byText(view.container, "Sign in")).toBeTruthy();
  });
});
