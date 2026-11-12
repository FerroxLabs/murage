// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { createFluxDeviceCodeClient } from "./flux-device-code-client.ts";
import { OWNER_BACKOFF_MS } from "./email-owner-signin.ts";

const CAPS = { device_authorization_grant: true, bot_keys: true, client_id: "murage-cloud", scope: "email:owner", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_authorization_endpoint: "/api/device/code", token_endpoint: "/api/device/token" };
const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
// Execute the production runtime callback, including both Cloud dependencies, rather than a second offer implementation.
const expression = index.match(/\n  offered: \(\) => ([^\n]+),\n  cardHost:/)![1]!;
const offered = (cloudHome: boolean, cloudEmailStore: boolean, available: boolean) =>
  Function("cloudHome", "cloudEmailStore", "cloudEmailAvailability", `return ${expression}`)(cloudHome, cloudEmailStore, { available: () => available }) as boolean;
let sessions: Array<ReturnType<typeof createHomeSupervisorSession>>;
beforeEach(() => { vi.useFakeTimers(); sessions = []; });
afterEach(() => { sessions.forEach(session => session.close()); vi.useRealTimers(); });
function boot(fetcher: typeof fetch, emailStore = true) {
  const messages: Array<{ type: string; available?: boolean; ttlMs?: number }> = [];
  const child = Object.assign(new EventEmitter(), { connected: true, send: (message: typeof messages[number]) => { messages.push(message); } });
  const session = createHomeSupervisorSession({ store: { getAll: () => ({}), patch: () => ({}), close: () => {} }, bootstrapSecret: "fixture", fluxBaseUrl: "https://flux.test/v1", fetch: fetcher, emailStore });
  sessions.push(session); session.attachChild(child as unknown as ChildProcess);
  return { messages, child, available: () => messages.filter(m => m.type === "murage:email-owner-signin-availability").at(-1)?.available === true };
}

describe("Cloud email runtime availability", () => {
  it.each([
    ["capabilities 404", () => new Response(null, { status: 404 })],
    ["bot_keys false", () => Response.json({ ...CAPS, bot_keys: false })],
    ["wrong client_id", () => Response.json({ ...CAPS, client_id: "desktop" })],
    ["wrong scope", () => Response.json({ ...CAPS, scope: "email:send" })],
    ["network error", () => { throw new Error("offline"); }],
  ])("%s closes the offer, then a later valid capability opens it", async (_label, response) => {
    let good = false;
    const fetcher = vi.fn(async () => good ? Response.json(CAPS) : response());
    const h = boot(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.available()).toBe(false); expect(offered(true, true, h.available())).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(OWNER_BACKOFF_MS[0]! - 1); expect(fetcher).toHaveBeenCalledOnce();
    good = true; await vi.advanceTimersByTimeAsync(1);
    expect(h.available()).toBe(true); expect(offered(true, true, h.available())).toBe(true);
    expect(h.messages.at(-1)).toMatchObject({ available: true, ttlMs: 30_000 });
  });
  it("a capability timeout is unavailable, aborts, and respects backoff before recovery", async () => {
    let good = false, signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      signal = init?.signal;
      return good ? Response.json(CAPS) : new Promise<Response>(() => {});
    });
    const h = boot(fetcher);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal?.aborted).toBe(true); expect(offered(true, true, h.available())).toBe(false);
    good = true;
    await vi.advanceTimersByTimeAsync(4_999); expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(offered(true, true, h.available())).toBe(true);
  });
  it("a valid report still requires the sealed store; desktop offers stay unchanged", async () => {
    const fetcher = vi.fn(async () => Response.json(CAPS));
    const h = boot(fetcher); await vi.advanceTimersByTimeAsync(0);
    expect(h.available()).toBe(true);
    await vi.advanceTimersByTimeAsync(123.5); h.messages.length = 0;
    h.child.emit("message", { type: "murage:cloud-model-signin-ready" }); await vi.advanceTimersByTimeAsync(0);
    expect(h.messages.at(-1)).toMatchObject({ available: true, ttlMs: 29_876 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(offered(true, false, true)).toBe(false); expect(offered(true, true, true)).toBe(true);
    expect(offered(false, false, false)).toBe(true); expect(offered(false, true, true)).toBe(true);
    const offFetcher = vi.fn(async () => Response.json(CAPS));
    const off = boot(offFetcher, false); await vi.advanceTimersByTimeAsync(0);
    expect(off.available()).toBe(false); expect(offFetcher).not.toHaveBeenCalled();
  });
  it("the real client deduplicates capability reads, caches 30 s, and doubles failed retry delays", async () => {
    let good = true, clock = 1;
    const fetcher = vi.fn(async () => good ? Response.json(CAPS) : new Response(null, { status: 404 }));
    const client = createFluxDeviceCodeClient({ baseUrl: "https://flux.test/v1", fetch: fetcher, now: () => clock });
    expect(typeof client.availability).toBe("function");
    const results = await Promise.all([client.availability!(), client.availability!()]);
    expect(results).toEqual([{ available: true, retryAfterMs: 30_000 }, { available: true, retryAfterMs: 30_000 }]);
    clock += 29_999; expect((await client.availability!()).available).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
    good = false; clock++;
    for (const delay of OWNER_BACKOFF_MS) {
      expect(await client.availability!()).toEqual({ available: false, retryAfterMs: delay });
      clock += delay - 1; const count = fetcher.mock.calls.length;
      expect((await client.availability!()).available).toBe(false); expect(fetcher).toHaveBeenCalledTimes(count); clock++;
    }
  });
  it("private reports expire or close on malformed input and production consumes them before the email shell", async () => {
    expect(index).toContain("cloudEmailAvailability.receive(message)");
    const { createCloudEmailAvailability } = await import("./email-signin-availability.ts");
    let clock = 1; const report = createCloudEmailAvailability(() => clock);
    try {
      report.receive({ type: "murage:email-owner-signin-availability", available: true, ttlMs: 30_000 });
      expect(report.available()).toBe(true); clock += 30_000; expect(report.available()).toBe(false);
      report.receive({ type: "murage:email-owner-signin-availability", available: true, ttlMs: 30_001 }); expect(report.available()).toBe(false);
      report.receive({ type: "murage:email-owner-signin-availability", available: true, ttlMs: 30_000 });
      report.receive({ type: "murage:email-owner-signin-availability", available: "true", ttlMs: 30_000 }); expect(report.available()).toBe(false);
    } finally { report.dispose(); }
  });
});
