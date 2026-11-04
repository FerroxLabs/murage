// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// C31: the picker searches on the server only for an own ElevenLabs key;
// the Flux default and every other list stay filtered here, as before.
import { describe, expect, it } from "vitest";

import { filterVoices, localQuery, needsAdding, voicesUrl } from "./voice-picker-model";

describe("voice picker: Voice Library search (own ElevenLabs key only)", () => {
  it("sends the search for an own ElevenLabs key and never for Flux or the others", () => {
    expect(voicesUrl("elevenlabs", { query: " brian " })).toBe("/api/tts/voices?provider=elevenlabs&q=brian");
    expect(voicesUrl("flux", { query: "brian" })).toBe("/api/tts/voices?provider=flux");
    expect(voicesUrl("xai", { query: "brian" })).toBe("/api/tts/voices?provider=xai");
    expect(voicesUrl("system", { query: "brian" })).toBe("/api/tts/voices?provider=system");
    expect(voicesUrl("flux", { recheck: true })).toBe("/api/tts/voices?provider=flux&recheck=1");
    expect(voicesUrl("elevenlabs", { query: "x".repeat(300) })).toContain(`q=${"x".repeat(200)}`);
  });

  it("does not filter server results by a pasted link the rows cannot match", () => {
    const rows = [{ id: "lib1", label: "Brian", publicOwnerId: "own1" }];
    const pasted = "https://elevenlabs.io/app/voice-library/share/own1/lib1";
    expect(filterVoices(rows, { query: localQuery(pasted, true), gender: "all", accent: "all" })).toHaveLength(1);
    expect(filterVoices(rows, { query: localQuery(pasted, false), gender: "all", accent: "all" })).toHaveLength(0);
  });

  it("adds only a library voice before picking it", () => {
    expect(needsAdding({ id: "lib1", label: "Brian", publicOwnerId: "own1" })).toBe(true);
    expect(needsAdding({ id: "acc1", label: "Rachel" })).toBe(false);
    expect(needsAdding(undefined)).toBe(false);
  });
});
