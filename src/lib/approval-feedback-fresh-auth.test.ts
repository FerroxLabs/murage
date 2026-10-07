// The controller driven by the real decideWithFreshAuth: the device prompt
// reaches the card, and each ending (success, cancel, error, joined) lands in
// the right state. No component renderer is set up in this repo (no jsdom, no
// testing library), so the controller is what is exercised, as the hooks use it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalDigest } from "../../shared/approval-digest";
import { createDecisionController, type DecisionHooks } from "./approval-feedback";
import { decideWithFreshAuth } from "./fresh-auth";
import { resetNativeShellForTest } from "./native-shell";

const card = { title: "Approval needed", subtitle: "{\"command\":\"ls\"}", tool: "Bash", summary: "ls" };
let n = 0;
const nextId = () => `req-${++n}`;
const challengeError = async (requestId: string) => Object.assign(new Error("Confirm it's you on this phone to allow this."), {
  status: 403,
  body: { code: "fresh_auth", challenge: { v: 1, nonce: "n".repeat(43), digest: await approvalDigest("t1", requestId, card), decision: "allow", expiresAt: 99 } },
});
const native = (approve: (args: unknown) => unknown) => vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["approveWithDevice"] }), approveWithDevice: approve });

afterEach(() => { vi.unstubAllGlobals(); resetNativeShellForTest(); });

/** What PendingApprovalActions does for an Allow, with the same hook wiring. */
function tapAllow(controller: ReturnType<typeof createDecisionController>, requestId: string, post: (extra?: Record<string, unknown>) => Promise<unknown>) {
  let finished!: Promise<void>;
  controller.run("allow", (hooks: DecisionHooks) => {
    finished = decideWithFreshAuth(post, { threadId: "t1", requestId, decision: "allow", card, onDevicePrompt: hooks.devicePrompt }, { onSuccess: hooks.succeed, onError: hooks.settle, showError: () => {} });
    return finished;
  });
  return () => finished;
}

describe("onDevicePrompt through decideWithFreshAuth", () => {
  it("is up while the phone prompt is, then the accepted answer holds the buttons", async () => {
    const id = nextId();
    const controller = createDecisionController(() => {});
    const prompting: boolean[] = [];
    let release!: (v: unknown) => void;
    native(() => new Promise((resolve) => { prompting.push(controller.state.prompting); release = resolve; }));
    const post = vi.fn().mockRejectedValueOnce(await challengeError(id)).mockResolvedValueOnce({ ok: true });
    const done = tapAllow(controller, id, post);
    await vi.waitFor(() => expect(controller.state).toEqual({ busy: "allow", prompting: true, sent: false }));
    release({ signature: "sig" });
    await done();
    expect(prompting).toEqual([true]);
    expect(controller.state).toEqual({ busy: "allow", prompting: false, sent: true });
    expect(post).toHaveBeenCalledTimes(2);
    // no second POST is possible from the same card
    expect(controller.run("allow", vi.fn())).toBe(false);
  });

  it("a Face ID cancel returns the buttons", async () => {
    const id = nextId();
    const controller = createDecisionController(() => {});
    native(async () => { throw new Error("cancelled"); });
    const post = vi.fn().mockRejectedValueOnce(await challengeError(id));
    await tapAllow(controller, id, post)();
    expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
  });

  it("a native error returns the buttons and the prompt line goes away", async () => {
    const id = nextId();
    const controller = createDecisionController(() => {});
    native(async () => { throw new Error("no_key"); });
    const post = vi.fn().mockRejectedValueOnce(await challengeError(id));
    await tapAllow(controller, id, post)();
    expect(controller.state).toEqual({ busy: null, prompting: false, sent: false });
  });

  it("a rejected plain POST returns the buttons", async () => {
    const controller = createDecisionController(() => {});
    await tapAllow(controller, nextId(), vi.fn().mockRejectedValue(new Error("offline")))();
    expect(controller.state.busy).toBeNull();
  });
});

describe("a Deny during an Allow that is waiting on the phone", () => {
  it("goes out immediately and wins the card, whatever the Allow does afterwards", async () => {
    const id = nextId();
    const controller = createDecisionController(() => {});
    let release!: (v: unknown) => void;
    native(() => new Promise((resolve) => { release = resolve; }));
    const allowPost = vi.fn().mockRejectedValueOnce(await challengeError(id)).mockResolvedValueOnce({ ok: true });
    const allowDone = tapAllow(controller, id, allowPost);
    await vi.waitFor(() => expect(controller.state.prompting).toBe(true));
    const denyPost = vi.fn(async () => ({ ok: true }));
    let denyHooks!: DecisionHooks;
    const started = controller.run("deny", (hooks) => { denyHooks = hooks; return denyPost(); }, { preempt: true });
    expect(started).toBe(true);
    expect(denyPost).toHaveBeenCalledTimes(1);
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: false });
    release({ signature: "sig" }); // the phone prompt closes afterwards and the Allow finishes
    await allowDone();
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: false });
    denyHooks.succeed();
    expect(controller.state).toEqual({ busy: "deny", prompting: false, sent: true });
  });
});

describe("joined second Allow", () => {
  it("settles its own card when the first ends", async () => {
    const id = nextId();
    const first = createDecisionController(() => {});
    const second = createDecisionController(() => {});
    let release!: (v: unknown) => void;
    native(() => new Promise((resolve) => { release = resolve; }));
    const post = vi.fn().mockRejectedValueOnce(await challengeError(id)).mockResolvedValueOnce({ ok: true });
    const a = tapAllow(first, id, post);
    await vi.waitFor(() => expect(first.state.prompting).toBe(true));
    const b = tapAllow(second, id, post);
    expect(second.state.busy).toBe("allow");
    release({ signature: "sig" });
    await Promise.all([a(), b()]);
    expect(first.state.sent).toBe(true);
    expect(second.state.sent).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
