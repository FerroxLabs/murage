// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command that always asks offers Allow and Deny only: no "Always allow",
// no exact-command grant, no "Allow for this task", no routine grant. An
// ordinary card keeps offering them.
import { describe, expect, it } from "vitest";

import { approvalCardGrants, type CardGrantInput } from "./approval-card-grants.ts";
import { autoVerdict } from "./auto-approve.ts";
import type { StopHit } from "./stop-line.ts";

const stopHit: StopHit = { kind: "delete", what: "Delete files outside its folder", place: "/Users/alex" };
const LEVELS = [
  ["Ask", {}],
  ["Auto", { autoApprove: true }],
  ["Full access", { autoApprove: true, fullAccess: true }],
  ["No limits", { autoApprove: true, fullAccess: true, noLimits: true }],
] as const;

function card(command: string, bot: object, withStop: boolean): CardGrantInput {
  return {
    permission: true,
    questionAsk: false,
    inputCut: false,
    tool: "Bash",
    summary: command,
    stopHit: withStop ? stopHit : null,
    exactAllowKey: `exact:claude:/tmp:${command}`,
    routineAllowCard: { routineAllowKey: `exact:claude:/tmp:${command}`, routineId: "routine-1" },
    verdict: autoVerdict(bot, "Bash", command, withStop ? { stopLine: stopHit } : undefined),
  };
}

describe("the grants an approval card offers", () => {
  for (const [level, bot] of LEVELS) {
    for (const command of ["rm -rf ~", "rm -rf /", ":(){ :|:& };:", "sudo dd if=/dev/zero of=/dev/sda"]) {
      for (const withStop of [false, true]) {
        it(`${level}: ${command}${withStop ? " (stop line too)" : ""} offers no standing grant`, () => {
          const input = card(command, bot, withStop);
          expect(input.verdict?.source).toBe("always-ask");
          const grants = approvalCardGrants(input);
          expect(grants.allowKey).toBeUndefined();
          expect(grants.exactAllowKey).toBeUndefined();
          expect(grants.taskAllowKey).toBeUndefined();
          expect(grants.routineAllowKey).toBeUndefined();
          expect(grants.routineId).toBeUndefined();
        });
      }
    }
  }

  it("still offers them on an ordinary card", () => {
    const plain = approvalCardGrants(card("ls -la", {}, false));
    expect(plain.allowKey).toBeDefined();
    expect(plain.exactAllowKey).toBe("exact:claude:/tmp:ls -la");
    expect(plain).toMatchObject({ routineAllowKey: "exact:claude:/tmp:ls -la", routineId: "routine-1" });
    const stopped = approvalCardGrants(card("rm -rf /Users/alex/old", {}, true));
    expect(stopped.allowKey).toBe(stopped.taskAllowKey);
    expect(stopped.taskAllowKey).toBeDefined();
  });
});
