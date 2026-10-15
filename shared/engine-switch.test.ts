// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { engineSwitchLines } from "./engine-switch.ts";

describe("engineSwitchLines", () => {
  it("states what the engine does as calm sentences, not losses", () => {
    expect(engineSwitchLines(
      { agentsMcp: true, composioMcp: true, images: true, effortLevels: ["low", "high"] },
      { agentsMcp: false, images: true, browserMcp: true },
      "Grok",
    )).toEqual([
      "On Grok: it doesn't message or hand work to other bots, connected apps aren't used and the effort setting isn't offered.",
      "On Grok: it can use the browser.",
    ]);
  });

  it("words the Grok case as in the picker, with no warning language", () => {
    const lines = engineSwitchLines({ images: true, queueing: true }, { images: false, queueing: false }, "Grok");
    expect(lines).toEqual(["On Grok: pictures aren't passed to the model and new messages wait for the current reply."]);
    expect(lines.join(" ")).not.toMatch(/\u2014|safe|safety|unsafe|loses|broken|cannot/i);
  });

  it("words the queueing fact each way", () => {
    expect(engineSwitchLines({ queueing: false }, { queueing: true })).toEqual(["On this engine: it takes new messages while it works."]);
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

import { computerEngineNote, engineWithoutComputerText } from "./engine-switch.ts";

describe("computerEngineNote", () => {
  it("states the capability calmly when the target engine lacks the destination", () => {
    const note = computerEngineNote("local", { computerMcp: false }, "Fuigo");
    expect(note).toBe("Fuigo doesn't use the computer. Switch to a model that does, like Claude, to use it here.");
    expect(note).not.toMatch(/—|safe|safety|unsafe|error|cannot/i);
    expect(computerEngineNote("vm", {}, undefined)).toBe(engineWithoutComputerText(undefined));
    expect(computerEngineNote("cloud", {}, "X")).not.toBeNull();
  });
  it("says nothing when the engine can, or the destination is not a computer", () => {
    expect(computerEngineNote("local", { localComputerMcp: true }, "Claude")).toBeNull();
    expect(computerEngineNote("vm", { computerMcp: true }, "Claude")).toBeNull();
    expect(computerEngineNote("cloud", {}, "Computer", "boxAgent")).toBeNull();
    expect(computerEngineNote("off", {}, "X")).toBeNull();
    expect(computerEngineNote(undefined, {}, "X")).toBeNull();
  });
});
