// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner-idle clock counts owner actions only: the desktop's 30 s presence beat and the other background writes never reset it.
import { describe, expect, it } from "vitest";
import { countsAsOwnerAction, OwnerIdleClock } from "./owner-activity.ts";

describe("the owner-idle clock", () => {
  it("counts sends, edits and settings writes", () => {
    for (const [method, url] of [["POST", "/api/threads/t1/messages"], ["PATCH", "/api/bots/b1"], ["PUT", "/api/config"], ["DELETE", "/api/threads/t1"], ["POST", "/api/cards/c1/answer?x=1"]] as const)
      expect(countsAsOwnerAction(method, url), `${method} ${url}`).toBe(true);
  });
  it("ignores reads and the app's own beats", () => {
    for (const [method, url] of [["GET", "/api/threads"], ["HEAD", "/"], ["OPTIONS", "/api/presence"], ["POST", "/api/presence"], ["POST", "/api/presence/"], ["POST", "/api/presence?v=1"], ["POST", "/api/backup-failure-notice"], ["POST", "/api/automation-admission"], ["POST", "/api/diagnostics/incident"]] as const)
      expect(countsAsOwnerAction(method, url), `${method} ${url}`).toBe(false);
  });
  it("presence beats every 30 s do not reset the idle gate; a send does", () => {
    let now = 1_000_000;
    const clock = new OwnerIdleClock(() => now);
    for (let beat = 0; beat < 40; beat++) { now += 30_000; clock.note("POST", "/api/presence"); }
    expect(clock.idleMs()).toBe(40 * 30_000);
    expect(clock.idleMs()).toBeGreaterThanOrEqual(10 * 60_000);
    clock.note("POST", "/api/threads/t1/messages");
    expect(clock.idleMs()).toBe(0);
  });
});
