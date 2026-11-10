// FIRSTRUN-1019 slice E, test E3: the What's new request made on the update screen is kept until the renderer acks.
import { describe, expect, it } from "vitest";
import { watchStartupWhatsNew, type StartupWhatsNewBridge } from "./whats-new";

function fakeBridge(initial: boolean) {
  let pending = initial;
  let listener: (() => void) | null = null;
  const bridge: StartupWhatsNewBridge = {
    pendingWhatsNew: async () => pending,
    ackWhatsNew: async () => { pending = false; return true; },
    onWhatsNew: (cb) => { listener = cb; return () => { listener = null; }; },
  };
  return { bridge, press: () => { pending = true; listener?.(); }, isPending: () => pending, hasListener: () => listener !== null };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("E3 What's new from the update screen", () => {
  it("a press before the listener mounts is found by the one pending question on mount", async () => {
    const f = fakeBridge(true);
    let shown = 0;
    watchStartupWhatsNew(f.bridge, { alreadyShown: () => shown > 0, show: () => { shown++; } });
    await tick();
    expect(shown).toBe(1);
    expect(f.isPending()).toBe(false);
  });

  it("a press during the dwell after mount arrives as an event and is shown", async () => {
    const f = fakeBridge(false);
    let shown = 0;
    watchStartupWhatsNew(f.bridge, { alreadyShown: () => shown > 0, show: () => { shown++; } });
    await tick();
    expect(shown).toBe(0);
    f.press();
    await tick();
    expect(shown).toBe(1);
    expect(f.isPending()).toBe(false);
  });

  it("a renderer reload mid-delivery keeps the request: it is acked only after it was shown", async () => {
    const f = fakeBridge(true);
    let acked = false;
    const bridge: StartupWhatsNewBridge = { ...f.bridge, ackWhatsNew: () => { acked = true; return new Promise<boolean>(() => {}); } };
    let shown = 0;
    const stop = watchStartupWhatsNew(bridge, { alreadyShown: () => false, show: () => { shown++; expect(acked).toBe(false); } });
    await tick();
    expect(shown).toBe(1);
    stop(); // the page reloads before the ack comes back
    expect(f.isPending()).toBe(true); // main still holds it for the next load
    let shownAgain = 0;
    watchStartupWhatsNew(f.bridge, { alreadyShown: () => false, show: () => { shownAgain++; } });
    await tick();
    expect(shownAgain).toBe(1);
    expect(f.isPending()).toBe(false);
  });

  it("repeated presses open it once", async () => {
    const f = fakeBridge(false);
    let open = false;
    let opened = 0;
    watchStartupWhatsNew(f.bridge, { alreadyShown: () => open, show: () => { open = true; opened++; } });
    f.press(); f.press(); f.press();
    await tick();
    f.press();
    await tick();
    expect(opened).toBe(1);
  });

  it("is a no-op, but still acks, when the automatic open already showed it", async () => {
    const f = fakeBridge(true);
    let opened = 0;
    watchStartupWhatsNew(f.bridge, { alreadyShown: () => true, show: () => { opened++; } });
    await tick();
    expect(opened).toBe(0);
    expect(f.isPending()).toBe(false);
  });

  it("with no desktop bridge it does nothing and stops cleanly", () => {
    expect(() => watchStartupWhatsNew(undefined, { alreadyShown: () => false, show: () => {} })()).not.toThrow();
  });

  it("acks only after show has resolved, and a press after one delivery never reopens it", async () => {
    const f = fakeBridge(false);
    const order: string[] = [];
    let release: () => void = () => {};
    let shown = 0;
    const bridge: StartupWhatsNewBridge = { ...f.bridge, ackWhatsNew: async () => { order.push("ack"); return f.bridge.ackWhatsNew(); } };
    watchStartupWhatsNew(bridge, { alreadyShown: () => false, show: () => { shown++; order.push("show"); return new Promise<void>((resolve) => { release = () => { order.push("painted"); resolve(); }; }); } });
    f.press();
    await tick();
    expect(order).toEqual(["show"]);
    release();
    await tick();
    expect(order).toEqual(["show", "painted", "ack"]);
    f.press();
    await tick();
    expect(shown).toBe(1);
  });
});
