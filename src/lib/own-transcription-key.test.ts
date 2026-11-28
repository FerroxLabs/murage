// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean 11-06 (Settings v1): no transcription vendor in the UI; with a Flux Router key, transcription goes through Flux and
// needs no extra key. Standing 11-19: an optional integration is invisible unless it is used. A key saved by an older
// version keeps working when no engine transcribes, and is the only reason its field ever shows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recorderTranscription, showOwnTranscriptionKey } from "./own-transcription-key";

describe("the own transcription key", () => {
  it("never shows when Flux (or any engine) transcribes, saved key or not", () => {
    for (const route of ["flux", "groq", "openai", "unrecognized"]) {
      expect(showOwnTranscriptionKey(route, true), route).toBe(false);
      expect(showOwnTranscriptionKey(route, false), route).toBe(false);
    }
  });
  it("never shows while the route or the key is unknown, or with no saved key", () => {
    expect(showOwnTranscriptionKey(undefined, true)).toBe(false);
    expect(showOwnTranscriptionKey(null, null)).toBe(false);
    expect(showOwnTranscriptionKey(null, false)).toBe(false);
  });
  it("shows only for a key saved earlier with no engine that transcribes", () => {
    expect(showOwnTranscriptionKey(null, true)).toBe(true);
  });
});

describe("what the skill recorder transcribes with", () => {
  it("uses the engine when one transcribes, even with an old key saved", () => {
    expect(recorderTranscription("flux", true)).toBe("engine");
    expect(recorderTranscription("flux", false)).toBe("engine");
    expect(recorderTranscription("groq", null)).toBe("engine");
  });
  it("keeps using a key saved earlier when no engine transcribes", () => {
    expect(recorderTranscription(null, true)).toBe("own-key");
    expect(recorderTranscription(undefined, true)).toBe("own-key");
  });
  it("has nothing to transcribe with otherwise", () => {
    expect(recorderTranscription(null, false)).toBe("none");
    expect(recorderTranscription(undefined, null)).toBe("none");
  });
});

describe("the skill recorder", () => {
  const source = readFileSync(new URL("../components/SkillRecorderPage.tsx", import.meta.url), "utf8");
  it("picks its transcription with the rule above and sends engine narration through the transcribe route", () => {
    expect(source).toContain("recorderTranscription(");
    expect(source).toContain("postClip(");
  });
  it("names no transcription vendor in what it shows", () => {
    expect(source).not.toMatch(/(?<!\w)AssemblyAI(?!\w)/);
  });
});
