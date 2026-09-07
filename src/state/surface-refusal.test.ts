// Telling "not on this surface" apart from "not right now".
//
// The bug this file pins: the peripheral snapshot loop retried every failure
// with exponential backoff capped at 30s, forever. `api()` threw a bare
// `Error` carrying only a message, so the loop could not see a status and
// treated a deliberate surface gate as an outage. Observed on a real phone
// session over the tailnet: `/api/webhooks` answered 403 and `/api/desktop-
// secret` answered 404, and the browser re-asked both every 30 seconds for as
// long as the tab stayed open, logging "refresh failed; retrying" each time.
//
// Those two statuses are the harness saying no on purpose — the
// `requestSurface(...) !== "desktop"` pattern answers 404, and the scoped
// routes answer 403. Neither changes while the session lives, so a retry
// cannot succeed; it just wakes the radio.
import { describe, expect, it } from "vitest";

import { isPermanentlyRefused } from "./store.tsx";

const withStatus = (status: number): Error => Object.assign(new Error("nope"), { status });

describe("permanently refused", () => {
  it("stops on the two statuses a surface gate actually uses", () => {
    // 403: scoped route, phone asked for a desktop-only panel.
    // 404: route not mounted on this surface at all.
    expect(isPermanentlyRefused(withStatus(403))).toBe(true);
    expect(isPermanentlyRefused(withStatus(404))).toBe(true);
  });

  it("keeps retrying a session that could still come back", () => {
    // 401 is renewable — the door can re-issue a cookie, so this one is
    // worth another attempt and must NOT be treated as permanent.
    expect(isPermanentlyRefused(withStatus(401))).toBe(false);
    // Server-side and transient failures stay retryable.
    expect(isPermanentlyRefused(withStatus(500))).toBe(false);
    expect(isPermanentlyRefused(withStatus(502))).toBe(false);
    expect(isPermanentlyRefused(withStatus(429))).toBe(false);
  });

  it("retries anything with no status at all", () => {
    // A dropped connection rejects with a TypeError and no status. That is
    // the transient case the backoff exists for.
    expect(isPermanentlyRefused(new TypeError("Failed to fetch"))).toBe(false);
    expect(isPermanentlyRefused(undefined)).toBe(false);
    expect(isPermanentlyRefused({ status: "403" })).toBe(false);
  });
});
