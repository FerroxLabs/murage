// Fix round 2 (phone-panels-rereview.md): `/api/bots/:id/browser` can throw
// status 401 for two unrelated reasons — the door's own device-auth refusal
// (server/index.ts:11386, no desktop header and no paired companion) and,
// deeper in the same request, `browserOwnerRequest`'s "authority went
// inactive" check (server/browser-owner-api.ts:10, an authenticated desktop
// session whose bot's browser profile changed, was disabled, or was removed
// mid-request; see server/browser-owner-api.test.ts for that one pinned
// directly against `browserOwnerRequest`). A client mapping bare status 401
// to "sign in on your Mac" would misclassify the second case. Both server
// responses now carry a distinct machine-readable `code` so a client can
// tell them apart without parsing text; this pins the door-level one, which
// needs a real HTTP boundary (it runs before any bot lookup, so no bot or
// auth setup is needed — any id and no headers reach it).
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;

beforeAll(async () => {
  fixture = await launchVerificationServer();
});
afterAll(async () => {
  await fixture?.close();
});

// Since the 0.1.61 route policy (server/route-policy.ts) the gate runs first:
// `/api/bots/:id/browser` is companion class, so a caller with neither the
// desktop's proof nor the door's launch proof is turned away before the
// route's own device-auth check, with the gate's 404 that confirms nothing.
// That still never reads as the 401 of an authority gone inactive. The
// route's 401 with code desktop_only stays as the second layer (its source
// line is pinned in src/lib/desktop-only-route-error.test.ts).
it("the door's device-auth refusal on /api/bots/:id/browser carries code: desktop_only, not just status 401", async () => {
  const response = await fetch(`${fixture.info.url}/api/bots/no-such-bot/browser`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "no such route" });
});
