// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import { isGenericCredentialPatch } from "./credential-projection.ts";
import {
  assertFluxNotPaused,
  createFluxHomeGate,
  fluxHomePause,
  isHomeFluxKey,
  startFluxHomeGate,
  stopFluxHomeGate,
} from "./flux-home-gate.ts";
import { applyFluxSurface } from "../flux-routing.ts";

const HOME_KEY = "sk-flux-home-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const OWNER_KEY = "sk-flux-" + "FAKE0000000000000000000000000000000TESTKEY";

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function gateWith(responder: (url: string, init: RequestInit) => Response | Promise<Response>, key: string | null = HOME_KEY) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, gate: createFluxHomeGate({ key: () => key, fetch: fetchImpl, now: () => 1_000 }) };
}
const okBody = { state: "ok", paused: false, message: null, cap_microcents: 30_000_000, spent_microcents: 4_000_000, resets_at: "2026-11-01T00:00:00Z" };

afterEach(() => {
  stopFluxHomeGate();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("which key a home may hold", () => {
  it("accepts a key Flux issued for a home and nothing else", () => {
    expect(isHomeFluxKey(HOME_KEY)).toBe(true);
    for (const bad of [OWNER_KEY, "sk-flux-home-short", "sk-flux-home-" + "a".repeat(300), "sk-flux-home-" + "a b".repeat(10), "", null, undefined, 42, {}]) {
      expect(isHomeFluxKey(bad)).toBe(false);
    }
  });

  it("refuses to store the owner's primary Flux key on a home (finding C-01)", () => {
    expect(isGenericCredentialPatch({ fluxApiKey: OWNER_KEY })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: "new-fixture" })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: HOME_KEY })).toBe(true);
    expect(isGenericCredentialPatch({ fluxApiKey: "" })).toBe(true);
    expect(isGenericCredentialPatch({ somethingElse: "value" })).toBe(true);
    expect(isGenericCredentialPatch({ somethingElse: "value", fluxApiKey: OWNER_KEY })).toBe(false);
    expect(isGenericCredentialPatch({ fluxApiKey: 5 })).toBe(false);
  });
});

describe("asking Flux whether this home's key may work", () => {
  it("sends only the home key, to the status route, without following redirects", async () => {
    const { gate, calls } = gateWith(() => reply(200, okBody));
    const result = await gate.refresh();
    expect(result).toMatchObject({ paused: false, state: "ok", message: null, capMicrocents: 30_000_000, spentMicrocents: 4_000_000, resetsAt: "2026-11-01T00:00:00Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.fluxrouter.ai/v1/cloud-home/status");
    expect(calls[0].init.redirect).toBe("manual");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${HOME_KEY}`);
  });

  it("pauses with our own plain credits words and the reset date when the monthly limit is used, never the router's text", async () => {
    const message = "This home has used its $30.00 monthly Flux limit. See https://fluxrouter.ai/manage/k1 key_name=home-secret";
    const { gate } = gateWith(() => reply(200, { state: "capped", paused: true, message, resets_at: "2026-11-01T00:00:00Z" }));
    const pause = await gate.refresh();
    expect(pause).toMatchObject({ paused: true, state: "capped", message: expect.stringContaining("You've used this month's credits. They come back on November 1.") });
    expect(pause.message).not.toMatch(/flux|manage|home-secret|\$30/i);
  });

  it("never shows router text for any paused state, whatever the message says", async () => {
    for (const state of ["stopped", "revoked", "ip_refused", "unavailable"] as const) {
      const { gate } = gateWith(() => reply(200, { state, paused: true, message: "Stopped.\n\u0007Line two\u001b[31m Flux fluxrouter.ai sk-flux-x" + "x".repeat(500) }));
      const pause = await gate.refresh();
      expect(pause.paused).toBe(true);
      expect(Array.from(pause.message!).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)).toBe(false);
      expect(pause.message!.length).toBeLessThanOrEqual(400);
      expect(pause.message).not.toMatch(/flux|sk-|Line two/i);
    }
  });

  it.each([
    [500, "unavailable", cloudHomeCopy.fluxPausedUnavailable],
    [503, "unavailable", cloudHomeCopy.fluxPausedUnavailable],
  ])("treats an unreadable %i as %s", async (status, state, message) => {
    const { gate } = gateWith(() => new Response("<html>nope</html>", { status }));
    expect(await gate.refresh()).toMatchObject({ paused: true, state, message });
  });

  it.each([401, 403])("a %i from the status question keeps the last known state, logs an errorCode and raises no customer error", async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let answer: () => Response = () => reply(200, { ...okBody, paused: true, state: "capped", resets_at: "2030-03-05T00:00:00Z" });
    const { gate } = gateWith(() => answer());
    const before = await gate.refresh();
    expect(before.paused).toBe(true);
    answer = () => new Response('{"error":"fk_id_fake revoked https://fluxrouter.ai/x"}', { status });
    const after = await gate.refresh();
    expect(after).toEqual(before); // not read as "not paused", and not rewritten as a new pause
    expect(log).toHaveBeenCalledWith(`Cloud model service status refusal errorCode=cloud_flux_status_auth_refused status=${status}`);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fk_id_fake|fluxrouter/);
    // from the start (nothing known yet) it is not a pause either
    const fresh = gateWith(() => new Response("{}", { status })).gate;
    expect(await fresh.refresh()).toMatchObject({ paused: false, message: null });
    log.mockRestore();
  });

  it("pauses when Flux cannot be reached, and clears on the next good answer", async () => {
    let up = false;
    const { gate } = gateWith(() => { if (!up) throw new TypeError("network"); return reply(200, okBody); });
    expect(await gate.refresh()).toMatchObject({ paused: true, state: "unavailable", message: cloudHomeCopy.fluxPausedUnavailable });
    up = true;
    expect(await gate.refresh()).toMatchObject({ paused: false, state: "ok" });
  });

  it("does not pause on an older Flux that has no such route", async () => {
    const { gate } = gateWith(() => reply(404));
    expect(await gate.refresh()).toMatchObject({ paused: false, state: "unknown" });
  });

  it("asks nothing when there is no key, and never sends a foreign key", async () => {
    const none = gateWith(() => reply(200, okBody), null);
    expect(await none.gate.refresh()).toMatchObject({ paused: false, state: "no-key" });
    expect(none.calls).toHaveLength(0);
    const foreign = gateWith(() => reply(200, okBody), OWNER_KEY);
    expect(await foreign.gate.refresh()).toMatchObject({ paused: true, state: "invalid", message: cloudHomeCopy.fluxOwnerKeyOnHome });
    expect(foreign.calls).toHaveLength(0);
  });

  it("shares one question between callers who ask together", async () => {
    let resolve!: (value: Response) => void;
    const { gate, calls } = gateWith(() => new Promise<Response>((r) => { resolve = r; }));
    const first = gate.refresh();
    const second = gate.refresh();
    resolve(reply(200, okBody));
    expect(await first).toBe(await second);
    expect(calls).toHaveLength(1);
  });

  it("re-asks at once after a refusal from Flux, and ignores other statuses", async () => {
    const { gate, calls } = gateWith(() => reply(200, okBody));
    gate.noteRefusal(200);
    gate.noteRefusal(500);
    expect(calls).toHaveLength(0);
    gate.noteRefusal(402);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("polls on a timer, sooner while Flux is down, and stops when told", async () => {
    vi.useFakeTimers();
    let up = false;
    const { gate, calls } = gateWith(() => { if (!up) throw new TypeError("network"); return reply(200, okBody); });
    gate.start(60_000, 15_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(2);
    up = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(3);
    expect(gate.current().paused).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(4);
    gate.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(4);
  });
});

describe("pausing Flux turns on a Cloud home", () => {
  const capped = () => startFluxHomeGate({
    key: () => HOME_KEY,
    fetch: (async () => reply(200, { state: "capped", paused: true, message: "router words" })) as unknown as typeof fetch,
  });

  it("refuses a Flux turn with the plain message once Flux says paused", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const gate = capped();
    await gate.refresh();
    expect(fluxHomePause().paused).toBe(true);
    expect(() => assertFluxNotPaused()).toThrow(/You've used this month's credits/);
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(() => applyFluxSurface("qwenAgent", env, "flux-auto", HOME_KEY)).toThrow(/used this month's credits/);
    expect(env.MURAGE_FLUX_API_KEY).toBeUndefined();
  });

  it("leaves a model that is not on Flux alone (the sign-in engines)", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await capped().refresh();
    const env: Record<string, string | undefined> = {};
    expect(applyFluxSurface("codex", env, "gpt-5.5", HOME_KEY).applied).toBe(false);
    expect(applyFluxSurface("codex", env, null, HOME_KEY).applied).toBe(false);
  });

  it("serves Flux turns while Flux has not said otherwise", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(() => assertFluxNotPaused()).not.toThrow();
    startFluxHomeGate({ key: () => HOME_KEY, fetch: (async () => reply(200, okBody)) as unknown as typeof fetch });
    await vi.waitFor(() => expect(fluxHomePause().state).toBe("ok"));
    const env: Record<string, string | undefined> = {};
    expect(applyFluxSurface("qwenAgent", env, "flux-auto", HOME_KEY).applied).toBe(true);
  });

  it("never gates a desktop, even if a pause were somehow recorded", async () => {
    await capped().refresh();
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(() => assertFluxNotPaused()).not.toThrow();
    expect(applyFluxSurface("codex", {}, "flux::flux-auto", OWNER_KEY).applied).toBe(true);
  });
});

describe("the browser bundle stays clear of the gate", () => {
  it("flux-routing.ts reaches the pause check without undici or node:crypto", () => {
    const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
    expect(read("../flux-routing.ts")).not.toContain("flux-home-gate");
    expect(read("./flux-pause.ts").match(/^import .*$/gm)).toEqual(['import { cloudHomeCopy } from "./copy.ts";']);
  });
});
