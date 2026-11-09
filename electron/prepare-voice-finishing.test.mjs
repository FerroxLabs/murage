// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// D24-SPEECH-SNAPSHOT 1.0.18: the Prepare to reinstall dialog while a voice reply is finishing (prepare-voice-finishing.mjs).
import { describe, expect, it } from "vitest";
import { STEP_UP_LANGUAGES } from "./step-up-locale.mjs";
import { voiceFinishingDialog, voiceFinishingMinutes } from "./prepare-voice-finishing.mjs";

describe("Prepare to reinstall while a voice reply is finishing", () => {
  it("reads the minutes from the code and from nothing else", () => {
    expect(voiceFinishingMinutes("DOWNGRADE_VOICE_FINISHING_7")).toBe(7);
    expect(voiceFinishingMinutes("DOWNGRADE_VOICE_FINISHING_99")).toBe(99);
    for (const code of ["DOWNGRADE_VOICE_FINISHING_0", "DOWNGRADE_VOICE_FINISHING_100", "DOWNGRADE_VOICE_FINISHING", "DOWNGRADE_WORK_PENDING", "", null, 7]) expect(voiceFinishingMinutes(code)).toBeNull();
    expect(voiceFinishingDialog("DOWNGRADE_WORK_PENDING")).toBeNull();
  });
  it("English says it plainly, with the minutes left", () => {
    expect(voiceFinishingDialog("DOWNGRADE_VOICE_FINISHING_4", "en")).toEqual({ type: "info", buttons: ["Quit"], title: "Murage", message: "Murage is finishing a voice reply.", detail: "Try again in about 4 min. Your chats and memories are as they were." });
  });
  it.each(STEP_UP_LANGUAGES.filter((code) => code !== "en"))("%s reads in its own words, with the minutes filled in", (code) => {
    const en = voiceFinishingDialog("DOWNGRADE_VOICE_FINISHING_4", "en");
    const own = voiceFinishingDialog("DOWNGRADE_VOICE_FINISHING_4", code);
    expect(own.message).not.toBe(en.message);
    expect(own.detail).not.toBe(en.detail);
    expect(own.buttons[0]).not.toBe("Quit");
    expect(own.detail).toContain("4");
    expect(own.detail).not.toContain("{minutes}");
  });
});
