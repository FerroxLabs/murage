// The wiring between a refused response and the retry loop's decision.
//
// This file exists because a negative control stayed GREEN. Reverting the
// status attachment in `api()` — the whole point of the change — did not fail
// `surface-refusal.test.ts`, because that file builds its own errors and only
// exercises the predicate. A control that stays green means the TEST is
// wrong, so this covers the half that was untested: an `api()` rejection has
// to CARRY the status, or the loop upstream cannot act on it and retries a
// permanent refusal forever.
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, isPermanentlyRefused } from "./store.tsx";

const originalFetch = globalThis.fetch;

/** Answer the desktop-secret probe the way a phone surface does (404), and
 * the route under test with whatever the case needs. */
const stubFetch = (status: number, body: unknown = { error: "nope" }) => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/desktop-secret")) {
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("api() failures", () => {
  it("carries the status, so the retry loop can tell refusal from an outage", async () => {
    stubFetch(403, { error: "webhooks are set up on your computer" });
    const error = await api("/api/webhooks").then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).toBe(403);
    // The whole point: this is what stops the 30-second forever-retry.
    expect(isPermanentlyRefused(error)).toBe(true);
  });

  it("keeps a server error retryable", async () => {
    stubFetch(500, { error: "boom" });
    const error = await api("/api/routines").then(
      () => null,
      (cause: unknown) => cause,
    );
    expect((error as { status?: number }).status).toBe(500);
    expect(isPermanentlyRefused(error)).toBe(false);
  });

  it("still returns the body on success", async () => {
    stubFetch(200, { routines: [], runs: [] });
    await expect(api("/api/routines")).resolves.toEqual({ routines: [], runs: [] });
  });
});
