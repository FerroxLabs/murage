import { describe, expect, it, vi } from "vitest";
import { HOST_SESSION_IDLE_MS, HostComputerBroker, hostComputerSession } from "./host-computer-broker.ts";

const spec = { command: "fake-driver", args: ["mcp"], env: {} };
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("host computer operation admission", () => {
  it("completes the native MCP handshake before forwarding a tool call", async () => {
    const methods: string[] = [];
    const broker = new HostComputerBroker(() => ({
      request: async method => { methods.push(method); return {}; },
      notify: async method => { methods.push(method); }, close: async () => {},
    }));
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });
  it("excludes another bot only until the matching operation and child cleanup settle", async () => {
    const action = deferred(); const closed = deferred<void>();
    const request = vi.fn(async (method: string) => method === "initialize" ? {} : action.promise);
    const start = vi.fn(() => ({ request, close: () => closed.promise }));
    const broker = new HostComputerBroker(start);
    const first = broker.dispatch(spec, "tools/call", { name: "click" }, () => true);
    await Promise.resolve();
    expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).toThrow("in progress");
    expect(start).toHaveBeenCalledTimes(1);
    action.resolve({ content: [] }); await Promise.resolve(); await Promise.resolve();
    expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).toThrow("in progress");
    closed.resolve(); await first;
    await broker.dispatch(spec, "tools/call", { name: "type" }, () => true);
    expect(start).toHaveBeenCalledTimes(2);
  });
  it("rejects stale or human-held authority before spawn and after initialization", async () => {
    const initialized = deferred(); let active = true;
    const request = vi.fn(async () => initialized.promise);
    const start = vi.fn(() => ({ request, close: async () => {} }));
    const broker = new HostComputerBroker(start);
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => false)).toThrow("control changed");
    expect(start).not.toHaveBeenCalled();
    const call = broker.dispatch(spec, "tools/call", { name: "click" }, () => active);
    active = false; initialized.resolve({});
    await expect(call).rejects.toThrow("control changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("discards an observation revoked during child cleanup", async () => {
    const closed = deferred<void>(); let active = true;
    const broker = new HostComputerBroker(() => ({ request: async () => ({ secret: "fake" }), close: () => closed.promise }));
    const call = broker.dispatch(spec, "tools/call", { name: "screenshot" }, () => active);
    await Promise.resolve(); await Promise.resolve(); active = false; closed.resolve();
    await expect(call).rejects.toThrow("control changed");
  });
  it("retains exclusion after transport loss because proxy close does not prove the daemon action stopped", async () => {
    const action = deferred(); const closed = deferred<void>();
    const broker = new HostComputerBroker(() => ({ request: async method => method === "initialize" ? {} : action.promise, close: () => closed.promise }));
    const call = broker.dispatch(spec, "tools/call", { name: "click" }, () => true);
    const failed = expect(call).rejects.toThrow("transport failed");
    action.reject(new Error("transport failed")); await Promise.resolve(); await Promise.resolve();
    expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).toThrow("in progress");
    closed.resolve(); await failed;
    expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).toThrow("in progress");
    await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
  });
  it("does not recycle ownership when child cleanup itself fails", async () => {
    const broker = new HostComputerBroker(() => ({ request: async () => ({}), close: async () => { throw new Error("close unconfirmed"); } }));
    await expect(broker.dispatch(spec, "tools/call", { name: "click" }, () => true)).rejects.toThrow("close unconfirmed");
    expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).toThrow("in progress");
    await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
  });
  it("settles an in-flight action as cancelled when stopped, withdraws it, and stays exclusive until the driver answers", async () => {
    const action = deferred(); const closed = deferred<void>();
    const signals: Array<AbortSignal | undefined> = [];
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (method === "initialize") return {};
      signals.push(options?.signal); return action.promise;
    });
    const broker = new HostComputerBroker(() => ({ request, close: () => closed.promise }));
    const stop = new AbortController();
    const call = broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, stop.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    stop.abort();
    // The request's own signal fires, which is what sends the driver its
    // cancel notification; the caller is answered without waiting.
    expect(signals[0]?.aborted).toBe(true);
    await expect(call).rejects.toMatchObject({ status: 409, code: "cancelled", message: expect.stringMatching(/may still have taken effect/) });
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true)).toThrow("in progress");
    action.resolve({ content: [] }); closed.resolve();
    await vi.waitFor(() => expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true)).not.toThrow());
  });
  it("never sends an action stopped before it reached the driver", async () => {
    const initialized = deferred();
    const request = vi.fn(async (method: string) => method === "initialize" ? initialized.promise : {});
    const broker = new HostComputerBroker(() => ({ request, close: async () => {} }));
    const stop = new AbortController();
    const call = broker.dispatch(spec, "tools/call", { name: "click" }, () => true, stop.signal);
    stop.abort();
    await expect(call).rejects.toMatchObject({ code: "cancelled", message: expect.stringMatching(/nothing was performed/) });
    initialized.resolve({});
    await vi.waitFor(() => expect(() => broker.dispatch(spec, "tools/call", { name: "type" }, () => true)).not.toThrow());
    expect(request.mock.calls.map(([method]) => method)).not.toContain("tools/call");
  });
});

// cua-driver 0.55.0 refuses a pixel action on a window its MCP connection has
// not read (get_window_state), so a turn's read and its next click must reach
// the same driver child. These run the broker's real session bookkeeping
// against fake children that count spawns, handshakes and closes.
describe("host computer turn sessions", () => {
  const turn = (bot: string, revision = 0, thread = `thread-${bot}`, generation = "gen-1") => hostComputerSession(bot, thread, generation, revision);
  function children() {
    const spawned: Array<{ methods: string[]; closed: boolean; dead: boolean; diesOnCall?: boolean }> = [];
    const start = vi.fn(() => {
      const child: { methods: string[]; closed: boolean; dead: boolean; diesOnCall?: boolean } = { methods: [], closed: false, dead: false };
      spawned.push(child);
      return {
        request: async (method: string, params?: Record<string, unknown>) => {
          if (child.dead) throw new Error("transport failed");
          if (child.diesOnCall && method === "tools/call") { child.dead = true; throw new Error("transport failed"); }
          child.methods.push(method === "tools/call" ? `call:${String(params?.name)}` : method);
          return { content: [] };
        },
        notify: async () => {}, close: async () => { child.closed = true; }, ended: () => child.dead,
      };
    });
    return { spawned, start };
  }
  it("runs a turn's get_window_state and the following click on one driver connection", async () => {
    const { spawned, start } = children();
    const broker = new HostComputerBroker(start);
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, turn("a"));
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a"));
    await broker.dispatch(spec, "tools/list", {}, () => true, undefined, turn("a"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(spawned[0]).toMatchObject({ methods: ["initialize", "call:get_window_state", "call:click", "tools/list"], closed: false });
    await broker.drain();
    expect(spawned[0]!.closed).toBe(true);
  });
  it("never lets another bot, a new turn or a new control revision act on a read", async () => {
    const { spawned, start } = children();
    const broker = new HostComputerBroker(start);
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, turn("a"));
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("b"));
    expect(spawned.map(child => child.methods)).toEqual([["initialize", "call:get_window_state"], ["initialize", "call:click"]]);
    // A second bot keeps its own connection; bot a's is untouched.
    expect(spawned.map(child => child.closed)).toEqual([false, false]);
    // Bot a after a person took control: a new key, so the old read is closed.
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a", 1));
    expect(spawned).toHaveLength(3);
    expect(spawned[0]!.closed).toBe(true);
    expect(spawned[2]!.methods).toEqual(["initialize", "call:click"]);
    await broker.drain();
    expect(spawned.every(child => child.closed)).toBe(true);
  });
  it("keeps each thread of one bot on its own connection: a sibling thread listing, reading or clicking never retires another thread's read", async () => {
    const { spawned, start } = children();
    const broker = new HostComputerBroker(start);
    const first = turn("a", 0, "thread-1"), second = turn("a", 0, "thread-2");
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, first);
    // the second thread mounts this computer (tools/list), then reads and acts on its own window
    await broker.dispatch(spec, "tools/list", {}, () => true, undefined, second);
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, second);
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, second);
    // the first thread's click still lands on the connection that holds its read
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, first);
    // and the threads alternate without retiring each other
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, second);
    await broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, undefined, first);
    await broker.dispatch(spec, "tools/call", { name: "press_key" }, () => true, undefined, second);
    expect(start).toHaveBeenCalledTimes(2);
    expect(spawned.map(child => child.methods)).toEqual([
      ["initialize", "call:get_window_state", "call:click", "call:type_text"],
      ["initialize", "tools/list", "call:get_window_state", "call:click", "call:get_window_state", "call:press_key"],
    ]);
    expect(spawned.map(child => child.closed)).toEqual([false, false]);
    // A new turn on the first thread still retires that thread's old read, and only that one.
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a", 0, "thread-1", "gen-2"));
    expect(spawned).toHaveLength(3);
    await vi.waitFor(() => expect(spawned[0]!.closed).toBe(true));
    expect(spawned[1]!.closed).toBe(false);
    expect(spawned[2]!.methods).toEqual(["initialize", "call:click"]);
    await broker.drain();
    expect(spawned.every(child => child.closed)).toBe(true);
  });
  it("opens a new connection after the driver child died and never replays the failed call", async () => {
    const { spawned, start } = children();
    const broker = new HostComputerBroker(start);
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, turn("a"));
    spawned[0]!.dead = true;
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a"));
    expect(start).toHaveBeenCalledTimes(2);
    expect(spawned[0]).toMatchObject({ methods: ["initialize", "call:get_window_state"], closed: true });
    expect(spawned[1]!.methods).toEqual(["initialize", "call:click"]);
    // A child that dies under an action fails that call and is closed; the
    // action got no reply, so exclusion is kept exactly as for one-off children.
    // r8 (C8 / D16 a): the loss answers driver-lost 409 sent:true instead of the raw transport error (a 500 at the route).
    spawned[1]!.diesOnCall = true;
    await expect(broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, undefined, turn("a"))).rejects.toMatchObject({ status: 409, code: "driver-lost", sent: true });
    expect(spawned[1]!.closed).toBe(true);
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a"))).toThrow("in progress");
    await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
  });
  it("closes the connection when a call is refused after its reply, so the next click must read again", async () => {
    let active = true;
    const closed: number[] = [];
    let opened = 0;
    const broker = new HostComputerBroker(() => {
      const id = ++opened;
      return {
        // the person takes control while the driver is answering this call
        request: async (method: string) => { if (method === "tools/call" && id === 1) active = false; return { content: [] }; },
        notify: async () => {}, close: async () => { closed.push(id); },
      };
    });
    await expect(broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => active, undefined, turn("a"))).rejects.toThrow("control changed");
    expect(closed).toEqual([1]);
    active = true;
    await broker.dispatch(spec, "tools/call", { name: "click" }, () => active, undefined, turn("a"));
    expect(opened).toBe(2);
    await broker.drain().catch(() => {});
  });
  it("on Stop answers at once, keeps exclusion until the driver replies, then closes the connection and frees the computer", async () => {
    const action = deferred();
    const signals: Array<AbortSignal | undefined> = [];
    let closed = 0;
    const broker = new HostComputerBroker(() => ({
      request: async (method: string, _params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        if (method === "initialize") return {};
        if (method === "tools/list") return { tools: [] };
        signals.push(options?.signal); return action.promise;
      },
      notify: async () => {}, close: async () => { closed++; },
    }));
    const stop = new AbortController();
    const call = broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, stop.signal, turn("a"));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    stop.abort();
    expect(signals[0]?.aborted).toBe(true);
    await expect(call).rejects.toMatchObject({ status: 409, code: "cancelled", sent: true });
    // another bot, and the same bot, are both held off while the driver may still act
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("b"))).toThrow("in progress");
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a"))).toThrow("in progress");
    expect(closed).toBe(0);
    action.resolve({ content: [] });
    await vi.waitFor(() => expect(closed).toBe(1));
    await vi.waitFor(() => expect(() => broker.dispatch(spec, "tools/list", {}, () => true, undefined, turn("a"))).not.toThrow());
    await broker.drain();
  });
  it("a new turn of the same bot never cuts off the old turn's withdrawn action before the driver replies", async () => {
    const action = deferred();
    const children: Array<{ closed: boolean }> = [];
    let reached = false;
    const broker = new HostComputerBroker(() => {
      const child = { closed: false };
      children.push(child);
      return {
        request: async (method: string) => {
          if (child.closed) throw new Error("transport failed");
          if (method === "tools/call") { reached = true; return action.promise; }
          return method === "tools/list" ? { tools: [] } : {};
        },
        notify: async () => {}, close: async () => { child.closed = true; },
      };
    });
    const stop = new AbortController();
    const old = broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, stop.signal, turn("a"));
    await vi.waitFor(() => expect(reached).toBe(true));
    stop.abort();
    await expect(old).rejects.toMatchObject({ code: "cancelled", sent: true });
    // the next turn's proxy lists tools while the old action is still withdrawn
    const nextTurn = turn("a", 0, "thread-a", "gen-2");
    await broker.dispatch(spec, "tools/list", {}, () => true, undefined, nextTurn);
    expect(children.map(child => child.closed)).toEqual([false, false]);
    action.resolve({ content: [] });
    await vi.waitFor(() => expect(children[0]!.closed).toBe(true));
    // the driver answered, so the computer is free again for the new turn
    await vi.waitFor(() => expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, nextTurn)).not.toThrow());
    await broker.drain();
  });
  it("never sends a session action stopped before it reached the driver, and frees the computer", async () => {
    const initialized = deferred();
    const request = vi.fn(async (method: string) => method === "initialize" ? initialized.promise : {});
    const broker = new HostComputerBroker(() => ({ request, notify: async () => {}, close: async () => {} }));
    const stop = new AbortController();
    const call = broker.dispatch(spec, "tools/call", { name: "click" }, () => true, stop.signal, turn("a"));
    stop.abort();
    await expect(call).rejects.toMatchObject({ code: "cancelled", sent: false });
    initialized.resolve({});
    await vi.waitFor(() => expect(() => broker.dispatch(spec, "tools/call", { name: "type_text" }, () => true, undefined, turn("a"))).not.toThrow());
    expect(request.mock.calls.map(([method]) => method)).not.toContain("tools/call");
    await broker.drain();
  });
  it("keeps exclusion when a session's driver child cannot be confirmed closed", async () => {
    const broker = new HostComputerBroker(() => ({
      request: async (method: string) => { if (method === "tools/call") throw new Error("transport failed"); return {}; },
      notify: async () => {}, close: async () => { throw new Error("close unconfirmed"); },
    }));
    await expect(broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("a"))).rejects.toThrow("transport failed");
    expect(() => broker.dispatch(spec, "tools/call", { name: "click" }, () => true, undefined, turn("b"))).toThrow("in progress");
    await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
  });
  it("reports cleanup as unconfirmed when an idle session's child cannot be confirmed closed at shutdown", async () => {
    const broker = new HostComputerBroker(() => ({ request: async () => ({}), notify: async () => {}, close: async () => { throw new Error("close unconfirmed"); } }));
    await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, turn("a"));
    await expect(broker.drain()).rejects.toThrow("cleanup is unconfirmed");
  });
  it("closes an unused session once its turn is revoked or it sits idle", async () => {
    vi.useFakeTimers();
    try {
      const { spawned, start } = children();
      const broker = new HostComputerBroker(start);
      let active = true;
      await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => active, undefined, turn("a"));
      await broker.dispatch(spec, "tools/call", { name: "get_window_state" }, () => true, undefined, turn("b"));
      active = false;
      await vi.advanceTimersByTimeAsync(2_500);
      expect(spawned.map(child => child.closed)).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(HOST_SESSION_IDLE_MS);
      expect(spawned.map(child => child.closed)).toEqual([true, true]);
      await broker.drain();
    } finally { vi.useRealTimers(); }
  });
});

// DESIGN 1022-cua-windows C4 / D13 / R17g (W-K8): the broker's own generation fence. `allowed()` is always true here,
// so the route's gate (host-computer-gate.ts) is not the thing under test.
describe("W-K8 the broker's claim fence per driver generation", () => {
  const G1 = "0123456789ab"; const G2 = "ba9876543210";
  const gspec = (generation: string, platform = "linux") => ({ command: "fake-driver", args: ["mcp"], env: {}, platform, generation });
  const pending = () => new Promise<string>(resolve => setTimeout(() => resolve("still-waiting"), 100));
  const idle = () => vi.fn(() => ({ request: async () => ({ content: [] }), notify: async () => {}, close: async () => {} }));
  // a driver that takes the call and never answers (the action is inside the driver)
  const silent = () => {
    const closed = deferred<void>(); const taken: string[] = [];
    const start = vi.fn(() => ({ request: async (method: string) => { if (method === "initialize") return {}; taken.push(method); return new Promise(() => {}); }, notify: async () => {}, close: () => closed.promise }));
    return { start, taken };
  };
  // the spawn check is an await: a withdrawal that lands while it runs still stops the child from starting
  it("win32: withdrawGeneration(G) while the exe check runs -> host-off, start 0 (one-off child)", async () => {
    const verify = deferred<"ok">(); const start = idle();
    const broker = new HostComputerBroker(start as never, { verifySpawn: () => verify.promise });
    const call = broker.dispatch(gspec(G1, "win32"), "tools/call", { name: "click" }, () => true);
    const outcome = call.then(() => "ok", (error: { code?: string }) => error.code);
    broker.withdrawGeneration(G1); verify.resolve("ok");
    expect(await outcome).toBe("host-off");
    expect(start).toHaveBeenCalledTimes(0);
  });
  it("win32: withdrawGeneration(G) while the exe check runs -> host-off, start 0 (kept session)", async () => {
    const verify = deferred<"ok">(); const start = idle();
    const broker = new HostComputerBroker(start as never, { verifySpawn: () => verify.promise });
    const call = broker.dispatch(gspec(G1, "win32"), "tools/call", { name: "click" }, () => true, undefined, hostComputerSession("bot", "thread", "turn", 0));
    const outcome = call.then(() => "ok", (error: { code?: string }) => error.code);
    broker.withdrawGeneration(G1); verify.resolve("ok");
    expect(await outcome).toBe("host-off");
    expect(start).toHaveBeenCalledTimes(0);
  });
  it("withdrawGeneration(G) while the child is still initializing -> host-off, the action is never sent (one-off child)", async () => {
    const init = deferred<unknown>(); const sent: string[] = [];
    const start = vi.fn(() => ({ request: async (method: string) => { if (method === "initialize") return init.promise; sent.push(method); return {}; }, notify: async () => {}, close: async () => {} }));
    const broker = new HostComputerBroker(start as never, { verifySpawn: async () => "ok" });
    const call = broker.dispatch(gspec(G1), "tools/call", { name: "click" }, () => true);
    const outcome = call.then(() => "ok", (error: { code?: string }) => error.code);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    broker.withdrawGeneration(G1); init.resolve({});
    expect(await outcome).toBe("host-off");
    expect(sent).toEqual([]);
  });
  it("retireGeneration also closes a G session that a newer turn key of the same thread already took out of the map", async () => {
    const closed: boolean[] = []; const taken: string[] = []; let n = 0;
    const start = vi.fn(() => { const i = n++; closed[i] = false; return { request: async (method: string) => { if (method === "initialize") return {}; taken.push(method); return method === "tools/call" ? new Promise(() => {}) : { tools: [] }; }, notify: async () => {}, close: async () => { closed[i] = true; } }; });
    const broker = new HostComputerBroker(start as never, { verifySpawn: async () => "ok" });
    const call = broker.dispatch(gspec(G1), "tools/call", { name: "click" }, () => true, undefined, hostComputerSession("bot", "thread", "turn-1", 0));
    const settled = call.then(() => "ok", (error: { code?: string }) => error.code);
    await vi.waitFor(() => expect(taken).toEqual(["tools/call"]));
    // the owner's next turn (new key, same thread) takes the first session out of the map
    await broker.dispatch(gspec(G2), "tools/list", {}, () => true, undefined, hostComputerSession("bot", "thread", "turn-2", 0));
    expect(closed[0]).toBe(false);
    broker.retireGeneration(G1, { exitConfirmed: true });
    expect(await Promise.race([settled, pending()])).toBe("driver-exited");
    await vi.waitFor(() => expect(closed[0]).toBe(true));
    expect(closed[1]).toBe(false);
  });
  for (const platform of ["linux", "win32"]) {
    // win32 broker verification is injected so the cell needs no real exe
    const make = (start: ReturnType<typeof vi.fn>) => new HostComputerBroker(start as never, { verifySpawn: async () => "ok" });
    it(`${platform}: withdrawGeneration(G) refuses a new call on G with host-off and starts nothing; another generation still runs`, async () => {
      const start = idle(); const broker = make(start);
      broker.withdrawGeneration(G1);
      expect(() => broker.dispatch(gspec(G1, platform), "tools/call", { name: "click" }, () => true), platform).toThrow(expect.objectContaining({ code: "host-off", status: 409 }));
      expect(start, platform).toHaveBeenCalledTimes(0);
      await broker.dispatch(gspec(G2, platform), "tools/call", { name: "click" }, () => true);
      expect(start, platform).toHaveBeenCalledTimes(1);
    });
    it(`${platform}: a G claim held by an unanswered action survives withdrawGeneration and clears only on a confirmed retire`, async () => {
      const { start, taken } = silent(); const broker = make(start);
      const call = broker.dispatch(gspec(G1, platform), "tools/call", { name: "click" }, () => true);
      const settled = call.then(() => "ok", (error: { code?: string }) => error.code);
      await vi.waitFor(() => expect(taken, platform).toEqual(["tools/call"]));
      broker.withdrawGeneration(G1);
      expect(() => broker.dispatch(gspec(G2, platform), "tools/call", { name: "type" }, () => true), platform).toThrow("in progress");
      broker.retireGeneration(G1, { exitConfirmed: false } as never);
      expect(() => broker.dispatch(gspec(G2, platform), "tools/call", { name: "type" }, () => true), platform).toThrow("in progress");
      broker.retireGeneration(G1, { exitConfirmed: true });
      expect(await Promise.race([settled, pending()]), platform).toBe("driver-exited");
      let next: Promise<unknown> | undefined;
      expect(() => { next = broker.dispatch(gspec(G2, platform), "tools/call", { name: "type" }, () => true); }, platform).not.toThrow();
      next?.catch(() => {});
      await vi.waitFor(() => expect(start, platform).toHaveBeenCalledTimes(2));
    });
    it(`${platform}: retireGeneration closes G's kept sessions and answers the call waiting on one`, async () => {
      const closed: boolean[] = []; const taken: string[] = []; let n = 0;
      const start = vi.fn(() => { const i = n++; closed[i] = false; return { request: async (method: string) => { if (method === "initialize") return {}; taken.push(method); return new Promise(() => {}); }, notify: async () => {}, close: async () => { closed[i] = true; } }; });
      const broker = make(start);
      const session = hostComputerSession("bot", "thread", "turn", 0);
      const call = broker.dispatch(gspec(G1, platform), "tools/call", { name: "click" }, () => true, undefined, session);
      const settled = call.then(() => "ok", (error: { code?: string }) => error.code);
      await vi.waitFor(() => expect(taken, platform).toEqual(["tools/call"]));
      broker.retireGeneration(G1, { exitConfirmed: true });
      expect(await Promise.race([settled, pending()]), platform).toBe("driver-exited");
      await vi.waitFor(() => expect(closed, platform).toEqual([true]));
    });
  }
});
