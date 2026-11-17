// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 (1.0.18, MurageMain ruling): an engine Murage does not see in full (Box, Pi, OpenCode Go,
// Antigravity, ...) marks every turn `outside tool` (V7). The card No limits raises for such a turn carries which engine
// (`outsideEngine`), so the page can say why it still asks and offer Switch to Fuigo. Only that card: never a card whose
// reason is another outside source, a covered engine's `outside tool`, or any other verdict.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { outsideEngineCard } from "./approval-card-why.ts";

// V7B qualifies Kimi, Droid and custom ACP; use remaining uncovered engines here.
const UNCOVERED = { driverKind: "antigravityAgent", displayName: "Antigravity" };

describe("the uncovered-engine card carries which engine", () => {
  it("an outside-turn card on an uncovered engine whose reason is the blanket mark names the engine", () => {
    expect(outsideEngineCard("outside-turn", "outside tool", UNCOVERED)).toEqual({ outsideEngine: { driver: "antigravityAgent", name: "Antigravity" } });
    expect(outsideEngineCard("outside-turn", "outside tool", { driverKind: "boxAgent", displayName: "My Box" }))
      .toEqual({ outsideEngine: { driver: "boxAgent", name: "My Box" } });
    expect(outsideEngineCard("outside-turn", "outside tool", { driverKind: "opencodeGo", displayName: "OpenCode Go" }))
      .toEqual({ outsideEngine: { driver: "opencodeGo", name: "OpenCode Go" } });
  });

  it("an engine with no display name is named as the rest of the app names it", () => {
    expect(outsideEngineCard("outside-turn", "outside tool", { driverKind: "piAgent", displayName: undefined }))
      .toEqual({ outsideEngine: { driver: "piAgent", name: "pi" } });
    expect(outsideEngineCard("outside-turn", "outside tool", { driverKind: "piAgent", displayName: "  " }))
      .toEqual({ outsideEngine: { driver: "piAgent", name: "pi" } });
  });

  it("no other card carries it", () => {
    // a covered engine's `outside tool` (an unseen item, an unknown MCP tool) is not the blanket mark
    for (const driverKind of ["claudeAgent", "codex", "fuigoAgent", "grokAgent", "geminiAgent", "customAcp", "kimiAgent", "droidAgent"]) {
      expect(outsideEngineCard("outside-turn", "outside tool", { driverKind, displayName: "x" })).toEqual({});
    }
    // another first source on the same uncovered engine is another reason
    for (const source of ["web page", "email", "earlier turn", "memory"]) expect(outsideEngineCard("outside-turn", source, UNCOVERED)).toEqual({});
    // a clean turn, another verdict, no verdict, no engine
    expect(outsideEngineCard("outside-turn", null, UNCOVERED)).toEqual({});
    for (const verdict of ["always-ask", "stop-line", "rule", undefined]) expect(outsideEngineCard(verdict, "outside tool", UNCOVERED)).toEqual({});
    expect(outsideEngineCard("outside-turn", "outside tool", undefined)).toEqual({});
  });

  it("the card the server builds spreads it in (server/index.ts)", () => {
    const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(index).toMatch(/\.\.\.\(permission \? outsideEngineCard\(verdict\?\.source, turnOutsideRead\(event\.threadId\), /);
  });
});
