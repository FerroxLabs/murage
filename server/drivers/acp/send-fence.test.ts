// STOP-FENCE units (design r3 U1, U2): the fence registry and the single fenced writer.
import { describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, createSendFences, fencedWrite, SendStoppedError, type Owner } from "./send-fence.ts";

function make(init: { owner?: (t: string) => Owner | null } = {}) {
  const epochs = new Map<string, number>();
  let disposed = false;
  const fences = createSendFences({ epochOf: t => epochs.get(t) ?? 0, disposed: () => disposed, owner: init.owner ?? (() => null) });
  return { fences, retire: (t: string) => epochs.set(t, (epochs.get(t) ?? 0) + 1), dispose: () => { disposed = true; } };
}

describe("U2 send-fence registry", () => {
  it("end() twice leaves the registry and cleanups unchanged", () => {
    const { fences } = make();
    const f = fences.begin("t", "a", "send");
    const cleanup = vi.fn();
    f.own(cleanup);
    f.end(); f.end(); f.release();
    expect([...fences.threads()]).toEqual([]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("a throw between begin and end leaves nothing pending once end() runs in finally", () => {
    const { fences } = make();
    expect(() => { const f = fences.begin("t", "a", "send"); try { throw new Error("x"); } finally { f.end(); } }).toThrow("x");
    expect([...fences.threads()]).toEqual([]);
  });
  it("own / handOff / end order: handOff drops the cleanups; without it they run at end", () => {
    const { fences } = make();
    const handed = fences.begin("t", "a", "send"), c1 = vi.fn();
    handed.own(c1); handed.handOff(); handed.end();
    expect(c1).not.toHaveBeenCalled();
    const plain = fences.begin("t", "b", "send"), c2 = vi.fn();
    plain.own(c2); plain.end();
    expect(c2).toHaveBeenCalledTimes(1);
  });
  it("two fences on one thread both die on one retire; each compares with its own start epoch", () => {
    const { fences, retire } = make();
    const pre = fences.begin("t", "a", "prewarm");
    const real = fences.begin("t", "b", "send");
    retire("t");
    expect(pre.live()).toBe(false);
    expect(real.live()).toBe(false);
    real.end(); pre.end();
    const later = fences.begin("t", "c", "send");
    expect(later.live()).toBe(true);
    retire("t");
    expect(later.retired()).toBe(true);
  });
  it("dispose kills every fence but is not a stop", () => {
    const { fences, dispose } = make();
    const f = fences.begin("t", "a", "send");
    dispose();
    expect(f.live()).toBe(false);
    expect(f.retired()).toBe(false);
    expect(() => f.check("x")).toThrow(SendStoppedError);
  });
  it("release() frees the thread for the next send before end()", () => {
    const { fences } = make();
    const first = fences.begin("t", "a", "send");
    expect(() => fences.begin("t", "b", "send")).toThrow(BUSY_MESSAGE);
    first.release();
    expect(() => fences.begin("t", "b", "send")).not.toThrow();
  });
  it("admission: a real send is refused by a pending real send and by a non-prewarm owner, and takes a prewarm over", () => {
    let owner: Owner | null = null;
    const { fences } = make({ owner: () => owner });
    const pre = fences.begin("t", "p", "prewarm");
    const real = fences.begin("t", "r", "send");
    expect(real.kind).toBe("send");
    expect(() => fences.begin("t", "r2", "send")).toThrow(BUSY_MESSAGE);
    expect(() => fences.begin("t", "p2", "prewarm")).toThrow(BUSY_MESSAGE);
    real.end(); pre.end();
    owner = { kind: "send" };
    expect(() => fences.begin("t", "r3", "send")).toThrow(BUSY_MESSAGE);
    owner = { kind: "prewarm" };
    expect(() => fences.begin("t", "r4", "send")).not.toThrow();
    expect(() => fences.begin("u", "pw", "prewarm")).toThrow(BUSY_MESSAGE);
  });
  it("cancelPrewarm kills a pending prewarm only, with no epoch move and no release", () => {
    const { fences } = make();
    const real = fences.begin("a", "r", "send");
    expect(fences.cancelPrewarm("a")).toBe(false);
    expect(real.live()).toBe(true);
    const pre = fences.begin("b", "p", "prewarm");
    expect(fences.cancelPrewarm("b")).toBe(true);
    expect(pre.live()).toBe(false);
    expect(pre.retired()).toBe(true);
    expect([...fences.threads()].sort()).toEqual(["a", "b"]);
    pre.handOff();
    const pre2 = fences.begin("c", "p2", "prewarm");
    pre2.handOff();
    expect(fences.cancelPrewarm("c")).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
describe("U0 send-fence.ts loads under node strip-only mode", () => {
  it("has no TypeScript parameter properties or enums (kimi-signin and the verification server load core.ts imports this way)", () => {
    const url = new URL("./send-fence.ts", import.meta.url).href;
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { SendStoppedError, createSendFences } from ${JSON.stringify(url)}; console.log(new SendStoppedError("x").site, typeof createSendFences)`], { windowsHide: true, encoding: "utf8" });
    expect(out.trim()).toBe("x function");
  });
});
describe("U1 fencedWrite", () => {
  const setup = () => { const m = make(); const fence = m.fences.begin("t", "a", "send"); return { ...m, fence, state: { promptSent: false }, write: vi.fn(() => "w"), halt: vi.fn() }; };
  it("a live fence writes; the prompt flips promptSent only after its bytes are handed over", () => {
    const { fence, state, write, halt } = setup();
    const seen: boolean[] = [];
    write.mockImplementation(() => { seen.push(state.promptSent); return "w"; });
    expect(fencedWrite(fence, state, { id: 1, method: "session/prompt" }, write, halt)).toBe("w");
    expect(seen).toEqual([false]);
    expect(state.promptSent).toBe(true);
    expect(halt).not.toHaveBeenCalled();
  });
  it("a dead fence refuses every call before the prompt: halt once, nothing written, promptSent stays false", () => {
    const { fence, retire, state, write, halt } = setup();
    retire("t");
    for (const method of ["initialize", "session/new", "session/load", "session/set_config_option", "session/prompt"]) {
      halt.mockClear();
      expect(() => fencedWrite(fence, state, { id: 1, method }, write, halt), method).toThrow(SendStoppedError);
      expect(halt).toHaveBeenCalledTimes(1);
    }
    expect(write).not.toHaveBeenCalled();
    expect(state.promptSent).toBe(false);
  });
  it("responses and session/cancel pass on a dead fence", () => {
    const { fence, retire, state, write, halt } = setup();
    retire("t");
    fencedWrite(fence, state, { id: 7, result: {} }, write, halt);
    fencedWrite(fence, state, { id: 8, error: { code: -1 } }, write, halt);
    fencedWrite(fence, state, { method: "session/cancel", params: {} }, write, halt);
    expect(write).toHaveBeenCalledTimes(3);
    expect(halt).not.toHaveBeenCalled();
  });
  it("after the prompt is written nothing is checked (post-prompt behaviour is unchanged)", () => {
    const { fence, retire, state, write, halt } = setup();
    fencedWrite(fence, state, { id: 1, method: "session/prompt" }, write, halt);
    retire("t");
    fencedWrite(fence, state, { id: 2, method: "session/set_mode" }, write, halt);
    expect(write).toHaveBeenCalledTimes(2);
    expect(halt).not.toHaveBeenCalled();
  });
});
