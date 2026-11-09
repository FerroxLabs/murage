import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardAttentionConfig, forwardAttentionSettled, genericFrame, reportAttentionVisible, resetAttentionOffer, routeNotification, routingPayload, type AttentionBridge, type AttentionMessage } from "./attention-offer";

function fakeBridge(answer: (payload: unknown) => Promise<{ ok: boolean; decision?: string }> = async () => ({ ok: true, decision: "notify" })) {
  let send: ((message: AttentionMessage) => void) | null = null;
  const offers: Array<Record<string, unknown>> = [];
  const visible: unknown[] = [];
  let unsubscribed = 0, subscriptions = 0;
  const bridge: AttentionBridge = {
    offer: (payload) => { offers.push(payload as Record<string, unknown>); return answer(payload); },
    visible: async (payload) => { visible.push(payload); return { ok: true }; },
    onShow: (callback) => { subscriptions += 1; send = callback; return () => { unsubscribed += 1; }; },
  };
  return { bridge, offers, visible, message: (message: AttentionMessage) => send?.(message), show: (ref: string) => send?.({ type: "show", ref }), unsubscribed: () => unsubscribed, subscriptions: () => subscriptions };
}
const frame = { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", title: "Run rm -rf /", body: "secret detail", subtitle: "more secret" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetAttentionOffer());

describe("routeNotification", () => {
  it("shows at once when there is no bridge (a browser tab keeps today's behaviour)", () => {
    const show = vi.fn();
    routeNotification(frame, show, undefined);
    expect(show).toHaveBeenCalledWith(frame);
  });

  it("offers routing ids only and shows nothing until main sends the ref back, once", async () => {
    const f = fakeBridge();
    const show = vi.fn();
    routeNotification(frame, show, f.bridge);
    await tick();
    expect(show).not.toHaveBeenCalled();
    const sent = f.offers[0]!;
    expect(Object.keys(sent).sort()).toEqual(["botId", "kind", "messageId", "ref", "requestId", "threadId"]);
    expect(JSON.stringify(sent)).not.toMatch(/secret|rm -rf/);
    f.show(sent.ref as string);
    f.show(sent.ref as string);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("falls back to showing when the router refuses (undelivered included), rejects or throws", async () => {
    for (const answer of [async () => ({ ok: false }), async () => ({ ok: false, decision: "undelivered" }), async () => { throw new Error("gone"); }]) {
      const f = fakeBridge(answer);
      const show = vi.fn();
      routeNotification(frame, show, f.bridge);
      await tick();
      expect(show).toHaveBeenCalledTimes(1);
      resetAttentionOffer();
    }
    const throwing: AttentionBridge = { offer: () => { throw new Error("disposed"); }, visible: async () => ({}), onShow: () => () => {} };
    const show = vi.fn();
    routeNotification(frame, show, throwing);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("a listener that cannot attach shows at once and is retried by the next offer (never committed)", async () => {
    let attempts = 0, send: ((m: AttentionMessage) => void) | null = null;
    const flaky: AttentionBridge = { offer: async () => ({ ok: true, decision: "notify" }), visible: async () => ({}), onShow: (cb) => { attempts += 1; if (attempts === 1) throw new Error("no"); send = cb; return () => {}; } };
    const first = vi.fn(), second = vi.fn();
    routeNotification(frame, first, flaky);
    expect(first).toHaveBeenCalledTimes(1);
    routeNotification(frame, second, flaky);
    await tick();
    expect(attempts).toBe(2);
    expect(second).not.toHaveBeenCalled();
    expect(send).not.toBeNull();
  });

  it("terminal decisions drop the waiting display; a held one keeps it until main shows it", async () => {
    for (const decision of ["duplicate", "on-screen", "counts", "settled", "stale"]) {
      const f = fakeBridge(async () => ({ ok: true, decision }));
      const show = vi.fn();
      routeNotification(frame, show, f.bridge);
      await tick();
      f.show(f.offers[0]!.ref as string);
      expect(show, decision).not.toHaveBeenCalled();
      resetAttentionOffer();
    }
    const held = fakeBridge(async () => ({ ok: true, decision: "held" }));
    const show = vi.fn();
    routeNotification(frame, show, held.bridge);
    await tick();
    held.show(held.offers[0]!.ref as string);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("a close from main cancels a waiting display and closes a shown one", async () => {
    const f = fakeBridge();
    const closer = vi.fn();
    const waiting = vi.fn(), shownOnce = vi.fn(() => closer);
    routeNotification(frame, waiting, f.bridge);
    routeNotification(frame, shownOnce, f.bridge);
    await tick();
    const [a, b] = f.offers.map((o) => o.ref as string);
    f.message({ type: "close", ref: a! });
    f.show(a!);
    expect(waiting).not.toHaveBeenCalled();
    f.show(b!);
    expect(shownOnce).toHaveBeenCalledTimes(1);
    f.message({ type: "close", ref: b! });
    expect(closer).toHaveBeenCalledTimes(1);
    f.message({ type: "close", ref: b! });
    expect(closer).toHaveBeenCalledTimes(1);
  });

  it("details turned off re-words every waiting display with the allowlisted words; details turned on changes nothing", async () => {
    const f = fakeBridge(async () => ({ ok: true, decision: "held" }));
    const seen: Array<Record<string, unknown>> = [];
    routeNotification({ ...frame, title: "Run rm -rf /", body: "secret detail" }, (shownFrame) => { seen.push(shownFrame); }, f.bridge);
    routeNotification({ kind: "done", threadId: "t2", title: "Ada finished", body: "the report" }, (shownFrame) => { seen.push(shownFrame); }, f.bridge);
    await tick();
    f.message({ type: "previews", previews: true });
    f.message({ type: "previews", previews: false });
    for (const o of f.offers) f.show(o.ref as string);
    expect(seen.map((s) => [s.title, s.body, s.privatePreview])).toEqual([["Murage", "Your attention is needed.", true], ["Murage", "A task has finished.", true]]);
    expect(JSON.stringify(seen)).not.toMatch(/secret|report|rm -rf/);
    expect(genericFrame({ kind: "turn-failed" }).body).toBe("A task needs review after a failure.");
  });

  it("keeps at most 256 waiting displays, oldest dropped, and one listener per bridge", async () => {
    const f = fakeBridge(async () => ({ ok: true, decision: "held" }));
    const runs = Array.from({ length: 258 }, () => vi.fn());
    for (const run of runs) routeNotification(frame, run, f.bridge);
    await tick();
    f.show(f.offers[0]!.ref as string);
    f.show(f.offers[257]!.ref as string);
    expect(runs[0]).not.toHaveBeenCalled();
    expect(runs[257]).toHaveBeenCalledTimes(1);
    expect(f.unsubscribed()).toBe(0);
    expect(f.subscriptions()).toBe(1);
  });
});

describe("routingPayload", () => {
  it("keeps ids and a valid duration, drops everything else", () => {
    expect(routingPayload({ kind: "done", botId: "b", threadId: "t", deliveryId: "d", durationMs: 1200, title: "x", body: "y", receipt: { sent: "z" } }, "ref1")).toEqual({ kind: "done", ref: "ref1", botId: "b", threadId: "t", deliveryId: "d", durationMs: 1200 });
    expect(routingPayload({ kind: "done", durationMs: -4, threadId: 5 }, "r")).toEqual({ kind: "done", ref: "r" });
  });
});

describe("reportAttentionVisible, forwardAttentionSettled and forwardAttentionConfig", () => {
  it("sends only changes", async () => {
    const f = fakeBridge();
    reportAttentionVisible("t1", true, f.bridge);
    reportAttentionVisible("t1", true, f.bridge);
    reportAttentionVisible("t1", false, f.bridge);
    reportAttentionVisible(null, false, f.bridge);
    expect(f.visible).toEqual([{ threadId: "t1", focused: true }, { threadId: "t1", focused: false }, { threadId: null, focused: false }]);
    reportAttentionVisible("t1", true, undefined);
  });

  it("forwards a settle as ids and a config signal as nothing; ignores a malformed settle", () => {
    const f = fakeBridge();
    forwardAttentionSettled({ threadId: "t1", requestId: "r1", extra: 1 } as never, f.bridge);
    forwardAttentionSettled({ threadId: 5, requestId: "r1" }, f.bridge);
    forwardAttentionSettled({ threadId: "t1", requestId: "r1" }, undefined);
    forwardAttentionConfig(f.bridge);
    forwardAttentionConfig(undefined);
    expect(f.offers).toEqual([{ kind: "attention.settled", threadId: "t1", requestId: "r1" }, { kind: "attention.config" }]);
  });
});
