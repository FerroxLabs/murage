// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { beginOutsideTurn, markTurnOutside } from "./email/external-marks.ts";
import { noLimitsAppliesTo } from "./no-limits-origin.ts";
import { ownToolOfRoute, ownWritePlan } from "./outside-own.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { managementWriters, projectWriters } from "./testing/outside-write-census.ts";

useOutsideStoreFixture();
describe("C-CENSUS independent route spellings (supplement to effect traps)", () => {
  it.each(managementWriters)("bot-management %s resolves %s", (action, tool) => {
    expect(ownToolOfRoute("POST", "/api/internal/bot-management", { action })).toBe(tool);
  });
  it.each(projectWriters)("project/%s resolves %s", (route, tool) => {
    expect(ownToolOfRoute("POST", `/api/internal/project/${route}`, {})).toBe(tool);
  });
});

describe("C-STAMP exact targets", () => {
  it.each([false, true])("an outside-derived update retains its target plan with owner N1=%s", lane => {
    beginOutsideTurn("writer-thread", "keys", "generation-1", false);
    markTurnOutside("writer-thread", "web page");
    // The historic lane flag is not authority. The route supplies the current
    // bot settings and proven origin when it plans a No limits owner write.
    const bot = { autoApprove: lane, fullAccess: lane, noLimits: lane, permissionExplicit: true };
    expect(noLimitsAppliesTo("owner", bot)).toBe(lane);
    const call = { threadId: "writer-thread", botId: "caller", tool: "update_bot", lane,
      bot, origin: "owner" as const, targetBotId: "target", changed: ["role"] };
    expect(ownWritePlan(call).sort()).toEqual(["bot:target", "roster:target"]);
    expect(ownWritePlan({ ...call, lane: true, bot: undefined, origin: undefined })).toEqual([]);
  });
});
