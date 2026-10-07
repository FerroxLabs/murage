// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { engineSwitchLines } from "./engine-switch.ts";

describe("engineSwitchLines", () => {
  it("names what the new engine loses, then what it gains", () => {
    expect(engineSwitchLines(
      { agentsMcp: true, composioMcp: true, images: true, effortLevels: ["low", "high"] },
      { agentsMcp: false, images: true, browserMcp: true },
    )).toEqual([
      "Loses the team tools (messaging, asking and handing work to other bots) on this engine.",
      "Loses connected apps on this engine.",
      "Loses the effort setting on this engine.",
      "Gains the browser on this engine.",
    ]);
  });

  it("words the queueing fact as its own sentence each way", () => {
    expect(engineSwitchLines({ queueing: true }, { queueing: false })).toEqual([
      "Messages you send while it works wait until it finishes, on this engine.",
    ]);
    expect(engineSwitchLines({ queueing: false }, { queueing: true })).toEqual([
      "Takes messages while it works, on this engine.",
    ]);
  });

  it("Claude to Fuigo no longer mentions queueing", () => {
    const lines = engineSwitchLines({ agentsMcp: true, queueing: true }, { agentsMcp: true, queueing: true });
    expect(lines).toEqual([]);
    expect(engineSwitchLines({ images: true, queueing: true }, { images: true, queueing: true }).join(" ")).not.toMatch(/message/i);
  });

  it("says nothing when the engines match or one is unknown", () => {
    expect(engineSwitchLines({ agentsMcp: true }, { agentsMcp: true })).toEqual([]);
    expect(engineSwitchLines(undefined, { agentsMcp: true })).toEqual([]);
    expect(engineSwitchLines({ agentsMcp: true }, undefined)).toEqual([]);
  });
});
