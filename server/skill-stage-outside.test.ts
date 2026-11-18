// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { OWN_ALWAYS_ASK } from "../shared/own-servers.ts";
import { markTurnOutside, observeOutsideMarks, turnOutsideRead } from "./email/external-marks.ts";
import { ownToolGate, ownToolOfRoute } from "./outside-own.ts";
import { toolStartOutside } from "./outside-wire.ts";
import { SetupAtSettle } from "./setup-at-settle.ts";
import { Ledger, settle_verdict } from "./turn-settle.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";

useOutsideStoreFixture();

it.each([false, true])("local skill staging preserves actual outside provenance: marked=%s", marked => {
  const ledger = new Ledger(); ledger.open("G", "T", "claude", "own");
  const off = observeOutsideMarks((thread, source, lifecycle) => ledger.mark(thread, source, lifecycle));
  try {
    if (marked) markTurnOutside("T", "email");
    const tool = ownToolOfRoute("POST", "/api/internal/skills/stage");
    expect(tool).toBe("skill_manage");
    expect(OWN_ALWAYS_ASK.some(row => row.tool === tool)).toBe(true);
    const apply = vi.fn(() => true), push = vi.fn();
    const setup = new SetupAtSettle(ledger);
    expect(setup.file("G", { req: "R", option: true, push_suppressed: true }, {
      open: () => true, option: () => true, apply, push,
    })).toBe(true);
    expect(ownToolGate({ threadId: "T", botId: "B", tool, lane: false })).toBeNull();
    expect(turnOutsideRead("T")).toBe(marked ? "email" : null);
    expect(apply).not.toHaveBeenCalled();
    const verdict = settle_verdict(ledger.rows.get("G")!, { ok: true, readsComplete: true, stopReason: "end_turn" }, turnOutsideRead("T"), "own");
    expect(verdict).toBe(marked ? "outside" : "clean");
    setup.settle("G", verdict);
    expect(apply).toHaveBeenCalledTimes(marked ? 0 : 1);
    expect(push).toHaveBeenCalledTimes(marked ? 1 : 0);
  } finally { off(); }
});

it("foreign skill tools and unregistered staging routes still mark outside content", () => {
  expect(toolStartOutside({ origin: "engine", title: "mcp__external__skill_manage" })).toBe("outside tool");
  const tool = ownToolOfRoute("POST", "/api/internal/skills/stage/unknown");
  expect(ownToolGate({ threadId: "T", botId: "B", tool, lane: false })).toBeNull();
  expect(turnOutsideRead("T")).toBe("outside tool");
});
