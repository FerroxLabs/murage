// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #7 (MAIN 2026-11-26): the "read outside content" card could never fire (its lane needs owner No limits, and the card
// returned null at No limits), so it was deleted. Entry: autoVerdict (server/auto-approve.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";

describe("OVERREACH #7 no outside-content card", () => {
  it("O7-source the dead card builder is gone from the verdict code", () => {
    const source = readFileSync(new URL("./auto-approve.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/outsideTurnCard|OUTSIDE_TURN_ENGINE_READS|OUTSIDE_TURN_OWN_READS|editInsideWorkFolder/);
  });
  it.each([
    ["Full access", { autoApprove: true, fullAccess: true }],
    ["No limits", { autoApprove: true, fullAccess: true, noLimits: true }],
  ])("O7-behaviour a turn that read outside content never gets the outside-content card at %s", (_name, bot) => {
    const context = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: ["network command"], commandText: "git status", commandCwd: "/tmp/proj" } as const;
    const verdict = autoVerdict(bot, "Bash", "git status", context as never);
    expect(verdict.source).not.toBe("outside-turn");
    expect(verdict.approve).not.toBeNull();
  });
});
