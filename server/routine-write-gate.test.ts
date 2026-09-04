// The second door into the schedule table.
//
// The bug this file pins: `POST /api/routines` and `PATCH|DELETE
// /api/routines/:id` were gated to the desktop, and confirming a routine card
// was not. `POST /api/bots/:id/respond` and `POST /api/threads/:id/respond`
// both reach `resolveAndSendRoutine` -> `routineRequests.resolve` ->
// `routines.create/update/remove`, and `inputFromDefinition` sets
// `enabled: true` (routine-requests.ts:582). So a phone could confirm a card
// and get a LIVE interval schedule spawning turns, with the gate on
// /api/routines never consulted.
//
// The executor audited `/api/teams/import` for this shape and reasonably
// concluded it was safe — that route writes `enabled: false`. The barrier it
// relied on does not exist on the card path.
//
// Exactly the same shape as the mcpServers bypass through PUT /api/config.
// The rule is not "gate the obvious route", it is "gate every path that can
// write a spawn-deciding record".
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { routineCardApplyAllowed } from "./routine-write-gate.ts";

describe("routine card apply gate", () => {
  it("refuses to apply a routine card from a phone", () => {
    expect(routineCardApplyAllowed(true, "allow", "remote")).toBe(false);
  });

  it("applies a routine card from the desktop", () => {
    expect(routineCardApplyAllowed(true, "allow", "desktop")).toBe(true);
  });

  it("lets any surface DENY, because refusing writes no schedule", () => {
    // A person holding a phone must always be able to say no to something
    // their bot proposed. Deny reaches resolve() but creates nothing.
    expect(routineCardApplyAllowed(true, "deny", "remote")).toBe(true);
    expect(routineCardApplyAllowed(true, "deny", "desktop")).toBe(true);
  });

  it("ignores cards that are not routine requests", () => {
    // Skill, approval and connector cards share the respond routes. This gate
    // must not touch them, or a phone loses the ability to answer anything.
    expect(routineCardApplyAllowed(false, "allow", "remote")).toBe(true);
    expect(routineCardApplyAllowed(false, "deny", "remote")).toBe(true);
  });

  it("treats an unknown behavior as a non-write", () => {
    // "answer" is a real third behavior on these routes. It resolves other
    // card kinds and never reaches routines.create.
    expect(routineCardApplyAllowed(true, "answer", "remote")).toBe(true);
  });
});

describe("the gate is actually wired into both respond routes", () => {
  // index.ts starts listening on import, so it cannot be pulled into a unit
  // test — the same constraint flux-surface.test.ts documents. Pin the wiring
  // at the source instead, so deleting the call is a red test rather than a
  // silent reopening of the door.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("calls the gate before resolving a routine card", () => {
    expect(source).toContain("routineCardApplyAllowed(Boolean(card), args.behavior, args.surface)");
  });

  it("hands the LIVE request surface to every respond call site", () => {
    // Counting `surface: requestSurface(...)` across the file is not the
    // property — index.ts has a third, unrelated one on the config-status
    // response, so a loose count stays green while a call site regresses.
    // (It did: the first version of this test asserted >= 2 against a
    // baseline of 3, and a control that hardcoded one call site to "desktop"
    // passed.) Assert the real thing: EVERY resolveAndSendRoutine call
    // passes the live surface.
    const calls = [...source.matchAll(/resolveAndSendRoutine\(res, \{([\s\S]*?)\}\)\)/g)];
    expect(calls.length).toBe(2); // bots/:id/respond and threads/:id/respond
    for (const [, body] of calls) {
      expect(body).toContain("surface: requestSurface(req.headers, url.searchParams)");
    }
  });
});
