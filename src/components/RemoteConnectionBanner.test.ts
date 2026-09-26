// ServerLifecycleBanner speaks for the desktop's own engine and renders
// nothing without the Electron bridge (ServerLifecycleBanner.tsx:33). A
// phone whose computer went to sleep had no sentence at all, and the one
// fallback it could reach said "quit Murage and open it again" — advice for
// a desktop app the phone does not have.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REMOTE_FIRST_CONNECT_GRACE_MS,
  REMOTE_OFFLINE_GRACE_MS,
  remoteConnectionNotice,
} from "./RemoteConnectionBanner";

// Defaults describe a connection that was lost after connecting at least
// once — the 3 s grace. The never-connected / cold-start path (15 s grace)
// is exercised separately below, since the two must not share a clock.
const input = (over: Partial<Parameters<typeof remoteConnectionNotice>[0]> = {}) => ({
  connected: false,
  signedOut: false,
  offlineSince: 0,
  now: REMOTE_OFFLINE_GRACE_MS,
  everConnected: true,
  ...over,
});

describe("what a remote client is told", () => {
  it("says it cannot reach the computer, and that it reconnects by itself", () => {
    const text = remoteConnectionNotice(input());
    expect(text).toMatch(/Can't reach your Murage/);
    expect(text).not.toMatch(/quit|server/i);
  });

  it("stays quiet for a blip shorter than the grace period", () => {
    expect(remoteConnectionNotice(input({ now: REMOTE_OFFLINE_GRACE_MS - 1 }))).toBeNull();
  });

  it("says nothing while connected, and leaves signed-out to its own card", () => {
    expect(remoteConnectionNotice(input({ connected: true }))).toBeNull();
    expect(remoteConnectionNotice(input({ signedOut: true }))).toBeNull();
    expect(remoteConnectionNotice(input({ offlineSince: null }))).toBeNull();
  });
});

describe("never-connected vs. lost (ruling R7)", () => {
  // A slow cold start (Tailscale, cellular) has this page never connected at
  // all: `connected` starts false at boot and the SSE only opens once
  // `ensureDesktopSurfaceSecret()` resolves. That is not a loss, so it gets
  // the longer first-connect grace, not the 3 s lost-connection grace.
  it("stays quiet through a slow cold start, up to the 15 s first-connect grace", () => {
    expect(
      remoteConnectionNotice(input({ everConnected: false, offlineSince: 0, now: 14_000 })),
    ).toBeNull();
  });

  it("speaks once a cold start passes 15 s without ever connecting", () => {
    expect(
      remoteConnectionNotice(input({ everConnected: false, offlineSince: 0, now: 16_000 })),
    ).toMatch(/Can't reach your Murage/);
  });

  it("keeps the short 3 s grace once this page has connected before and then loses it", () => {
    // Connected at t=0, lost at t=10_000 (offlineSince), everConnected true.
    expect(
      remoteConnectionNotice(input({ everConnected: true, offlineSince: 10_000, now: 12_000 })),
    ).toBeNull();
    expect(
      remoteConnectionNotice(input({ everConnected: true, offlineSince: 10_000, now: 14_000 })),
    ).toMatch(/Can't reach your Murage/);
  });

  it("the two grace constants are the ones the ruling names", () => {
    expect(REMOTE_OFFLINE_GRACE_MS).toBe(3_000);
    expect(REMOTE_FIRST_CONNECT_GRACE_MS).toBe(15_000);
  });
});

describe("where it appears", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("renders on a confirmed remote surface only", () => {
    expect(app).toContain("{desktop === false && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}");
  });

  it("keeps the quit-and-reopen advice for the desktop only", () => {
    expect(app).toMatch(/desktop === true\s*\?\s*"This usually clears on its own\. If it does not, quit Murage and open it again\."/);
  });
});
