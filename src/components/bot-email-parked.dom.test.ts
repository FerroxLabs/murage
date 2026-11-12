// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// secret-scan: fixture (fake addresses and fake tokens)
// Restore park B3 (r3.1 sections 4, 6, 7, 11; T25): the desktop Keep/Remove rows on BotEmailAccountCard, and ConfirmDelete carrying the
// emailConfirm token. Real components, jsdom clicks, the wire contract's fixtures (server/email/owner-view-fixtures.json).
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { BotEmailAccountCard } from "./BotEmailSettings";
import { ConfirmDelete } from "./ConfirmDelete";
import { resetHeldEmailStatus } from "../lib/bot-email";
import { EMAIL_STATUS_EVENT } from "../lib/email-status-event";
import { EMAIL_OWNER_COPY, ownerRouteLine, type EmailStatusView } from "../../shared/email-copy.ts";
import fixtures from "../../server/email/owner-view-fixtures.json";

type Call = { path: string; method: string; body: Record<string, unknown> | undefined };
const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../state/store", async original => ({ ...await original<typeof import("../state/store")>(), useStore: () => ({ state: { config: null, bots: [] }, dispatch: vi.fn() }), api: fixture.api }));

const homeView = (): EmailStatusView => {
  const view = { removing: [], ...structuredClone(fixtures.homeView) } as unknown as EmailStatusView & { rows: Array<Record<string, unknown>> };
  // the server fills the proof thread in on every row (contract round 5)
  for (const row of view.rows) row.threadId = row.botId ? `thread-${String(row.botId)}` : "email-owner";
  return view;
};
const withTokens = (parked: [string, string]): EmailStatusView => {
  const view = homeView() as unknown as { rows: Array<{ section: string; actions: Array<{ kind: string; tokenId: string }> }> };
  const row = view.rows.find(item => item.section === "parked")!;
  row.actions[0]!.tokenId = parked[0]; row.actions[1]!.tokenId = parked[1];
  return view as unknown as EmailStatusView;
};
const calls: Call[] = [];
let statusAnswer: () => EmailStatusView;
let postAnswer: (call: Call) => unknown;
function install() {
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    const call: Call = { path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (path.startsWith("/api/email/status")) return statusAnswer();
    if (call.method === "POST") return postAnswer(call);
    return {};
  });
}
const posts = () => calls.filter(call => call.method === "POST");
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { calls.length = 0; resetHeldEmailStatus(); statusAnswer = homeView; postAnswer = () => ({ ...homeView(), rows: [] }); install(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

const buttonIn = (scope: Element, label: string) => [...scope.querySelectorAll("button")].find(item => item.textContent === label) as HTMLButtonElement;
async function click(el: Element) { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); await settle(); }
async function openCard(view: EmailStatusView = homeView()) {
  const app = mount(h(BotEmailAccountCard, { status: { kind: "on", view } }));
  await settle();
  return app;
}
const parkedBlock = () => document.querySelector('[data-testid="bot-email-parked"]') as HTMLElement;
const parkedRow = () => document.querySelector('[data-testid="bot-email-row-parked:b2"]') as HTMLElement;

describe("T25 parked section (BotEmailAccountCard)", () => {
  it("shows the parked rows with the server's line exactly, the shared title, and Keep and Remove", async () => {
    await openCard();
    expect(parkedBlock().textContent).toContain(EMAIL_OWNER_COPY.parkedTitle);
    expect(parkedRow().querySelector("p")!.textContent).toBe("This address came back with a restore. Keep it or remove it.");
    expect(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress)).toBeTruthy();
    expect(buttonIn(parkedRow(), EMAIL_OWNER_COPY.remove)).toBeTruthy();
    // a bot row is not a parked row: it stays in the bot's own section
    expect(document.querySelector('[data-testid="bot-email-row-bot:b1"]')).toBeNull();
  });

  it("Keep POSTs the row's own path with {token, target} from this view", async () => {
    await openCard();
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress));
    expect(posts()).toEqual([{ path: "/api/email/parked/b2/keep", method: "POST", body: { token: "tok_p_2k", target: "park:p2" } }]);
  });

  it("Remove asks once with the shared confirm line, then POSTs the row's own path with its token", async () => {
    await openCard();
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.remove));
    expect(window.confirm).toHaveBeenCalledWith(EMAIL_OWNER_COPY.otherSetupRemoveConfirm("max@mail.example"));
    expect(posts()).toEqual([{ path: "/api/email/parked/b2/remove", method: "POST", body: { token: "tok_p_2r", target: "park:p2" } }]);
  });

  it("Remove declined at the confirm sends nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await openCard();
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.remove));
    expect(posts()).toEqual([]);
  });

  it("an address from another setup is removed through its own row path and token", async () => {
    await openCard();
    const row = document.querySelector('[data-testid="bot-email-row-other_setup:in_9"]')!;
    await click(buttonIn(row, EMAIL_OWNER_COPY.remove));
    expect(posts()).toEqual([{ path: "/api/email/other-setups/in_9/remove", method: "POST", body: { token: "tok_f_9", target: "inbox:in_9" } }]);
  });

  it("a refusal shows the server's line exactly and survives the re-read and a later refresh", async () => {
    // the server's own wording wins over the shared line for the same code
    const refusal = { ...fixtures.refusal, error: "The server's own words, not the shared ones." };
    expect(refusal.error).not.toBe(ownerRouteLine(refusal.code));
    postAnswer = () => { throw { status: 409, body: refusal }; };
    await openCard();
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress));
    const line = () => document.querySelector('[data-testid="bot-email-refusal-parked:b2"]')?.textContent;
    expect(line()).toBe(refusal.error);
    // the re-read after the refusal already happened (GET status); a refresh from outside must not clear it either
    expect(calls.filter(call => call.path.startsWith("/api/email/status")).length).toBeGreaterThan(0);
    await act(async () => { window.dispatchEvent(new Event(EMAIL_STATUS_EVENT)); }); await settle(); await settle();
    expect(line()).toBe(refusal.error);
  });

  it("a stale token (confirm_expired, no line sent) shows the look-again line, and the next try uses the token from the re-read view", async () => {
    postAnswer = () => { throw { status: 409, body: { code: "confirm_expired", rowId: "parked:b2" } }; };
    statusAnswer = () => withTokens(["tok_p_NEW_k", "tok_p_NEW_r"]);
    await openCard(withTokens(["tok_p_OLD_k", "tok_p_OLD_r"]));
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress));
    expect(posts()[0]!.body).toEqual({ token: "tok_p_OLD_k", target: "park:p2" });
    expect(document.querySelector('[data-testid="bot-email-refusal-parked:b2"]')!.textContent).toBe(ownerRouteLine("confirm_expired"));
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress));
    expect(posts()[1]!.body).toEqual({ token: "tok_p_NEW_k", target: "park:p2" });
  });

  it("a success replaces the view with the answer's rows and shows no refusal", async () => {
    await openCard();
    await click(buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress));
    expect(parkedBlock()).toBeNull();
    expect(document.querySelector('[data-testid^="bot-email-refusal-"]')).toBeNull();
  });

  it("a path the contract does not allow disables the action and sends nothing", async () => {
    const view = homeView() as unknown as { rows: Array<{ section: string; actions: Array<{ path: string }> }> };
    view.rows.find(row => row.section === "parked")!.actions[0]!.path = "https://evil.example/api/email/parked/b2/keep";
    await openCard(view as unknown as EmailStatusView);
    const keep = buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress);
    expect(keep.disabled).toBe(true);
    await click(keep);
    expect(posts()).toEqual([]);
  });

  it("a path under /api/email/ that fits no contracted template for its action is disabled too", async () => {
    const view = homeView() as unknown as { rows: Array<{ section: string; actions: Array<{ path: string }> }> };
    view.rows.find(row => row.section === "parked")!.actions[0]!.path = "/api/email/parked/b2/delete";
    await openCard(view as unknown as EmailStatusView);
    const keep = buttonIn(parkedRow(), EMAIL_OWNER_COPY.keepAddress);
    expect(keep.disabled).toBe(true);
    await click(keep);
    expect(posts()).toEqual([]);
  });
});

function typeName(value: string) {
  const input = document.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const deleteButton = () => [...document.querySelectorAll("button")].find(item => item.textContent?.startsWith("Delete bot")) as HTMLButtonElement;
function previewAnswer(body: unknown) {
  fixture.api.mockReset().mockImplementation(async (path: string) => { calls.push({ path, method: "GET", body: undefined }); return body; });
}
async function openDelete(onConfirm = vi.fn()) {
  mount(h(ConfirmDelete, { name: "Ava", kind: "bot", detail: "gone", preview: { botId: "b1" }, onCancel: vi.fn(), onConfirm }));
  await settle(); await settle();
  return onConfirm;
}

describe("ConfirmDelete with an email address (T12, T25)", () => {
  it("shows the address line from the same answer that carried the token, and sends the token on confirm", async () => {
    previewAnswer({ savedFiles: 1, messages: 2, engines: [], email: { address: "juniper@murage.email", confirm: "v1.123.sig" } });
    const onConfirm = await openDelete();
    expect(document.querySelector('[data-testid="confirm-delete-email"]')!.textContent).toBe(EMAIL_OWNER_COPY.deleteAlsoRemoves("juniper@murage.email"));
    expect(document.querySelector('[data-testid="confirm-delete-email"]')!.textContent).toBe("This also removes juniper@murage.email.");
    typeName("Ava");
    await click(deleteButton());
    expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: "v1.123.sig" });
  });

  it("a bot with no address shows no line and confirms with no token", async () => {
    previewAnswer({ savedFiles: 1, messages: 2, engines: [] });
    const onConfirm = await openDelete();
    expect(document.querySelector('[data-testid="confirm-delete-email"]')).toBeNull();
    typeName("Ava"); await click(deleteButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it("a live address shows the line and sends no token", async () => {
    previewAnswer({ savedFiles: 1, email: { address: "live@murage.email" } });
    const onConfirm = await openDelete();
    expect(document.querySelector('[data-testid="confirm-delete-email"]')!.textContent).toBe("This also removes live@murage.email.");
    typeName("Ava"); await click(deleteButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it("T25: with the preview held Confirm is disabled; after 3 s it enables with no line and no token, and a late answer is ignored", async () => {
    vi.useFakeTimers();
    let release!: (body: unknown) => void;
    fixture.api.mockReset().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const onConfirm = vi.fn();
    mount(h(ConfirmDelete, { name: "Ava", kind: "bot", detail: "gone", preview: { botId: "b1" }, onCancel: vi.fn(), onConfirm }));
    await settle();
    typeName("Ava");
    expect(deleteButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(2999); });
    expect(deleteButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(deleteButton().disabled).toBe(false);
    await act(async () => { release({ savedFiles: 1, email: { address: "late@murage.email", confirm: "v1.late.sig" } }); });
    await settle();
    expect(document.querySelector('[data-testid="confirm-delete-email"]')).toBeNull();
    await click(deleteButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });
});
