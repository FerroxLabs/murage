// @vitest-environment jsdom
// Presentation tests only. Real clearing/audit and packaged evidence belong to S2/S4.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotFreshStartAction } from "./BotFreshStartAction";
import { setSettingsMode } from "@/lib/settings-mode";

const mocks = vi.hoisted(() => ({ api: vi.fn(), desktop: true, signedOut: (() => {}) as () => void, signOutListeners: new Set<() => void>() }));
vi.mock("@/state/store", () => ({ api: mocks.api, useStore: () => ({ state: { bots: [{ id: "a", name: "Nova" }], selectedId: "a" }, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => mocks.desktop }));
// session-check broadcasts to every observer, including the dialog and Memory status.
vi.mock("@/lib/session-check", () => ({ onSignedOut: (fn: () => void) => { mocks.signOutListeners.add(fn); mocks.signedOut = () => { for (const listener of mocks.signOutListeners) listener(); }; return () => { mocks.signOutListeners.delete(fn); }; }, sessionSignedOut: () => false }));

const bot = { id: "a", name: "Nova" };
// Frozen S0 C1 wire fixtures. Kept literal to catch accidental request/response changes.
const preview = (patch: Record<string, unknown> = {}) => ({ policyVersion: "gh18-fresh-start-v2", botId: "a", botName: "Nova", state: "ready", reason: null, staleBlocks: 2, freshSessions: 3, retainedBlocks: 7, retainedCapped: false, previewToken: "preview-a", expiresAt: Date.now() + 120000, ...patch });
const done = (patch: Record<string, unknown> = {}) => ({ operationId: "operation-a", policyVersion: "gh18-fresh-start-v2", botId: "a", state: "done", reason: null, clearedBlocks: 2, freshSessions: 3, retainedBlocks: 7, retainedCapped: false, visibilityChanged: false, ...patch });
let root: Root, host: HTMLDivElement;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => { const found = buttons().find(b => b.textContent?.trim() === name); expect(found, `button ${name}`).toBeDefined(); return found!; };
const click = async (name: string) => { await act(async () => button(name).click()); };
const render = async (value = bot, active = true) => { await act(async () => root.render(createElement(BotFreshStartAction, { bot: value, active }))); };
const confirmCalls = () => mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/confirm"));
const open = () => click("Start fresh for this bot");
const key = async (key: string, shiftKey = false) => { await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }))); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockReset(); mocks.desktop = true; mocks.signOutListeners.clear();
  mocks.api.mockImplementation(async (path: string) => path.endsWith("/preview") ? preview() : done());
  setSettingsMode("advanced");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  // jsdom has no layout; the real focus trap still runs its keyboard and focus-return logic.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("GH18 fresh-start owner presentation", () => {
  it("gh18_open_and_cancel_never_mutate", async () => {
    await render(); expect(mocks.api).not.toHaveBeenCalled();
    await open(); expect(mocks.api.mock.calls[0].slice(0, 2)).toEqual(["/api/memory/bots/a/fresh-start/preview", expect.objectContaining({ method: "POST", body: "{}" })]);
    await click("Cancel"); expect(confirmCalls()).toHaveLength(0); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("gh18_confirm_names_bot_and_consequences", async () => {
    await render(); await open();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Start fresh for Nova?");
    expect(document.body.textContent).toContain("New conversations start clean. Deleted and withdrawn information stays hidden.");
    await click("Start fresh");
    expect(JSON.parse(confirmCalls()[0][1].body)).toEqual({ previewToken: "preview-a", confirm: true, idempotencyKey: expect.any(String) });
    expect(document.body.textContent).toContain("Nova starts fresh in 3 chats. Cleared 2 old blocks. Deleted and withdrawn information stays hidden.");
    await click("Close");
  });
  it("gh18_switch_bot_invalidates_preview", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await render(); await open(); await render({ id: "b", name: "Rex" });
    await act(async () => resolve(preview()));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(confirmCalls()).toHaveLength(0);
    await render(); await open(); await render({ ...bot, name: "Renamed" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("gh18_all_statuses_have_truthful_copy", async () => {
    const cases = [
      [preview({ state: "nothing-to-do", reason: "no-change", staleBlocks: 0, freshSessions: 0 }), "Nova already starts fresh."],
      ...Object.entries({ "deletion-pending": "Memory deletion is still finishing.", "lineage-unready": "Memory is still being checked.", "bot-busy": "Wait for Nova to finish replying.", "limit-exceeded": "This check did not finish. No blocks were cleared.", "unsupported-schema": "This version cannot clear these blocks.", "policy-unavailable": "These blocks cannot be cleared. Deleted and withdrawn information stays hidden." }).map(([reason, text]) => [preview({ state: "blocked", reason }), text]),
    ];
    await render();
    for (const [response, text] of cases) {
      mocks.api.mockResolvedValueOnce(response); await open();
      expect(document.body.textContent).toContain(text); expect(buttons().some(b => b.textContent === "Start fresh" && !b.disabled)).toBe(false);
      await click("Close");
    }
    for (const response of [preview({ policyVersion: "future" }), preview({ unexpected: "content" }), preview({ staleBlocks: 1.5 }), preview({ botId: "other" })]) {
      mocks.api.mockResolvedValueOnce(response); await open();
      expect(document.body.textContent).toContain("This version cannot clear these blocks."); await click("Close");
    }
    mocks.api.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 })); await open();
    expect(document.body.textContent).toContain("Could not complete this request. Nothing was changed.");
  });
  it("gh18_unknown_outcome_reconciles_same_key", async () => {
    await render(); await open();
    mocks.api.mockRejectedValueOnce(new TypeError("lost response")); await click("Start fresh");
    expect(document.body.textContent).toContain("The result is not available yet. Check again.");
    const first = confirmCalls()[0][1].body;
    await click("Close"); await render(bot, false); await render(); await open();
    expect(confirmCalls()).toHaveLength(2); expect(confirmCalls()[1][1].body).toBe(first);
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/preview"))).toHaveLength(1);
    expect(document.body.textContent).toContain("Cleared 2 old blocks.");
    await click("Close");
  });
  it("a stale confirm requires a fresh preview and another explicit confirmation", async () => {
    await render(); await open();
    mocks.api.mockRejectedValueOnce(Object.assign(new Error("stale-preview"), { status: 409, body: { error: "stale-preview" } }));
    await click("Start fresh");
    expect(document.body.textContent).toContain("This check has expired or changed. Check again.");
    await click("Check again"); expect(confirmCalls()).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([p]) => String(p).endsWith("/preview"))).toHaveLength(2);
    await click("Cancel");
  });
  it("closing during submission reopens the same in-flight request without claiming cancellation", async () => {
    let resolve!: (value: unknown) => void;
    await render(); await open();
    mocks.api.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await click("Start fresh"); await click("Close"); await open();
    expect(confirmCalls()).toHaveLength(1);
    expect(document.body.textContent).toContain("Clearing old memory blocks…");
    await act(async () => resolve(done()));
    expect(document.body.textContent).toContain("Cleared 2 old blocks."); await click("Close");
  });
  it("a blocked terminal result can check again without silently confirming another action", async () => {
    await render(); await open();
    mocks.api.mockResolvedValueOnce(done({ state: "blocked", reason: "bot-busy", clearedBlocks: 0, freshSessions: 0 }));
    await click("Start fresh"); expect(document.body.textContent).toContain("Wait for Nova to finish replying.");
    await click("Check again"); expect(confirmCalls()).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([p]) => String(p).endsWith("/preview"))).toHaveLength(2);
    await click("Cancel");
  });
  it("unknown or inconsistent terminal data never becomes a success", async () => {
    await render(); await open();
    mocks.api.mockResolvedValueOnce(done({ visibilityChanged: true })); await click("Start fresh");
    expect(document.body.textContent).toContain("The result is not available yet. Check again.");
    expect(document.body.textContent).not.toContain("Cleared 2 old blocks.");
    const first = confirmCalls()[0][1].body;
    await click("Check again"); expect(confirmCalls()[1][1].body).toBe(first); await click("Close");
  });
  it("gh18_keyboard_focus_and_single_primary", async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await render(); button("Start fresh for this bot").focus(); await open();
    expect(document.activeElement).toBe(button("Cancel")); await key("Enter"); expect(confirmCalls()).toHaveLength(0);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => resolve(preview()));
    expect(document.querySelectorAll('[data-primary="true"]')).toHaveLength(1);
    await key("Tab", true); expect(document.activeElement).toBe(button("Start fresh"));
    await key("Tab"); expect(document.activeElement).toBe(button("Cancel"));
    await key("Escape"); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Start fresh for this bot"));
  });
  it("invalidates on auth loss, section leave, mode unmount, stale preview and non-desktop", async () => {
    await render(); await open(); await act(async () => mocks.signedOut()); expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(bot, false); await render(); await open(); await render(bot, false); expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(); await open(); await act(async () => setSettingsMode("simple")); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Set in Advanced")).toBeDefined();
    await act(async () => setSettingsMode("advanced")); mocks.api.mockResolvedValueOnce(preview({ expiresAt: Date.now() - 1 })); await open();
    expect(buttons().some(b => b.textContent === "Start fresh" && !b.disabled)).toBe(false); await click("Close");
    mocks.desktop = false; await render(); expect(host.textContent).toBe("");
  });
});

it("gh18_ui_applying_then_done_on_reopen", async () => {
  await render(); await open();
  mocks.api.mockResolvedValueOnce(done({ state: "applying", reason: "cursor-save-pending" }));
  await click("Start fresh");
  expect(document.body.textContent).toContain("Nova will start fresh once the changes are saved.");
  expect(document.body.textContent).not.toContain("Cleared 2 old blocks.");
  await click("Close"); await render(bot, false); await render(); await open();
  expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/operations/operation-a"))).toHaveLength(1);
  expect(confirmCalls()).toHaveLength(1);
  expect(document.body.textContent).toContain("Cleared 2 old blocks."); await click("Close");
});
it("gh18_ui_repeated_failed_flush_remains_applying", async () => {
  await render(); await open();
  const applying = done({ state: "applying", reason: "cursor-save-pending" });
  mocks.api.mockResolvedValueOnce(applying); await click("Start fresh"); await click("Close");
  mocks.api.mockResolvedValueOnce(applying); await open();
  expect(document.body.textContent).toContain("Nova will start fresh once the changes are saved.");
  expect(document.body.textContent).not.toContain("Cleared 2 old blocks."); await click("Close");
  mocks.api.mockRejectedValueOnce(new TypeError("status unavailable")); await open();
  expect(document.body.textContent).not.toContain("Cleared 2 old blocks.");
  expect(confirmCalls()).toHaveLength(1); await click("Close");
});

it("gh18_ui_memory_section_reopen_checks_pending_once_without_clicking", async () => {
  const selected = { id: "section-reopen", name: "Nova" };
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preview') ? preview({botId:selected.id}) : done({botId:selected.id}));
  await render(selected); await open();
  mocks.api.mockResolvedValueOnce(done({botId:selected.id,state:'applying',reason:'cursor-save-pending'}));
  await click('Start fresh'); await click('Close');
  await render(selected,false); await render(selected);
  const statusCalls = () => mocks.api.mock.calls.filter(([path]) => String(path).endsWith('/operations/operation-a'));
  expect(statusCalls()).toHaveLength(1);
  expect(document.body.textContent).toContain('Cleared 2 old blocks.');
  await render(selected); expect(statusCalls()).toHaveLength(1);
  expect(confirmCalls()).toHaveLength(1);
  await open(); expect(statusCalls()).toHaveLength(1); await click('Close');
});

it.each(['deletion-pending','bot-busy','lineage-unready','limit-exceeded','unsupported-schema','policy-unavailable'])(
  'gh18_blocked_%s_never_claims_an_unmeasured_retained_count', async reason => {
    const selected = {id:`blocked-${reason}`,name:'Nova'};
    mocks.api.mockResolvedValueOnce(preview({botId:selected.id,state:'blocked',reason,staleBlocks:0,freshSessions:0,retainedBlocks:0}));
    await render(selected); await open();
    expect(mocks.api.mock.calls[0][0]).toBe(`/api/memory/bots/${selected.id}/fresh-start/preview`);
    expect(document.body.textContent).not.toContain('0 blocks stay in place.');
    expect(confirmCalls()).toHaveLength(0);
    await click('Close');
  },
);

it('gh18_blocked_confirm_hides_unmeasured_counts_but_completed_checks_keep_them', async () => {
  const selected = {id:'blocked-confirm',name:'Nova'};
  mocks.api.mockImplementation(async (path:string) => path.endsWith('/preview') ? preview({botId:selected.id}) : done({botId:selected.id}));
  await render(selected); await open();
  expect(document.body.textContent).toContain('7 blocks stay in place.');
  mocks.api.mockResolvedValueOnce(done({botId:selected.id,state:'blocked',reason:'policy-unavailable',clearedBlocks:0,freshSessions:0,retainedBlocks:0}));
  await click('Start fresh');
  expect(document.body.textContent).toContain('These blocks cannot be cleared.');
  expect(document.body.textContent).not.toContain('0 blocks stay in place.');
  await click('Close'); await open(); await click('Start fresh');
  expect(document.body.textContent).toContain('7 blocks stay in place.');
  await click('Close');
});


it('gh18_escape_after_terminal_requires_a_new_preview', async () => {
  const selected={id:'escape-terminal',name:'Nova'};
  mocks.api.mockImplementation(async (path:string)=>path.endsWith('/preview')?preview({botId:selected.id}):done({botId:selected.id}));
  await render(selected); await open(); await click('Start fresh');
  expect(document.body.textContent).toContain('Cleared 2 old blocks.');
  await key('Escape'); expect(document.querySelector('[role="dialog"]')).toBeNull();
  await open();
  expect(mocks.api.mock.calls.filter(([path])=>String(path).endsWith('/preview'))).toHaveLength(2);
  expect(confirmCalls()).toHaveLength(1); expect(document.body.textContent).not.toContain('Cleared 2 old blocks.');
  await click('Cancel');
});
it('gh18_escape_keeps_an_unknown_request_for_same_key_reconciliation', async () => {
  const selected={id:'escape-unknown',name:'Nova'};
  mocks.api.mockImplementation(async (path:string)=>path.endsWith('/preview')?preview({botId:selected.id}):done({botId:selected.id}));
  await render(selected); await open(); mocks.api.mockRejectedValueOnce(new TypeError('lost response'));
  await click('Start fresh'); const canonical=confirmCalls()[0][1].body;
  await key('Escape'); await open();
  expect(confirmCalls()).toHaveLength(2); expect(confirmCalls()[1][1].body).toBe(canonical);
  expect(mocks.api.mock.calls.filter(([path])=>String(path).endsWith('/preview'))).toHaveLength(1);
  await click('Close');
});
