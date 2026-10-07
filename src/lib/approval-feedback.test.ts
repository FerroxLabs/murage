// Every approval button answers the tap at once: a pressed look, a working
// state until the decision settles, the other buttons held, and a guarded buzz.
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ has: vi.fn(() => false), call: vi.fn(async () => true) }));
vi.mock("@/lib/native-shell", () => ({ nativeHas: native.has, callNative: native.call }));

const { createDecisionController, tapHaptic, DECISION_WATCHDOG_MS } = await import("./approval-feedback");
const { approvalButtonProps, isHeld } = await import("@/components/ApprovalFeedback");

type Hooks = { devicePrompt(up: boolean): void; settle(): void; succeed(): void; live(): boolean };

function setup() {
  const seen: Array<{ busy: string | null; prompting: boolean; sent: boolean }> = [];
  const controller = createDecisionController((state) => seen.push(state));
  return { controller, seen };
}

describe("decision controller", () => {
  it("puts the card in the busy state the moment a button is tapped", () => {
    const { controller, seen } = setup();
    const start = vi.fn();
    expect(controller.run("allow", start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.state).toEqual({ busy: "allow", prompting: false, sent: false });
    expect(seen.at(-1)).toEqual({ busy: "allow", prompting: false, sent: false });
  });

  it("ignores a second tap on any button while a decision is in flight", () => {
    const { controller } = setup();
    const start = vi.fn();
    const second = vi.fn();
    controller.run("allow", start);
    expect(controller.run("allow", second)).toBe(false);
    expect(controller.run("deny", second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    expect(controller.state.busy).toBe("allow");
  });

  it("says the device prompt is up, and stops saying it when it closes", () => {
    const { controller } = setup();
    let hooks!: Hooks;
    controller.run("allow", (h) => { hooks = h; });
    hooks.devicePrompt(true);
    expect(controller.state).toEqual({ busy: "allow", prompting: true, sent: false });
    hooks.devicePrompt(false);
    expect(controller.state).toEqual({ busy: "allow", prompting: false, sent: false });
  });

  it("returns the buttons to normal when the decision settles (success, refusal, cancel, error)", () => {
    const { controller } = setup();
    let hooks!: Hooks;
    controller.run("deny", (h) => { hooks = h; });
    hooks.devicePrompt(true);
    hooks.settle();
    expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
    const again = vi.fn();
    expect(controller.run("allow", again)).toBe(true);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("settles when the decision rejects or throws, so the buttons never stay dead", async () => {
    const { controller } = setup();
    controller.run("allow", () => Promise.reject(new Error("offline")));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state.busy).toBeNull();
    expect(() => controller.run("allow", () => { throw new Error("boom"); })).not.toThrow();
    expect(controller.state.busy).toBeNull();
  });

  it("settles once and a late device-prompt report cannot revive the busy state", () => {
    const { controller } = setup();
    let hooks!: Hooks;
    controller.run("allow", (h) => { hooks = h; });
    hooks.settle();
    hooks.devicePrompt(true);
    hooks.settle();
    expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
  });
});

const grab = (controller: ReturnType<typeof setup>["controller"], choice: string, options?: { preempt?: boolean; watchdogMs?: number }) => {
  let hooks!: Hooks;
  const ok = controller.run(choice, (h) => { hooks = h; }, options);
  return { ok, hooks };
};

describe("a Deny is never held by an Allow in flight", () => {
  it("goes out at once, takes over the card, and the Allow's late hooks cannot change it", () => {
    const { controller } = setup();
    const allow = grab(controller, "allow");
    allow.hooks.devicePrompt(true);
    const deny = grab(controller, "deny", { preempt: true });
    expect(deny.ok).toBe(true);
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: false });
    // the Allow ends late: neither its prompt close, its failure nor its success may repaint the card
    allow.hooks.devicePrompt(false);
    allow.hooks.settle();
    allow.hooks.succeed();
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: false });
    deny.hooks.succeed();
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: true });
  });

  it("live() is false for a pre-empted Allow, so its late error text is never shown on the Inbox card", () => {
    const { controller } = setup();
    const allow = grab(controller, "allow");
    expect(allow.hooks.live()).toBe(true);
    const deny = grab(controller, "deny", { preempt: true });
    expect(allow.hooks.live()).toBe(false);
    expect(deny.hooks.live()).toBe(true);
    // the Allow's late success, error and status callbacks are all dropped
    allow.hooks.devicePrompt(true);
    allow.hooks.settle();
    allow.hooks.succeed();
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: false });
  });

  it("a browser-card answer that resolves holds the buttons until the card goes away (then(succeed, settle))", async () => {
    const { controller } = setup();
    let resolve!: () => void;
    const answered = new Promise<void>((r) => { resolve = r; });
    controller.run("allow", ({ settle, succeed }) => answered.then(succeed, settle));
    resolve();
    await answered;
    await Promise.resolve();
    expect(controller.state).toEqual({ busy: "allow", prompting: false, sent: true });
    expect(isHeld(controller.state, "allow")).toBe(true);
    expect(isHeld(controller.state, "deny", true)).toBe(true);
    expect(controller.run("deny", () => {}, { preempt: true })).toBe(false);
  });

  it("a browser-card answer that rejects brings the buttons back", async () => {
    const { controller } = setup();
    controller.run("allow", ({ settle, succeed }) => Promise.reject(new Error("lost")).then(succeed, settle));
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
  });

  it("a second Deny while a Deny is in flight is ignored, and a non-preempting tap never pre-empts", () => {
    const { controller } = setup();
    grab(controller, "allow");
    expect(grab(controller, "task").ok).toBe(false);
    expect(grab(controller, "deny").ok).toBe(false);
    const deny = grab(controller, "deny", { preempt: true });
    expect(deny.ok).toBe(true);
    expect(grab(controller, "deny", { preempt: true }).ok).toBe(false);
  });

  it("the buttons: Deny stays live during an Allow, Allow buttons are held, the tapped one is not dimmed", () => {
    const hold = { busy: "allow", sent: false };
    expect(isHeld(hold, "deny", true)).toBe(false);
    expect(isHeld(hold, "task")).toBe(true);
    expect(approvalButtonProps(hold, "deny", true)["aria-disabled"]).toBeUndefined();
    expect(approvalButtonProps(hold, "task")).toMatchObject({ "aria-disabled": true, className: expect.stringContaining("opacity-50") });
    const tapped = approvalButtonProps(hold, "allow");
    expect(tapped["aria-disabled"]).toBe(true);
    expect(tapped["aria-busy"]).toBe(true);
    expect(tapped.className).not.toContain("opacity");
    // after an accepted answer nothing is live, Deny included
    expect(isHeld({ busy: "allow", sent: true }, "deny", true)).toBe(true);
  });
});

describe("after an accepted answer", () => {
  it("no second answer can start, whichever button, until the controller is replaced", () => {
    const { controller } = setup();
    const first = grab(controller, "allow");
    first.hooks.succeed();
    expect(controller.state).toEqual({ busy: "allow", prompting: false, sent: true });
    const post = vi.fn();
    expect(controller.run("allow", post)).toBe(false);
    expect(controller.run("deny", post, { preempt: true })).toBe(false);
    first.hooks.settle(); // a stray settle does not reopen the buttons
    expect(controller.state.sent).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("a controller for the next request starts idle (the card is keyed by requestId)", () => {
    const a = setup().controller;
    grab(a, "allow").hooks.succeed();
    const b = setup().controller;
    expect(b.state).toEqual({ busy: null, prompting: false, sent: false });
    expect(b.run("allow", vi.fn())).toBe(true);
  });
});

describe("watchdog", () => {
  it("settles an answer that neither succeeds nor fails", () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup();
      grab(controller, "allow");
      vi.advanceTimersByTime(DECISION_WATCHDOG_MS - 1);
      expect(controller.state.busy).toBe("allow");
      vi.advanceTimersByTime(1);
      expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is paused while the device prompt is up and restarts when it closes", () => {
    vi.useFakeTimers();
    try {
      const { controller } = setup();
      const { hooks } = grab(controller, "allow");
      hooks.devicePrompt(true);
      vi.advanceTimersByTime(DECISION_WATCHDOG_MS * 5);
      expect(controller.state).toEqual({ busy: "allow", prompting: true, sent: false });
      hooks.devicePrompt(false);
      vi.advanceTimersByTime(DECISION_WATCHDOG_MS - 1);
      expect(controller.state.busy).toBe("allow");
      vi.advanceTimersByTime(1);
      expect(controller.state.busy).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is cleared by success, by settle and by dispose, and honours a custom bound", () => {
    vi.useFakeTimers();
    try {
      const a = setup().controller;
      grab(a, "allow").hooks.succeed();
      expect(vi.getTimerCount()).toBe(0);
      const b = setup().controller;
      grab(b, "allow").hooks.settle();
      expect(vi.getTimerCount()).toBe(0);
      const c = setup();
      const run = grab(c.controller, "allow", { watchdogMs: 8000 });
      expect(vi.getTimerCount()).toBe(1);
      c.controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
      const before = c.seen.length;
      run.hooks.settle();
      expect(c.seen.length).toBe(before);
      const d = setup().controller;
      grab(d, "allow", { watchdogMs: 8000 });
      vi.advanceTimersByTime(8000);
      expect(d.state.busy).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tap haptic", () => {
  it("uses the shell's haptic method when the phone shell lists it", () => {
    native.has.mockReturnValue(true);
    native.call.mockClear();
    tapHaptic();
    expect(native.call).toHaveBeenCalledWith("haptic", "tap");
  });

  it("falls back to navigator.vibrate(10) when the shell has no haptic method", () => {
    native.has.mockReturnValue(false);
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    tapHaptic();
    expect(vibrate).toHaveBeenCalledWith(10);
    vi.unstubAllGlobals();
  });

  it("never throws: no vibrate, a throwing vibrate, or a rejecting shell call", async () => {
    native.has.mockReturnValue(false);
    vi.stubGlobal("navigator", {});
    expect(() => tapHaptic()).not.toThrow();
    vi.stubGlobal("navigator", { vibrate: () => { throw new Error("blocked"); } });
    expect(() => tapHaptic()).not.toThrow();
    native.has.mockReturnValue(true);
    native.call.mockRejectedValueOnce(new Error("native-unavailable"));
    expect(() => tapHaptic()).not.toThrow();
    await Promise.resolve();
    native.has.mockImplementation(() => { throw new Error("no bridge"); });
    expect(() => tapHaptic()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
