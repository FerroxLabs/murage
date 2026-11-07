import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedProvider } from "../../tools/flux-stream-sim/providers/scripted.ts";
import { createSimServer } from "../../tools/flux-stream-sim/server.ts";
import { FluxStreamRefused, failureForClose, fluxStreamBase, openFluxStream } from "./flux-stream.ts";

let sim: Awaited<ReturnType<typeof createSimServer>>;
beforeAll(async () => {
  sim = await createSimServer({ port: 0, provider: scriptedProvider(), allowFaults: true });
});
afterAll(async () => sim.close());

const env = () => ({ MURAGE_FLUX_STREAM_API: sim.baseUrl }) as NodeJS.ProcessEnv;

describe("openFluxStream", () => {
  it("reads the base per call", () => {
    expect(fluxStreamBase({} as NodeJS.ProcessEnv)).toBe("wss://api.fluxrouter.ai/v1");
    expect(fluxStreamBase(env())).toBe(sim.baseUrl);
  });

  it("opens, holds messages until a subscriber, receives session.started, closes cleanly", async () => {
    const stream = await openFluxStream({ key: "sim_key", query: new URLSearchParams(), env: env() });
    await new Promise((r) => setTimeout(r, 200)); // session.started arrives before anyone listens
    const types: string[] = [];
    stream.onMessage((_raw, msg) => types.push(msg.type));
    stream.sendJson({ type: "session.close" });
    const closed = await stream.closed;
    expect(closed.code).toBe(1000);
    expect(types[0]).toBe("session.started");
    expect(types.at(-1)).toBe("session.closed");
  });

  it("surfaces a refusal with its error", async () => {
    const stream = await openFluxStream({ key: "sim_free", query: new URLSearchParams(), env: env() });
    const closed = await stream.closed;
    expect(closed).toMatchObject({ code: 4402, error: { code: "premium_locked" } });
    expect(failureForClose(closed.code, closed.error)).toBe("premium");
  });

  it("rejects when the handshake itself fails", async () => {
    await expect(openFluxStream({ key: "sim_key", query: new URLSearchParams("sim_fault=reject%3D503"), env: env() })).rejects.toBeInstanceOf(FluxStreamRefused);
  });

  it("aborts a pending handshake", async () => {
    const abort = new AbortController();
    const pending = openFluxStream({ key: "sim_key", query: new URLSearchParams(), env: { MURAGE_FLUX_STREAM_API: "ws://127.0.0.1:9/v1" } as NodeJS.ProcessEnv, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ message: "aborted" });
  });

  it("refuses a cleartext ws:// base to a remote host before connecting, and never sends the key", async () => {
    for (const base of ["ws://api.example.com/v1", "ws://10.255.255.1:9/v1", "ws://localhost.evil.test/v1"]) {
      const err = await openFluxStream({ key: "not-a-flux-key", query: new URLSearchParams(), env: { MURAGE_FLUX_STREAM_API: base } as NodeJS.ProcessEnv }).catch((e) => e);
      expect(err).toBeInstanceOf(FluxStreamRefused);
      expect(err.message).toContain("wss://");
      expect(JSON.stringify([err.message, err.error])).not.toContain("not-a-flux-key");
    }
  });

  it("allows ws:// to loopback hosts", async () => {
    for (const base of ["ws://127.0.0.1:9/v1", "ws://localhost:9/v1", "ws://[::1]:9/v1"]) {
      const err = await openFluxStream({ key: "not-a-flux-key", query: new URLSearchParams(), env: { MURAGE_FLUX_STREAM_API: base } as NodeJS.ProcessEnv, handshakeMs: 500 }).catch((e) => e);
      expect(String(err.message)).not.toContain("wss://"); // refused by the network, not by the cleartext rule
    }
  });

  it("maps close codes to the batch failure vocabulary", () => {
    expect(failureForClose(4401)).toBe("auth");
    expect(failureForClose(4404)).toBe("unavailable");
    expect(failureForClose(4429)).toBe("rate_limit");
    expect(failureForClose(4413)).toBe("format");
    expect(failureForClose(4502)).toBe("upstream");
  });
});

it("retains both handshake 402 envelopes and memoizes budget, but not premium", async () => {
  const { createServer } = await import("node:http");
  const { isBudgetReached, resetUnavailable } = await import("./voice-routes.ts");
  for (const code of ["key_budget_reached", "premium_locked"]) for (const body of [{ error: { code } }, { error: code }]) {
    resetUnavailable();
    const server = createServer();
    server.on("upgrade", (_req, socket) => { const json = JSON.stringify(body); socket.end(`HTTP/1.1 402 Payment Required\r\nContent-Length: ${Buffer.byteLength(json)}\r\nContent-Type: application/json\r\n\r\n${json}`); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const base = `ws://127.0.0.1:${address.port}/v1`;
    try {
      const error = await openFluxStream({ key: "fixture", query: new URLSearchParams(), env: { MURAGE_FLUX_STREAM_API: base }, handshakeMs: 1000 }).catch(e => e);
      expect(error).toBeInstanceOf(FluxStreamRefused);
      expect(error.error.code).toBe(code);
      expect(failureForClose(error.closeCode, error.error)).toBe(code === "premium_locked" ? "premium" : "budget");
      expect(isBudgetReached({ via: "flux", label: "Flux", baseUrl: base.replace(/^ws/, "http"), key: "fixture", model: "host" })).toBe(code !== "premium_locked");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

it("a memoized key never opens a transcription socket", async () => {
  const { markBudgetReached, resetUnavailable } = await import("./voice-routes.ts");
  markBudgetReached({ via: "flux", label: "Flux", baseUrl: "http://127.0.0.1:9/v1", key: "spent", model: "" });
  try {
    await expect(openFluxStream({ key: "spent", query: new URLSearchParams(), env: { MURAGE_FLUX_STREAM_API: "ws://127.0.0.1:9/v1" } })).rejects.toMatchObject({ closeCode: 4402, error: { code: "key_budget_reached" } });
  } finally { resetUnavailable(); }
});
