// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardAttentionConfig, forwardAttentionSettled, genericFrame, reportAttentionVisible, resetAttentionOffer, routeNotification, routingPayload, type AttentionBridge, type AttentionMessage } from "./attention-offer";

type Reply = Awaited<ReturnType<AttentionBridge["offer"]>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fakeBridge(answer: (payload: Record<string, unknown>) => Promise<Reply> = async () => ({ ok: true, decision: "held", retired: [] })) {
  let send: ((message: AttentionMessage) => void) | undefined;
  const order: string[] = [];
  const hello = vi.fn(async (_payload: { session: string }) => {
    order.push("hello");
    return { ok: true as const, ledgerMax: 288, retired: [] as string[] };
  });
  const offer = vi.fn((payload: unknown) => answer(payload as Record<string, unknown>));
  const present = vi.fn(async (_payload: unknown) => ({ ok: true as const, kept: true, retired: [] as string[] }));
  const gone = vi.fn(async (_payload: unknown) => ({ ok: true, retired: [] as string[] }));
  const freed = vi.fn((_payload: { session: string; refs: string[] }) => {});
  const visible = vi.fn(async (_payload: unknown) => ({ ok: true, retired: [] as string[] }));
  const off = vi.fn();
  const onShow = vi.fn((callback: (message: AttentionMessage) => void) => { order.push("subscribe"); send = callback; return off; });
  const bridge: AttentionBridge = { hello, offer, present, gone, freed, visible, onShow };
  const session = () => hello.mock.calls[0]?.[0].session ?? "legacy-session";
  const ref = (index = 0) => (offer.mock.calls[index]![0] as { ref: string }).ref;
  const message = (value: AttentionMessage) => send?.(value);
  return { bridge, hello, offer, present, gone, freed, visible, onShow, off, order, session, ref, message,
    show: (value = ref(), gen = 1, previews = true) => message({ type: "show", session: session(), ref: value, gen, previews }),
    close: (value = ref(), gen = 1) => message({ type: "close", session: session(), ref: value, gen }),
  };
}
const frame = { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", title: "Review command", body: "private detail", subtitle: "more detail" };
const display = vi.fn((value: Record<string, unknown>) => ({
  title: String(value.title), body: String(value.body), botId: String(value.botId ?? ""), threadId: String(value.threadId ?? ""),
  privatePreview: value.privatePreview === true, silent: false,
}));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
afterEach(() => { resetAttentionOffer(); display.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("S3R renderer obligations", () => {
  // On cc2f these call the existing routeNotification; the extra fake bridge methods are inert.
  // Failures are behavioral call counts/fields/order, not missing exports.
  it("O1 hands display fields to present without a renderer notice", async () => {
    const Notification = vi.fn(); vi.stubGlobal("Notification", Notification);
    const f = fakeBridge();
    routeNotification(frame, display, f.bridge);
    await tick();
    expect(display).not.toHaveBeenCalled();
    expect(f.order).toEqual(["subscribe", "hello"]);
    expect(f.offer.mock.calls[0]![0]).toEqual({ kind: frame.kind, session: f.session(), ref: f.ref(), botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1" });
    f.show(); await tick();
    expect(f.present).toHaveBeenCalledWith({ session: f.session(), ref: f.ref(), gen: 1, title: frame.title, body: frame.body, botId: "b1", threadId: "t1", privatePreview: false, silent: false });
    expect(Notification).not.toHaveBeenCalled();
  });
  it("O2 retains the first of 300 waiting payloads within offer credit", async () => {
    const f = fakeBridge();
    for (let index = 0; index < 300; index += 1) {
      routeNotification({ ...frame, requestId: `r${index}` }, display, f.bridge);
      await tick();
    }
    expect(f.offer).toHaveBeenCalledTimes(300);
    f.show(f.ref(0)); await tick();
    expect(f.present).toHaveBeenCalledOnce();
    expect(f.present.mock.calls[0]![0]).toMatchObject({ ref: f.ref(0), title: frame.title });
  });
  it("O3 retries a rejected offer once with its ref; no decision self-displays", async () => {
    const f = fakeBridge(async () => { throw new Error("reply lost"); });
    routeNotification(frame, display, f.bridge); await tick();
    expect(f.offer).toHaveBeenCalledTimes(2);
    expect(f.ref(1)).toBe(f.ref(0));
    expect(display).not.toHaveBeenCalled();
    for (const decision of ["overflow", "duplicate", "counts", "notify", "plain", "held", "on-screen", "settled", "stale"]) {
      resetAttentionOffer();
      const other = fakeBridge(async () => ({ ok: true, decision, retired: [] }));
      routeNotification(frame, display, other.bridge); await tick();
      expect(display).not.toHaveBeenCalled();
      other.show(); await tick();
      expect(other.present).toHaveBeenCalledOnce();
      display.mockClear();
    }
  });
  it("O4 ignores foreign sessions and answers each generation once", async () => {
    const f = fakeBridge();
    routeNotification(frame, display, f.bridge); await tick();
    f.message({ type: "show", session: "another-document", ref: f.ref(), gen: 1, previews: true });
    f.message({ type: "close", session: "another-document", ref: f.ref(), gen: 1 });
    f.message({ type: "previews", session: "another-document", previews: false });
    expect(display).not.toHaveBeenCalled();
    expect(f.freed).not.toHaveBeenCalled();
    f.show(); f.show(); await tick(); f.show();
    expect(f.present).toHaveBeenCalledOnce();
    expect(f.present.mock.calls[0]![0]).toMatchObject({ title: frame.title });
    f.show(f.ref(), 2);
    expect(f.present).toHaveBeenCalledTimes(2);
  });
  it("O5 limits outstanding offers to 32 and batches retired acknowledgements", async () => {
    const replies: ReturnType<typeof deferred<Reply>>[] = [];
    const f = fakeBridge(() => { const reply = deferred<Reply>(); replies.push(reply); return reply.promise; });
    for (let index = 0; index < 40; index += 1) routeNotification(frame, display, f.bridge);
    await tick();
    expect(f.offer).toHaveBeenCalledTimes(32);
    const refs = [f.ref(0), f.ref(1), f.ref(2)];
    replies[0]!.resolve({ ok: true, decision: "held", retired: refs }); await tick();
    expect(f.freed).toHaveBeenCalledOnce();
    expect(f.freed).toHaveBeenCalledWith({ session: f.session(), refs });
    expect(f.offer).toHaveBeenCalledTimes(33); // Two retired invokes still await replies.
    f.show(refs[0]);
    expect(f.gone).toHaveBeenCalledWith({ session: f.session(), ref: refs[0], gen: 1 });
    expect(display).not.toHaveBeenCalled();
  });
  it("O6 reports an unknown show with gone and acknowledges an unknown close", async () => {
    const f = fakeBridge();
    routeNotification(frame, display, f.bridge); await tick();
    f.show("unknown", 27);
    expect(f.gone).toHaveBeenCalledWith({ session: f.session(), ref: "unknown", gen: 27 });
    f.close("unknown", 29); await tick();
    expect(f.freed).toHaveBeenCalledWith({ session: f.session(), refs: ["unknown"] });
    expect(display).not.toHaveBeenCalled();
  });
  it("O7 retains rejected credit, resends after a successful invoke, and drops refused payloads", async () => {
    let recovering = false;
    const resumed: ReturnType<typeof deferred<Reply>>[] = [];
    const f = fakeBridge(async () => {
      if (!recovering) throw new Error("offline");
      const reply = deferred<Reply>(); resumed.push(reply); return reply.promise;
    });
    for (let index = 0; index < 40; index += 1) routeNotification(frame, display, f.bridge);
    await tick();
    expect(f.offer).toHaveBeenCalledTimes(64);
    const refs = new Set(f.offer.mock.calls.map(([payload]) => (payload as { ref: string }).ref));
    expect(refs.size).toBe(32);
    expect(display).not.toHaveBeenCalled();
    recovering = true;
    reportAttentionVisible("t1", true, f.bridge); await tick();
    expect(resumed).toHaveLength(32);
    expect(new Set(f.offer.mock.calls.map(([payload]) => (payload as { ref: string }).ref))).toEqual(refs);
    const rejectedRef = (f.offer.mock.calls[64]![0] as { ref: string }).ref;
    resumed[0]!.resolve({ ok: false }); await tick();
    expect(resumed).toHaveLength(33);
    expect(f.freed).toHaveBeenCalledWith({ session: f.session(), refs: [rejectedRef] });
    f.show(rejectedRef);
    expect(f.gone).toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });
  it("O8 retains a rejected present, then obeys close and retired replay", async () => {
    const f = fakeBridge(); f.present.mockRejectedValue(new Error("commit reply lost"));
    routeNotification(frame, display, f.bridge);
    routeNotification(frame, display, f.bridge); await tick();
    f.show(f.ref(0)); await tick();
    expect(f.present).toHaveBeenCalledOnce();
    expect(f.freed).not.toHaveBeenCalled();
    f.show(f.ref(0)); expect(f.present).toHaveBeenCalledOnce();
    f.close(f.ref(0)); await tick();
    expect(f.freed).toHaveBeenCalledTimes(1);
    expect(f.freed.mock.calls[0]![0].refs).toEqual([f.ref(0)]);
    f.visible.mockResolvedValueOnce({ ok: true, retired: [f.ref(1)] });
    reportAttentionVisible("t2", true, f.bridge); await tick();
    expect(f.freed.mock.calls[1]![0].refs).toEqual([f.ref(1)]);
    f.close(f.ref(0)); await tick();
    expect(f.freed.mock.calls[2]![0].refs).toEqual([f.ref(0)]);
    f.show(f.ref(1), 2); expect(f.gone).toHaveBeenCalled();
    expect(display).toHaveBeenCalledOnce();
  });
  it("O9 re-subscribes with the document nonce and reload mints another", async () => {
    const f = fakeBridge();
    routeNotification(frame, display, f.bridge); await tick();
    const nonce = f.session();
    expect(f.hello).toHaveBeenCalledOnce();
    expect(nonce).toMatch(/^[a-z0-9]{25}$/);
    const replacement = fakeBridge();
    replacement.hello.mockImplementationOnce(async () => {
      replacement.order.push("hello");
      return { ok: true, ledgerMax: 288, retired: [f.ref()] };
    });
    routeNotification(frame, display, replacement.bridge); await tick();
    expect(f.off).toHaveBeenCalledOnce();
    expect(replacement.order).toEqual(["subscribe", "hello"]);
    expect(replacement.session()).toBe(nonce);
    expect(replacement.freed).toHaveBeenCalledWith({ session: nonce, refs: [f.ref()] });
    vi.resetModules();
    const reloaded = await import("./attention-offer");
    const next = fakeBridge(); reloaded.routeNotification(frame, display, next.bridge); await tick();
    expect(next.session()).not.toBe(nonce);
    reloaded.resetAttentionOffer();
  });
});

describe("payload lifecycle and compatibility", () => {
  it("uses the existing display only without an attention bridge", () => {
    routeNotification(frame, display, undefined); expect(display).toHaveBeenCalledWith(frame);
  });
  it("ignores an answered generation even after its payload was released", async () => {
    const f = fakeBridge();
    f.present.mockResolvedValue({ ok: true, kept: false, retired: [] });
    routeNotification(frame, display, f.bridge); await tick();
    f.show(); await tick(); f.show();
    expect(f.present).toHaveBeenCalledOnce();
    expect(f.gone).not.toHaveBeenCalled();
    f.show("missing", 2); await tick(); f.show("missing", 2);
    expect(f.gone).toHaveBeenCalledOnce();
  });
  it("retains an offer across synchronous invoke throws", async () => {
    const f = fakeBridge(() => { throw new Error("disposed"); });
    routeNotification(frame, display, f.bridge); await tick();
    expect(f.offer).toHaveBeenCalledTimes(2);
    expect(display).not.toHaveBeenCalled();
    expect(f.freed).not.toHaveBeenCalled();
  });
  it("retries subscription failure without self-display or an early hello", async () => {
    const f = fakeBridge();
    f.onShow.mockImplementationOnce(() => { throw new Error("listener unavailable"); });
    routeNotification(frame, display, f.bridge);
    expect(f.hello).not.toHaveBeenCalled(); expect(f.offer).not.toHaveBeenCalled(); expect(display).not.toHaveBeenCalled();
    routeNotification(frame, display, f.bridge); await tick();
    expect(f.onShow).toHaveBeenCalledTimes(2); expect(f.offer).toHaveBeenCalledTimes(2);
  });
  it("re-words held payloads and previews:false shows with an allowlist", async () => {
    const f = fakeBridge(); routeNotification(frame, display, f.bridge); await tick();
    f.show(f.ref(), 1, false); await tick();
    expect(f.present.mock.calls[0]![0]).toMatchObject({ title: "Murage", body: "Your attention is needed.", privatePreview: true });
    f.message({ type: "previews", session: f.session(), previews: false });
    f.message({ type: "previews", session: f.session(), previews: true });
    f.show(f.ref(), 2);
    expect(f.present.mock.calls[1]![0]).toMatchObject({ title: "Murage", body: "Your attention is needed.", privatePreview: true });
    expect(genericFrame({ kind: "turn-failed", subtitle: "detail" })).toEqual({ kind: "turn-failed", title: "Murage", body: "A task needs review after a failure.", botName: "", privatePreview: true });
  });
  it.each([{ ok: true as const, kept: false, retired: [] }, { ok: false as const, stale: true as const, retired: [] }, { ok: false as const }])("drops a terminal present reply %j", async (reply) => {
    const f = fakeBridge(); f.bridge.present = vi.fn(async () => reply);
    routeNotification(frame, display, f.bridge); await tick(); f.show(); await tick();
    expect(f.freed).toHaveBeenCalledWith({ session: f.session(), refs: [f.ref()] });
    f.show(f.ref(), 2); expect(f.gone).toHaveBeenCalled();
  });
  it("drops only the oldest never-offered frames at the 64-frame queue limit", async () => {
    const replies: ReturnType<typeof deferred<Reply>>[] = [];
    const f = fakeBridge(() => { const reply = deferred<Reply>(); replies.push(reply); return reply.promise; });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    routeNotification(frame, display, f.bridge); await tick();
    for (let index = 1; index < 100; index += 1) routeNotification({ ...frame, requestId: `r${index}` }, display, f.bridge);
    expect(f.offer).toHaveBeenCalledTimes(32); expect(log).toHaveBeenCalledTimes(4);
    replies[0]!.resolve({ ok: true, decision: "held", retired: [] }); await tick();
    expect(f.offer.mock.calls[32]![0]).toMatchObject({ requestId: "r36" });
    f.show(f.ref()); expect(f.present).toHaveBeenCalledOnce();
  });
  it("sends changed visibility and contentless controls with the session", async () => {
    const f = fakeBridge();
    reportAttentionVisible("t1", true, f.bridge); reportAttentionVisible("t1", true, f.bridge); reportAttentionVisible(null, false, f.bridge);
    forwardAttentionSettled({ threadId: "t1", requestId: "r1" }, f.bridge);
    forwardAttentionSettled({ threadId: 5, requestId: "r1" }, f.bridge);
    forwardAttentionConfig(f.bridge); await tick();
    expect(f.visible.mock.calls.map(([payload]) => payload)).toEqual([{ session: f.session(), threadId: "t1", focused: true }, { session: f.session(), threadId: null, focused: false }]);
    expect(f.offer.mock.calls.map(([payload]) => payload)).toEqual([{ session: f.session(), kind: "attention.settled", threadId: "t1", requestId: "r1" }, { session: f.session(), kind: "attention.config" }]);
  });
  it("keeps only routing ids and valid durations", () => {
    expect(routingPayload({ kind: "done", botId: "b", durationMs: 1200, title: "detail" }, "r")).toEqual({ kind: "done", ref: "r", botId: "b", durationMs: 1200 });
    expect(routingPayload({ kind: "done", durationMs: -1, threadId: 5 }, "r")).toEqual({ kind: "done", ref: "r" });
  });
});
