// The who-is-driving client must report what it actually knows. A configured
// endpoint that times out, errors or answers malformed is "unavailable", not
// "nobody is driving" (0.1.52 decision U-11, audit A5); the Local VM / VPS
// bridge gate turns that into a refusal. An unconfigured client (the legacy,
// ungated setup) stays a known, disengaged state and never touches the network.
import { describe, expect, it, vi } from "vitest";

import { CONTROL_UNAVAILABLE_PLAIN, ControlUnavailableError, createControlClient } from "./control-client.ts";

const URL_FIXTURE = "http://127.0.0.1:9/api/internal/computer-control?botId=fixture";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: (input: unknown, init?: RequestInit) => Promise<Response>, extra: { cacheMs?: number; timeoutMs?: number } = {}) {
  const spy = vi.fn(fetchImpl);
  return {
    spy,
    control: createControlClient({ url: URL_FIXTURE, token: "fixture-token", fetchImpl: spy as unknown as typeof fetch, ...extra }),
  };
}

describe("createControlClient state", () => {
  it("keeps an unconfigured client disengaged and known without any request", async () => {
    const fetchImpl = vi.fn();
    for (const options of [{ url: "", token: "" }, { url: URL_FIXTURE, token: "" }, { url: "", token: "fixture-token" }]) {
      const control = createControlClient({ ...options, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(control.configured).toBe(false);
      expect(await control.state(true)).toEqual({ held: false, helpOpen: false, available: true });
      expect(await control.requestHelp("reason")).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a well-formed answer as available, with the bearer token", async () => {
    const { control, spy } = client(async () => jsonResponse({ held: true, helpOpen: false }));
    expect(control.configured).toBe(true);
    expect(await control.state(true)).toEqual({ held: true, helpOpen: false, available: true });
    const init = spy.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fixture-token");

    const free = client(async () => jsonResponse({ held: false, helpOpen: true }));
    expect(await free.control.state(true)).toEqual({ held: false, helpOpen: true, available: true });
  });

  it.each([401, 404, 500, 503])("reports HTTP %i as unavailable, never as free", async (status) => {
    const { control } = client(async () => jsonResponse({ held: false, helpOpen: false }, status));
    expect(await control.state(true)).toEqual({ held: false, helpOpen: false, available: false });
  });

  it.each([
    ["non-JSON text", "<html>bad gateway</html>"],
    ["JSON null", "null"],
    ["a JSON array", "[true]"],
    ["an empty object", "{}"],
    ["a missing helpOpen", '{"held":false}'],
    ["a string held", '{"held":"false","helpOpen":false}'],
    ["a numeric held", '{"held":0,"helpOpen":false}'],
  ])("reports a malformed body (%s) as unavailable", async (_label, body) => {
    const { control } = client(async () => jsonResponse(body));
    expect((await control.state(true)).available).toBe(false);
  });

  it("reports a network failure as unavailable", async () => {
    const { control } = client(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    expect(await control.state(true)).toEqual({ held: false, helpOpen: false, available: false });
  });

  it("reports a request that outlives its deadline as unavailable", async () => {
    const { control } = client(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
      { timeoutMs: 25 },
    );
    const started = Date.now();
    expect(await control.state(true)).toEqual({ held: false, helpOpen: false, available: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("createControlClient caching", () => {
  it("caches a known state briefly and lets fresh reads bypass it", async () => {
    let held = false;
    const { control, spy } = client(async () => jsonResponse({ held, helpOpen: false }), { cacheMs: 60_000 });
    expect((await control.state()).held).toBe(false);
    held = true;
    expect((await control.state()).held).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await control.state(true)).held).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never caches an unavailable reading", async () => {
    let failing = true;
    const { control, spy } = client(async () => (failing ? jsonResponse("{}", 503) : jsonResponse({ held: true, helpOpen: false })), { cacheMs: 60_000 });
    expect((await control.state()).available).toBe(false);
    expect((await control.state()).available).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    failing = false;
    expect(await control.state()).toEqual({ held: true, helpOpen: false, available: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("does not let a later outage hide behind an older free answer on a fresh read", async () => {
    let failing = false;
    const { control } = client(async () => (failing ? jsonResponse("{}", 500) : jsonResponse({ held: false, helpOpen: false })), { cacheMs: 60_000 });
    expect((await control.state(true)).available).toBe(true);
    failing = true;
    expect((await control.state(true)).available).toBe(false);
  });
});

describe("control-unavailable guidance", () => {
  it("says the call did not run and asks for a reconnect instead of a retry loop", () => {
    expect(CONTROL_UNAVAILABLE_PLAIN).toMatch(/NOT performed/);
    expect(CONTROL_UNAVAILABLE_PLAIN).toMatch(/Do not retry it in a loop/);
    expect(CONTROL_UNAVAILABLE_PLAIN).toMatch(/reconnect/);
    const error = new ControlUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ControlUnavailableError");
  });
});
