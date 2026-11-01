// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L1A-1013 r1 (Astra item 5, Fable H1): the 12-hour task allowance's Undo
// and Settings "Clear" reach the harness from the paired phone, as the owner;
// the bot card's Undo (always-allow/undo) stays the computer's, like the save.
// RED until the integrator applies
// handoffs/ROUTE-POLICY-PATCH-1013-UX-L1A.diff (route-policy.ts is
// integrator-only); that is what this test proves landed.
import { describe, expect, it } from "vitest";
import { conversationSubject, routeAdmits, routeClass, routePolicy } from "./route-policy.ts";

const phone = { desktop: false, companion: true, door: true, bot: false };
const browserDoor = { desktop: false, companion: false, door: true, bot: false };
const botShell = { desktop: false, companion: false, door: false, bot: true };

describe("task-allow routes are classed companion", () => {
  for (const path of ["/api/bots/b1/task-allow/remove", "/api/bots/b1/task-allow/clear"]) {
    it(`POST ${path}`, () => {
      expect(routeClass("POST", path)).toBe("companion");
      expect(routePolicy("POST", path)?.cloudWrite).toBe("step-up");
      expect(routeAdmits(routeClass("POST", path), phone)).toBe(true);
      // a door without the owner's launch proof, or a bot's own shell, never
      expect(routeAdmits(routeClass("POST", path), browserDoor)).toBe(false);
      expect(routeAdmits(routeClass("POST", path), botShell)).toBe(false);
      expect(routeClass("GET", path)).toBe("desktop");
      // the hidden-bot rule at the gate covers it (a phone never reaches a bot it cannot see)
      expect(conversationSubject(path)).toEqual({ scope: "bot", botId: "b1" });
    });
  }
  it("the bot card's Undo is the computer's, as the save and the global remove", () => {
    for (const path of ["/api/bots/b1/always-allow", "/api/bots/b1/always-allow/remove", "/api/bots/b1/always-allow/undo"]) {
      expect(routeClass("POST", path)).toBe("desktop");
      expect(routePolicy("POST", path)).toBeDefined();
      expect(routeAdmits("desktop", phone)).toBe(false);
    }
  });
});
