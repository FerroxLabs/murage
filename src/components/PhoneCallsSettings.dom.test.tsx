// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 slice F4 (design 1023-phone-fslices 3.4, W7b, W8, W10, P26): the owner's page against a fake owner API. The real default
// export mounts; only the store (api, useStore) is the fixture, so every row, button and refusal line comes from the real screen.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: mocks.api, useStore: () => ({ state: { bots: [], config: {} }, dispatch: vi.fn() }) }));
import PhoneCallsSettings from "./PhoneCallsSettings";
import en from "@/locales/lazy/phone-calls/en.json";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Card = Record<string, unknown> & { id: string };
const card = (id: string, extra: Record<string, unknown> = {}): Card => ({ id, status: "ended", to: "+15550123456", dashboard: "https://dashboard.vapi.ai/calls/v", ...extra });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(error), { status, body: { error, ...extra } });

interface Fake {
  keyPresent: boolean;
  calls: Card[];
  bots: { id: string; name: string; allowed: boolean }[];
  retention: number | null;
  log: string[];
  failNext: Map<string, unknown>;
  botPages: number;
  badCursorOnce: boolean;
  status: Record<string, unknown>;
  /** While set, the next list reads wait for it (a refresh the test has not let through yet). */
  hold?: Promise<void>;
}
let fake: Fake;
let root: ReturnType<typeof createRoot> | undefined;
const T = (key: string) => (en as Record<string, string>)[key]!;

function install() {
  mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const route = `${method} ${path.split("?")[0]}`;
    fake.log.push(`${method} ${path}`);
    const queued = fake.failNext.get(route);
    if (queued) { fake.failNext.delete(route); throw queued; }
    if (route === "GET /api/phone-calls/status") return { supported: true, keyPresent: fake.keyPresent, active: null, olderScheduled: [], ...fake.status };
    if (route === "GET /api/phone-calls") { const answer = fake.calls; if (fake.hold) await fake.hold; return { calls: answer }; } // the answer is the list as it stood when the read left
    if (route === "GET /api/phone-calls/bots") {
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      const after = query.get("after");
      fake.botPages += 1;
      if (after && fake.badCursorOnce) { fake.badCursorOnce = false; throw fail(400, "bad_cursor"); }
      const start = after ? fake.bots.findIndex((b) => b.id === after) + 1 : 0;
      const page = fake.bots.slice(start, start + 200);
      return { bots: page, ...(start + 200 < fake.bots.length ? { next: page.at(-1)!.id } : {}) };
    }
    if (method === "PUT" && path.startsWith("/api/phone-calls/bots/")) {
      const bot = fake.bots.find((b) => b.id === decodeURIComponent(path.split("/").pop()!))!;
      bot.allowed = (JSON.parse(String(init!.body)) as { on: boolean }).on;
      return { allowed: bot.allowed };
    }
    if (route === "GET /api/phone-calls/retention") return { days: fake.retention };
    if (route === "PUT /api/phone-calls/retention") { fake.retention = (JSON.parse(String(init!.body)) as { days: number | null }).days; return { days: fake.retention }; }
    if (method === "DELETE") { const id = decodeURIComponent(path.split("/").pop()!); fake.calls = fake.calls.filter((c) => c.id !== id); return { ok: true }; }
    if (method === "POST" || method === "PUT") return {};
    return {};
  });
}
async function mountScreen() {
  vi.stubGlobal("muragebox", { phoneKey: { save: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) } });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(createElement(PhoneCallsSettings)));
  await act(async () => { await vi.dynamicImportSettled(); });
  return node;
}
const flush = () => act(async () => { await vi.dynamicImportSettled(); });
const buttons = (scope: ParentNode, label: string) => [...scope.querySelectorAll("button")].filter((b) => b.textContent === label);
const row = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="phone-result-card"][data-call-id="${id}"]`)!;
const count = (needle: string) => fake.log.filter((l) => l === needle || l.startsWith(`${needle}?`)).length;

beforeEach(() => {
  fake = { keyPresent: true, calls: [], bots: [], retention: null, log: [], failNext: new Map(), botPages: 0, badCursorOnce: false, status: {} };
  install();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  mocks.api.mockReset();
});

describe("W10 history without a key", () => {
  it("shows the key box first, then the history, Delete, Keep transcripts and bots, with no Keep and no plain Cancel", async () => {
    fake.keyPresent = false;
    fake.status = { hasCalls: true };
    fake.bots = [{ id: "b1", name: "Alpha", allowed: true }];
    fake.calls = [card("settled-1", { state: "settled" }), card("live-1", { state: "live", status: "ringing" }), card("held-1", { state: "held", held: "held", canKeep: true, status: "cancelled" })];
    const node = await mountScreen();
    const text = node.textContent!;
    expect(node.querySelector('input[type="password"]')).not.toBeNull();
    expect(text.indexOf(T("phoneCalls.step.key"))).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(T("phoneCalls.step.key"))).toBeLessThan(text.indexOf(T("phoneCalls.calls.title")));
    expect(text).toContain(T("phoneCalls.calls.title"));
    expect(text).toContain(T("phoneCalls.settings.keepTranscripts"));
    expect(text).toContain(T("phoneCalls.settings.whichBots"));
    expect(buttons(row(node, "settled-1"), T("phoneCalls.delete.action"))).toHaveLength(1);
    expect(buttons(node, T("phoneCalls.held.keep"))).toHaveLength(0);
    expect(buttons(row(node, "live-1"), T("phoneCalls.cancel"))).toHaveLength(0);
    expect(row(node, "live-1").textContent).toContain(T("phoneCalls.delete.needKey"));
    expect(buttons(row(node, "held-1"), T("phoneCalls.cancel"))).toHaveLength(1);
    expect(node.textContent).not.toContain(T("phoneCalls.step.number"));
  });
});

describe("W10 a fresh keyless install (FABLE-DESIGN 2060 H1)", () => {
  it("keeps the compact key entry and mounts no owner control: no list read or poll, no bots, no retention", async () => {
    fake.keyPresent = false;
    fake.bots = [{ id: "b1", name: "Alpha", allowed: true }];
    fake.calls = [card("settled-1", { state: "settled" })];
    // fake timers before the mount, so a list poll armed by any mounted control would fire inside the 15 s below
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let node!: HTMLDivElement;
    try {
      node = await mountScreen();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    } finally { vi.useRealTimers(); }
    const summary = node.querySelector("details:not([open]) > summary");
    expect([summary?.textContent, node.querySelector('[data-setting-control="phone-calls-heading"]'), fake.log], "fresh keyless install").toEqual([T("phoneCalls.title"), null, ["GET /api/phone-calls/status"]]);
    expect(node.querySelector("details input[type=\"password\"]")).not.toBeNull();
  });
});

describe("W8 every row shows only the controls its state allows", () => {
  it("draws Keep, Cancel and Delete from `state` alone", async () => {
    fake.calls = [
      card("held-keep", { state: "held", held: "held", canKeep: true, status: "cancelled" }),
      card("held-nokeep", { state: "held", held: "held", canKeep: false, status: "cancelled" }),
      card("held-cancelled", { state: "held", held: "cancelled", status: "cancelled" }),
      card("settled-kept", { state: "settled", held: "kept", status: "cancelled" }),
      card("live", { state: "live", status: "ringing" }),
      card("checking", { state: "checking", status: "uncertain" }),
      card("cancelling", { state: "cancelling", status: "ended" }),
    ];
    const node = await mountScreen();
    const has = (id: string, label: string) => buttons(row(node, id), T(label)).length;
    expect([has("held-keep", "phoneCalls.held.keep"), has("held-keep", "phoneCalls.cancel"), has("held-keep", "phoneCalls.delete.action")]).toEqual([1, 1, 0]);
    expect([has("held-nokeep", "phoneCalls.held.keep"), has("held-nokeep", "phoneCalls.cancel"), has("held-nokeep", "phoneCalls.delete.action")]).toEqual([0, 1, 0]);
    expect([has("held-cancelled", "phoneCalls.held.keep"), has("held-cancelled", "phoneCalls.cancel"), has("held-cancelled", "phoneCalls.delete.action")]).toEqual([0, 1, 0]);
    expect([has("settled-kept", "phoneCalls.held.keep"), has("settled-kept", "phoneCalls.cancel"), has("settled-kept", "phoneCalls.delete.action")]).toEqual([0, 0, 1]);
    expect([has("live", "phoneCalls.held.keep"), has("live", "phoneCalls.cancel"), has("live", "phoneCalls.delete.action")]).toEqual([0, 1, 0]);
    for (const [id, line] of [["checking", "phoneCalls.delete.checking"], ["cancelling", "phoneCalls.delete.cancelPending"]] as const) {
      expect([has(id, "phoneCalls.held.keep"), has(id, "phoneCalls.cancel"), has(id, "phoneCalls.delete.action")], id).toEqual([0, 0, 0]);
      expect(row(node, id).textContent, id).toContain(T(line));
    }
  });
  it("calls each button's route once", async () => {
    fake.calls = [card("k", { state: "held", held: "held", canKeep: true, status: "cancelled" }), card("d", { state: "settled" }), card("c", { state: "live", status: "ringing" })];
    const node = await mountScreen();
    await act(async () => buttons(row(node, "k"), T("phoneCalls.held.keep"))[0]!.click());
    await act(async () => buttons(row(node, "d"), T("phoneCalls.delete.action"))[0]!.click());
    await act(async () => buttons(row(node, "c"), T("phoneCalls.cancel"))[0]!.click());
    expect(fake.log.filter((l) => l === "POST /api/phone-calls/k/keep")).toHaveLength(1);
    expect(fake.log.filter((l) => l === "DELETE /api/phone-calls/d")).toHaveLength(1);
    expect(fake.log.filter((l) => l === "POST /api/phone-calls/c/cancel")).toHaveLength(1);
  });
});

describe("W7b a row deleted elsewhere just disappears", () => {
  it("a Delete answered 404 shows no error and the next list read drops the row", async () => {
    fake.calls = [card("gone", { state: "settled" })];
    const node = await mountScreen();
    fake.calls = [];
    fake.failNext.set("DELETE /api/phone-calls/gone", fail(404, "not_found"));
    // hold the list read that follows, so the row is still on screen when the answer's own line (if any) would show
    let release!: () => void;
    fake.hold = new Promise<void>((open) => { release = open; });
    const before = count("GET /api/phone-calls");
    await act(async () => buttons(row(node, "gone"), T("phoneCalls.delete.action"))[0]!.click());
    expect(count("GET /api/phone-calls"), "a list read follows the 404").toBeGreaterThan(before);
    expect(node.querySelector('[data-call-id="gone"]'), "row still shown until the fresh list").not.toBeNull();
    expect(node.querySelector('[data-testid="phone-action-line"]')).toBeNull();
    release();
    fake.hold = undefined;
    await flush();
    expect(node.querySelector('[data-call-id="gone"]')).toBeNull();
  });
  it("a Delete answered 409 live keeps the row with Cancel it first", async () => {
    fake.calls = [card("busy", { state: "settled" })];
    const node = await mountScreen();
    fake.failNext.set("DELETE /api/phone-calls/busy", fail(409, "live"));
    await act(async () => buttons(row(node, "busy"), T("phoneCalls.delete.action"))[0]!.click());
    await flush();
    expect(node.querySelector('[data-call-id="busy"]')).not.toBeNull();
    expect(row(node, "busy").textContent).toContain(T("phoneCalls.delete.live"));
  });
});

// ASTRA 798ca11e4c phone-calls.test.ts:429 (answer table): driven through the mounted page's real Delete / Cancel / Keep buttons, so
// on the pre-fix base (no per-row owner controls) every row fails at its button-count assertion, not at an import or a missing helper.
describe("W7c every owner answer shows its line and reads the list again only where the table says", () => {
  // literal English lines: the expectation never depends on the copy file of the tree under test (the pre-fix base lacks these keys)
  const rows: [string, "delete" | "cancel" | "keep", unknown, string | null, boolean][] = [
    ["404 on Delete", "delete", fail(404, "not_found"), null, true],
    ["404 on Cancel", "cancel", fail(404, "not_found"), null, true],
    ["404 on Keep", "keep", fail(404, "not_found"), "Call not confirmed yet.", true],
    ["live", "delete", fail(409, "live"), "Cancel it first.", true],
    ["checking", "delete", fail(409, "checking"), "Murage is still checking whether this call went out. Try again later.", true],
    ["cancel_pending", "delete", fail(409, "cancel_pending"), "A cancel for this booking is still in progress.", true],
    ["live needKey", "delete", fail(409, "live", { needKey: true }), "Add your Vapi key to cancel or check this call, then delete it.", true],
    ["checking needKey", "delete", fail(409, "checking", { needKey: true }), "Add your Vapi key to cancel or check this call, then delete it.", true],
    ["cancel_pending needKey", "delete", fail(409, "cancel_pending", { needKey: true }), "Add your Vapi key to cancel or check this call, then delete it.", true],
    ["not_confirmed", "cancel", fail(502, "not_confirmed"), "Call not confirmed yet.", true],
    ["not_confirmed needKey", "cancel", fail(502, "not_confirmed", { needKey: true }), "Add your Vapi key to cancel or check this call, then delete it.", true],
    ["cancelled (Keep after Cancel)", "keep", fail(409, "cancelled"), null, true],
    ["store_unavailable", "delete", fail(503, "store_unavailable"), "Murage couldn't open its call history. Restart Murage. If it keeps happening, check how much space is left on the disk.", false],
    ["not_set_up", "cancel", fail(409, "not_set_up"), "Save your Vapi private key first.", false],
    ["anything else (vendor text never shown)", "delete", fail(500, "vendor says: secret-token-text"), "Something went wrong. Try again.", false],
  ];
  it.each(rows)("%s", async (name, action, error, line, refresh) => {
    fake.calls = [card("r", action === "delete" ? { state: "settled" } : action === "cancel" ? { state: "live", status: "ringing" } : { state: "held", held: "held", canKeep: true, status: "cancelled" })];
    const node = await mountScreen();
    const [label, route] = action === "delete" ? [T("phoneCalls.delete.action"), "DELETE /api/phone-calls/r"] : action === "cancel" ? [T("phoneCalls.cancel"), "POST /api/phone-calls/r/cancel"] : [T("phoneCalls.held.keep"), "POST /api/phone-calls/r/keep"];
    fake.failNext.set(route, error);
    const before = count("GET /api/phone-calls");
    // no control assertion before the click: where the control is absent (the pre-fix base) the click is a no-op and the row fails at
    // the behavioural lines below (no refusal line, no list read), not at a precondition
    await act(async () => buttons(node, label)[0]?.click());
    await flush();
    expect(node.querySelector(`[data-call-id="r"] [data-testid="phone-action-line"]`)?.textContent ?? null, `${name} line`).toBe(line);
    expect(count("GET /api/phone-calls") > before, `${name} list read`).toBe(refresh);
    expect(node.textContent).not.toContain("secret-token-text");
    expect(buttons(node, label), `${name} control was clicked`).toHaveLength(1);
  });
});

// ASTRA 798ca11e4c phone-calls.test.ts:464 (stale list answer): the periodic read A is still in flight when a Delete's follow-up read B
// answers without the row; A then answers with the row. Through the mounted page. Delete is introduced by this lane: absent on the pre-fix base (p4-new-behaviour base RED at the :262 assertion); the guard is held by mutant W7a-STALE-GUARD (control kept, guard removed).
describe("W7a a stale list answer never brings a row back", () => {
  it("delivers only the newest list read", async () => {
    // rows are told apart by their number, which the pre-fix card also shows: the base fails at the lines below, not at a missing row
    fake.calls = [card("keep-me", { state: "settled", to: "+15550100" }), card("x-gone", { state: "settled", to: "+15550199" })];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let node!: HTMLDivElement;
    try {
      node = await mountScreen();
      expect(node.textContent, "both rows shown").toContain("+15550199");
      let release!: () => void;
      fake.hold = new Promise<void>((open) => { release = open; });
      const withX = [...fake.calls];
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // periodic read A leaves holding the row list that still has X
      fake.hold = undefined;
      fake.failNext.set("DELETE /api/phone-calls/x-gone", fail(404, "not_found"));
      fake.calls = withX.filter((c) => c.id !== "x-gone");
      await act(async () => buttons(node, T("phoneCalls.delete.action"))[1]?.click()); // Delete on X; read B answers without X
      await flush();
      release(); // A answers late, carrying X (it was built before B)
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await flush();
    } finally { vi.useRealTimers(); }
    expect(node.textContent, "stale A did not bring X back").not.toContain("+15550199");
    expect(node.textContent).toContain("+15550100");
  });
});

describe("P26 fine control", () => {
  it("shows the recommended lines, the responsibility line, the 16 languages and no monitoring, webhook or emergency control", async () => {
    mocks.api.mockImplementation(async (path: string) => path === "/api/phone-calls/status"
      ? { supported: true, keyPresent: true, active: { revision: 1, settings: { aiLine: { on: true, edits: {} }, notice: { on: true, edits: {} }, language: "auto", maxSeconds: 300, voices: {}, recordAudio: false, phoneNumberId: "pn-1", ownerName: "Sam" } }, olderScheduled: [] }
      : path === "/api/phone-calls" ? { calls: [] } : path.startsWith("/api/phone-calls/bots") ? { bots: [] } : path === "/api/phone-calls/retention" ? { days: null } : {});
    const node = await mountScreen();
    expect(node.textContent).toContain(T("phoneCalls.settings.responsibility"));
    expect(node.textContent!.split(`(${T("phoneCalls.settings.recommended")})`).length - 1).toBe(2);
    const checks = [...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.checked)).toBe(true);
    const select = [...node.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "auto"))!;
    expect([...select.options].map((o) => o.value).filter((v) => v !== "auto")).toHaveLength(16);
    expect(node.textContent).not.toMatch(/monitor|webhook|emergency/i);
    expect(node.textContent).not.toMatch(/phoneCalls\./);
  });
  it("shows the recording warning only while recording is on and the notice is off, and still saves", async () => {
    const saved: unknown[] = [];
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/phone-calls/status") return { supported: true, keyPresent: true, active: { revision: 1, settings: { aiLine: { on: true, edits: {} }, notice: { on: true, edits: {} }, language: "auto", maxSeconds: 300, voices: {}, recordAudio: false, phoneNumberId: "pn-1", ownerName: "Sam" } }, olderScheduled: [] };
      if (path === "/api/phone-calls/settings") { saved.push(JSON.parse(String(init!.body))); return { revision: 2 }; }
      if (path === "/api/phone-calls") return { calls: [] };
      if (path.startsWith("/api/phone-calls/bots")) return { bots: [] };
      if (path === "/api/phone-calls/retention") return { days: null };
      return {};
    });
    const node = await mountScreen();
    const warning = () => node.querySelector('[data-testid="phone-recording-warning"]');
    const record = node.querySelector<HTMLButtonElement>(`button[aria-label="${T("phoneCalls.form.recordAudio")}"]`)!;
    expect(warning()).toBeNull();
    await act(async () => record.click());
    expect(warning(), "recording on, notice on").toBeNull();
    const notice = [...node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!;
    await act(async () => notice.click());
    expect(warning()?.textContent, "recording on, notice off").toBe(T("phoneCalls.settings.recordingNoNotice"));
    await act(async () => buttons(node, T("phoneCalls.form.save"))[0]!.click());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ recordAudio: true, notice: { on: false } });
  });
  it("reaches and flips the 1,200th bot, restarts from page 1 on a bad cursor, and Keep transcripts writes through the route", async () => {
    fake.bots = Array.from({ length: 1200 }, (_, i) => ({ id: `bot-${i + 1}`, name: `Bot ${i + 1}`, allowed: true }));
    fake.badCursorOnce = true;
    const node = await mountScreen();
    expect(node.textContent).toContain("Bot 200");
    expect(node.textContent).not.toContain("Bot 201");
    // the first "Show more" is answered bad_cursor: the list restarts from page 1 once, then pages again
    await act(async () => buttons(node, T("phoneCalls.settings.showMore"))[0]!.click());
    await flush();
    const firstPageReads = fake.log.filter((l) => l === "GET /api/phone-calls/bots?limit=200").length;
    expect(firstPageReads).toBe(2);
    for (let i = 0; i < 5; i += 1) { await act(async () => buttons(node, T("phoneCalls.settings.showMore"))[0]!.click()); await flush(); }
    expect(buttons(node, T("phoneCalls.settings.showMore"))).toHaveLength(0);
    const last = node.querySelector<HTMLButtonElement>(`button[aria-label="${T("phoneCalls.settings.botAria").replace("{bot}", "Bot 1200")}"]`)!;
    expect(last).not.toBeNull();
    await act(async () => last.click());
    expect(fake.bots[1199]!.allowed).toBe(false);
    const keep = node.querySelector<HTMLSelectElement>('[data-testid="phone-retention"]')!;
    await act(async () => { keep.value = "30"; keep.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(fake.retention).toBe(30);
  });
});

describe("failures never read as an empty or settled page", () => {
  it("a history that answers 503 shows the store line, not 'no calls'", async () => {
    fake.failNext.set("GET /api/phone-calls", fail(503, "store_unavailable"));
    const node = await mountScreen();
    expect(node.querySelector('[data-testid="phone-store-down"]')?.textContent).toBe(T("phoneCalls.error.store"));
    expect(node.textContent).not.toContain(T("phoneCalls.calls.none"));
  });
  it("a switch answered 404 reads the bot list again instead of keeping a value the server may not hold", async () => {
    fake.bots = [{ id: "b1", name: "Alpha", allowed: true }, { id: "b2", name: "Beta", allowed: true }];
    const node = await mountScreen();
    fake.bots = [{ id: "b2", name: "Beta", allowed: true }];
    fake.failNext.set("PUT /api/phone-calls/bots/b1", fail(404, "not_found"));
    const reads = count("GET /api/phone-calls/bots");
    await act(async () => node.querySelector<HTMLButtonElement>(`button[aria-label="${T("phoneCalls.settings.botAria").replace("{bot}", "Alpha")}"]`)!.click());
    await flush();
    expect(count("GET /api/phone-calls/bots")).toBeGreaterThan(reads);
    expect(node.textContent).not.toContain("Alpha");
    expect(node.querySelector('[data-testid="phone-bots"] [role="alert"]')).toBeNull();
  });
});

