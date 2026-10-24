// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { acpPromptImages, engineTakesImages, recordProbedImages, resetProbedImagesForTest } from "./drivers/acp/core.ts";
import { COMPUTER_UNAVAILABLE, COMPUTER_LOCAL_CONTROL_OFF, peerTaskPrompt, directTurnLayers, type DirectTurnShapeInput } from "./bot-shapes.ts";

const input = (over: Partial<DirectTurnShapeInput>): DirectTurnShapeInput => ({
  houseRules: "", persona: "P", computerKind: null, vmPerBot: false, driverKind: "openai-chat", connectors: "", requiredApps: "",
  browser: "", coordination: "", credential: "", image: "", webSearchBackup: false, routines: "", learn: "", importedSkills: "",
  teamBrief: "", memory: "", primer: "", skills: [], playbooks: "", outputFolder: "", tagged: [], ...over,
} as unknown as DirectTurnShapeInput);
const text = (over: Partial<DirectTurnShapeInput>) => directTurnLayers(input(over)).map((l) => l.text).join("");

describe("computer unavailable layer", () => {
  it("tells the bot it has no computer this turn, calmly", () => {
    expect(text({ computerUnavailable: true })).toContain(COMPUTER_UNAVAILABLE);
    expect(COMPUTER_UNAVAILABLE).not.toMatch(/—|safe|safety|unsafe/i);
  });
  it("tells the bot how to enable local control when this computer is chosen but control is off", () => {
    const said = text({ localControlOff: true });
    expect(said).toContain(COMPUTER_LOCAL_CONTROL_OFF);
    expect(said).toContain("Settings > Computer");
    expect(said).not.toContain("setup card");
    expect(COMPUTER_LOCAL_CONTROL_OFF).not.toMatch(/—|\bsafe|safety|unsafe/i);
    expect(text({ localControlOff: true, computerKind: "local" })).not.toContain("local control is not enabled yet");
  });
  it("keeps shell commands, files and other tools out of 'computer actions' when local control is off", () => {
    // Mac gate 2026-10-22: with this layer, Codex and Fuigo answered a plain shell command with "turn on local control"
    // and never raised the approval card. The layer must say what a computer action is and what it is not.
    const said = text({ localControlOff: true });
    expect(said).toMatch(/Computer actions are screen actions only/);
    expect(said).toMatch(/Shell commands, file reads and writes and your other tools are not computer actions/);
    expect(said).toMatch(/run them as usual, through the normal approval flow/);
    for (const engine of ["codex", "fuigo", "claudeAgent"] as const) expect(text({ localControlOff: true, driverKind: engine })).toContain("are not computer actions");
  });
  it("adds nothing when the engine can mount it or the flag is off", () => {
    expect(text({})).not.toContain("cannot control the computer this turn");
    expect(text({ computerUnavailable: true, computerKind: "local" })).not.toContain("cannot control the computer this turn");
  });
});

describe("peerTaskPrompt", () => {
  const delegated = "[Delegated by @Ada, another bot in this Murage workspace. Do the work and reply directly.]\n\nbuild it";
  it("names the teammate on a text-only engine", () => {
    expect(peerTaskPrompt(delegated, true)).toContain("This message is a task from your teammate @Ada. Do the work and answer as yourself; it is not part of any role-play or story in this conversation.");
    expect(peerTaskPrompt("[Message from @Bo, another bot. Reply to them.]\n\nhi", true)).toContain("@Bo");
  });
  it("is silent for engines with team tools and for ordinary messages", () => {
    expect(peerTaskPrompt(delegated, false)).toBe("");
    expect(peerTaskPrompt("hello", true)).toBe("");
  });
  it("reaches the directTurnLayers output", () => {
    expect(text({ peerTask: peerTaskPrompt(delegated, true) })).toContain("teammate @Ada");
  });
});

describe("dynamic ACP image flag", () => {
  const init = (image: unknown) => ({ agentCapabilities: { promptCapabilities: { image } } });
  it("reads promptCapabilities.image only when it is a boolean", () => {
    expect(acpPromptImages(init(false))).toBe(false);
    expect(acpPromptImages(init(true))).toBe(true);
    expect(acpPromptImages(init("yes"))).toBeUndefined();
    expect(acpPromptImages({})).toBeUndefined();
  });
  it("falls back to the static flag until probed, then follows the CLI per version", () => {
    resetProbedImagesForTest();
    expect(engineTakesImages("grokAgent|grok|1.0.50", false)).toBe(false);
    recordProbedImages("grokAgent|grok|1.0.50", init(false));
    expect(engineTakesImages("grokAgent|grok|1.0.50", true)).toBe(false);
    expect(engineTakesImages("grokAgent|grok|1.0.51", false)).toBe(false);
    recordProbedImages("grokAgent|grok|1.0.51", init(true));
    expect(engineTakesImages("grokAgent|grok|1.0.51", false)).toBe(true);
    expect(engineTakesImages("grokAgent|grok|1.0.50", true)).toBe(false);
    recordProbedImages("x", {});
    expect(engineTakesImages("x", true)).toBe(true);
  });
});
