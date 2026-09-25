// ServerLifecycleBanner speaks for the desktop's own engine and renders
// nothing without the Electron bridge (ServerLifecycleBanner.tsx:33). A
// phone whose computer went to sleep had no sentence at all, and the one
// fallback it could reach said "quit Murage and open it again" — advice for
// a desktop app the phone does not have.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REMOTE_OFFLINE_GRACE_MS, remoteConnectionNotice } from "./RemoteConnectionBanner";

const input = (over: Partial<Parameters<typeof remoteConnectionNotice>[0]> = {}) => ({
  connected: false,
  signedOut: false,
  offlineSince: 0,
  now: REMOTE_OFFLINE_GRACE_MS,
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

describe("where it appears", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("renders on a confirmed remote surface only", () => {
    expect(app).toContain("{desktop === false && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}");
  });

  it("keeps the quit-and-reopen advice for the desktop only", () => {
    expect(app).toMatch(/desktop === true\s*\?\s*"This usually clears on its own\. If it does not, quit Murage and open it again\."/);
  });
});
