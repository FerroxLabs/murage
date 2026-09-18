import { describe, expect, it, vi } from "vitest";
import { HostComputerBroker } from "./host-computer-broker.ts";

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
