// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { cardHistoryLine } from "./project-card-history";
it("formats history from enum detail and ignores free-form unknown fields", () => {
  expect(cardHistoryLine({ kind: "card_moved", detail: { from: "doing", to: "waiting", text: "CANARY" } })).toBe("Moved from In progress to Waiting");
  for (const [kind, line] of [["card_reassigned", "Reassigned"], ["card_took_over", "Taken over by you"], ["card_failed", "Failed"], ["card_result", "Result posted"], ["future", "Project updated"]]) expect(cardHistoryLine({ kind, detail: {} })).toBe(line);
  expect(cardHistoryLine({ kind: "card_moved", detail: { from: "CANARY", to: "CANARY" } })).toBe("Card moved");
});
