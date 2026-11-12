// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelState, ReviewState } from "../../server/channels/signal/types";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStoreIfAny: () => null }));
import { SignalSettings, type SignalClient } from "./SignalSettings";
import { SETTINGS_CARDS } from "@/lib/settings-card-registry";

const binding = { connectionId: "fixture", generation: 1, ownAci: "00000000-0000-4000-8000-000000000001", ownDeviceId: 2, linkedAt: 1, chiefBotId: "chief" };
const uncertain: ReviewState = { deliveryId: "a".repeat(64), state: "uncertain", reason: "delivery-unknown", response: "Fixture reply", partial: false };
const linked = (reviews: ReviewState[] = []): ChannelState => ({ state: "linked", binding, maskedNumber: "•••1234", reviews, reviewCount: reviews.length });
let root: Root, container: HTMLDivElement, state: ChannelState, client: SignalClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state = { state: "not-linked" };
  client = { status: vi.fn(async () => state), action: vi.fn(async () => ({ status: state })), open: vi.fn(async () => {}) };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const mount = async (enabled = true) => { await act(async () => root.render(createElement(SignalSettings, { client, enabled }))); };
const button = (name: string) => [...container.querySelectorAll("button")].find(b => b.textContent === name);
const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name)!.click()); };

it("T-NO-SURFACE: the same card is available only with activation; disabled never reads status", async () => {
  await mount(); expect(button("Connect Signal")).toBeTruthy();
  await act(async () => root.render(null)); vi.mocked(client.status).mockClear();
  await mount(false); expect(container.textContent).toBe(""); expect(client.status).not.toHaveBeenCalled();
});
it("T-CLICK: Connect Signal opens the fixture QR in one card click with the current Chief default", async () => {
  vi.mocked(client.action).mockImplementation(async () => ({ status: { state: "linking", uri: "sgnl://fixture-only", expiresAt: Date.now() + 60000 } }));
  await mount(); await click("Connect Signal");
  expect(client.action).toHaveBeenCalledExactlyOnceWith("link", {});
  expect(container.querySelector('svg[aria-label="Scan to connect Signal"]')).toBeTruthy();
  expect(container.textContent).toContain("On your phone: Signal, Settings, Linked devices, +. Then scan this.");
  expect(container.querySelectorAll('[data-primary="true"]').length).toBeLessThanOrEqual(1);
});
it("T-RESEND: Review then Send again preserves the reply and action on full; Leave it is separate", async () => {
  state = linked([uncertain]);
  vi.mocked(client.action).mockResolvedValue({ result: "full", status: state });
  await mount(); expect(container.textContent).not.toContain("Fixture reply"); await click("Review");
  expect(container.textContent).toContain("Fixture reply"); expect(container.textContent).toContain("It may show twice in Signal.");
  await click("Send again");
  expect(container.textContent).toContain("Signal is catching up. Try again in a minute.");
  expect(button("Send again")?.disabled).toBe(false); expect(container.textContent).toContain("Fixture reply");
  expect(client.action).toHaveBeenCalledExactlyOnceWith("resend", { deliveryId: uncertain.deliveryId });
  vi.mocked(client.action).mockResolvedValue({ status: linked() }); await click("Leave it");
  expect(client.action).toHaveBeenLastCalledWith("leave-it", { deliveryId: uncertain.deliveryId });
  expect(container.textContent).not.toContain("Fixture reply");
});
it("T-RL-DEADLINE: only the persisted cooldown changes whether Send again can be clicked", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  state = linked([{ ...uncertain, reason: "rate-limit", resendAfter: 160000 }]);
  await mount(); await click("Review"); expect(button("Send again")?.disabled).toBe(true);
  expect(container.textContent).toContain("Signal was busy, so this reply may not have arrived.");
  await click("Send again"); expect(client.action).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(button("Send again")?.disabled).toBe(false); await click("Send again"); expect(client.action).toHaveBeenCalledOnce();
});
it("T-STUCK: a missing reply offers Open in Murage and Dismiss, never Send again", async () => {
  state = linked([uncertain]); await mount(); await click("Review"); expect(button("Send again")).toBeTruthy();
  await act(async () => root.render(null));
  state = { state: "blocked", reason: "reply-lost", reviews: [{ deliveryId: uncertain.deliveryId, state: "needs-review", reason: "run-receipt-missing", runId: "run" }], reviewCount: 1 };
  await mount(); await click("Review"); expect(button("Send again")).toBeUndefined();
  await click("Open in Murage"); expect(client.open).toHaveBeenCalledWith("open-in-murage", { deliveryId: uncertain.deliveryId });
  await click("Dismiss"); expect(client.action).toHaveBeenCalledWith("dismiss", { deliveryId: uncertain.deliveryId });
});
it("T-REVIEW-COUNT: 150 held replies use the live count and display only one reply at a time", async () => {
  state = linked(Array.from({ length: 149 }, (_, i) => ({ ...uncertain, deliveryId: String(i) })));
  await mount(); expect(container.textContent).not.toContain("replies are waiting for your review in Signal settings.");
  await act(async () => root.render(null));
  state = linked(Array.from({ length: 150 }, (_, i) => ({ ...uncertain, deliveryId: String(i), response: `Reply ${i}` })));
  await mount(); expect(container.textContent).toContain("150 replies are waiting for your review in Signal settings.");
  await click("Review"); expect(container.querySelectorAll("pre")).toHaveLength(1);
  expect(container.querySelectorAll('[data-primary="true"]')).toHaveLength(1);
});
it("T-OWNER-REPAIR: only exposed keys require I removed it before linking, and the repaired card names two devices", async () => {
  state = { state: "blocked", reason: "link-required" }; await mount(); await click("Connect again");
  expect(client.action).toHaveBeenCalledWith("connect-again", {});
  await act(async () => root.render(null)); vi.mocked(client.action).mockClear();
  state = { state: "blocked", reason: "storage-owner", scope: "signal", path: "/fixture/signal" }; await mount(); await click("Connect again");
  expect(client.action).not.toHaveBeenCalled(); expect(container.textContent).toContain("remove Murage");
  vi.mocked(client.action).mockResolvedValue({ status: { ...linked(), repairedStorageOwner: true } as ChannelState });
  await click("I removed it"); expect(client.action).toHaveBeenCalledWith("connect-again", { removedDeviceOnPhone: true });
  expect(container.textContent).toContain("If two Murage devices show on your phone, remove the older one.");
});
it("T-LIMITS: states the accepted Windows limit plainly and confirms Disconnect", async () => {
  state = linked(); await mount();
  expect(container.textContent).toContain("On Windows, a sudden power loss may mean sending your last note again.");
  await click("Disconnect"); expect(client.action).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Murage stops reading and answering in Signal and forgets this link.");
  vi.mocked(client.action).mockResolvedValue({ status: { state: "not-linked", removeDeviceOnPhone: true } });
  await click("Disconnect Signal"); expect(client.action).toHaveBeenCalledExactlyOnceWith("disconnect", {});
  expect(container.textContent).toContain("Also remove Murage under Linked devices in Signal.");
});
it.each([
  ["identity-unavailable", "Connect again", "connect-again"], ["needs-update", "Check for updates", "check-for-updates"],
  ["storage-permissions", "Fix permissions", "fix-permissions"], ["revoke-recovery-required", "Finish disconnecting", "finish-revocation"],
  ["disk-full", "Show folder", "show-folder"], ["storage-slow", "Show folder", "show-folder"],
  ["ledger-write-failed", "Try again", "retry-notes"], ["notes-stuck", "Try again", "retry-notes"],
] as const)("T-RECOVERY: %s names one primary next step", async (reason, label, action) => {
  state = { state: "blocked", reason }; await mount();
  expect(container.querySelectorAll('[data-primary="true"]')).toHaveLength(1); await click(label);
  expect([...(vi.mocked(client.action).mock.calls), ...(vi.mocked(client.open).mock.calls)]).toEqual([[action, {}]]);
});
it("T-OWNER-REPAIR: data-folder scope sends the owner to Storage without relinking", async () => {
  state = { state: "blocked", reason: "storage-owner", scope: "data-dir", path: "/fixture" }; await mount();
  expect(button("Connect again")).toBeUndefined(); await click("Open Storage");
  expect(client.open).toHaveBeenCalledExactlyOnceWith("open-storage", {}); expect(client.action).not.toHaveBeenCalled();
});
it("T-RESEND: a double click while the request is pending sends only once", async () => {
  state = linked([uncertain]); let finish!: (value: { status: ChannelState }) => void;
  vi.mocked(client.action).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await mount(); await click("Review");
  await act(async () => { button("Send again")!.click(); button("Send again")!.click(); });
  expect(client.action).toHaveBeenCalledOnce(); expect(button("Send again")?.disabled).toBe(true);
  await act(async () => finish({ status: linked() })); expect(container.textContent).not.toContain("Fixture reply");
});
it("T-NO-SURFACE: the pending G0 pin contributes neither a card nor a search target", () => {
  expect(SETTINGS_CARDS.some(card => card.id === "channels.signal")).toBe(false);
});

it("T-RECOVERY: a successful status refresh clears the temporary load error", async () => {
  vi.useFakeTimers();
  vi.mocked(client.status).mockRejectedValueOnce(new Error("offline"));
  await mount(); expect(container.textContent).toContain("Signal settings could not be loaded");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(button("Connect Signal")).toBeTruthy();
  expect(container.textContent).not.toContain("Signal settings could not be loaded");
});

it("T-RESEND: background polling preserves the full-ledger feedback and reply", async () => {
  vi.useFakeTimers(); state = linked([uncertain]);
  vi.mocked(client.action).mockResolvedValue({ result: "full", status: state });
  await mount(); await click("Review"); await click("Send again");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).toContain("Signal is catching up. Try again in a minute.");
  expect(container.textContent).toContain("Fixture reply");
  expect(button("Send again")?.disabled).toBe(false);
});

it("T-RECOVERY: Try again clears the load error as soon as status succeeds", async () => {
  vi.mocked(client.status).mockRejectedValueOnce(new Error("offline"));
  await mount(); expect(container.textContent).toContain("Signal settings could not be loaded");
  await click("Try again");
  expect(button("Connect Signal")).toBeTruthy();
  expect(container.textContent).not.toContain("Signal settings could not be loaded");
});

it("T-B8-ACTIVATION: reviewed committed G0 adapters reveal the Settings card", async () => {
  const { g0Frame } = await import("../../server/channels/signal/g0-test-fixtures.ts"); g0Frame("version");
  const modulePath = "../../server/channels/signal/adapters.ts";
  const { loadSignalAdapters } = await import(/* @vite-ignore */ modulePath);
  const { default: pin } = await import("../../server/channels/signal/runtime-pin.json");
  const { resolve } = await import("node:path");
  const adapters = loadSignalAdapters(pin, resolve("server/channels/signal/fixtures/g0"));
  expect(adapters.verified && !!adapters.linkProtocol).toBe(true);
  expect(SETTINGS_CARDS.some(card => card.id === "channels.signal")).toBe(true);
  await act(async () => root.render(createElement(SignalSettings, { client })));
  expect(button("Connect Signal")).toBeTruthy();
});
for(const progress of ['check','busy','adoption','pending','durability'] as const)it(`RED26 custody ${progress} copy and capabilities`,async()=>{
 state={state:'blocked',reason:progress==='busy'?'kept-busy':'kept-check',path:'/fixture/private-path',preservation:{progress,canKeepBoth:progress==='check',canLink:false,dualCopy:false}};
 const exact={check:'Murage paused Signal to keep your connection safe. It could not account for all the Signal files in your data folder. The files it found are still there.',busy:'Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer.',adoption:'Murage cannot check whether an earlier Signal process has stopped on this computer. Your Signal files are kept. Keep Signal paused until Murage can check.',pending:'Murage kept your Signal files and is finishing disconnecting the earlier link here. Open Murage again to finish before linking Signal again.',durability:'Murage cannot confirm this choice is saved on this disk. Your Signal files are kept. Open Murage again before linking Signal.'};
 await mount();expect(container.textContent).toContain(exact[progress]);expect(button('Show folder')).toBeTruthy();expect(button('Connect Signal')).toBeUndefined();expect(button('Disconnect')).toBeUndefined();
 expect(!!button('Keep both and link again')).toBe(progress==='check');
 expect(container.textContent).not.toMatch(/kept-check|kept-busy|private-path|two places|Nothing was removed/);
 if(progress==='adoption')expect(container.textContent).toContain('Keep Signal paused until Murage can check.');
 if(progress==='busy')expect(container.textContent).toContain('If this stays, restart your computer.');
 if(progress==='check'){await click('Keep both and link again');expect(client.action).toHaveBeenCalledWith('keep-both-and-link',{});}
});
it('RED26 verified dual copies and advisory preserve the actual state',async()=>{
 state={state:'blocked',reason:'kept-check',path:'/fixture/data',preservation:{progress:'check',canKeepBoth:true,canLink:false,dualCopy:true}};
 await mount();expect(container.textContent).toContain('It found Signal files in two places and kept both. Nothing was removed.');
 await act(async()=>root.render(null));state={...linked(),kept:{kind:'earlier',folder:'/fixture/data'}};await mount();
 expect(container.textContent).toContain('Connected as');expect(container.textContent).toContain('Murage also kept an earlier Signal link');expect(button('Disconnect')).toBeTruthy();expect(button('Show folder')).toBeTruthy();
});
for(const actual of ['linked','not-linked','blocked'] as const)for(const kind of ['earlier','moved','unreadable'] as const)it(`RED26 actual ${actual} with ${kind} advisory keeps its state and authorized controls`,async()=>{
 state={...(actual==='linked'?linked():actual==='blocked'?{state:'blocked' as const,reason:'link-required' as const}:{state:'not-linked' as const,removeDeviceOnPhone:true}),kept:{kind,folder:'/fixture/hidden-folder'}};
 await mount();expect(button('Show folder')).toBeTruthy();expect(container.textContent).not.toContain('/fixture/hidden-folder');expect(!!button('Disconnect')).toBe(actual==='linked');expect(!!button('Connect Signal')).toBe(actual==='not-linked');expect(!!button('Connect again')).toBe(actual==='blocked');
 expect(container.textContent?.includes('Connected as')).toBe(actual==='linked');
 if(actual==='not-linked'&&kind==='earlier')expect(container.textContent).toContain('Murage kept the earlier Signal files. You can link Signal again. Also remove the older Murage entry under Linked devices in Signal on your phone.');
 if(actual==='not-linked'&&kind==='moved')expect(container.textContent).toContain('Murage kept the earlier Signal files in your data folder. To use Signal here, link it again. Then remove the older Murage entry under Linked devices in Signal on your phone.');
 await click('Show folder');expect(client.open).toHaveBeenCalledWith('show-folder',{});
});
