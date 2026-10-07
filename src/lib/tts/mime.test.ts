import { describe, expect, it } from "vitest";

import { normaliseMime } from "./mime";

// Spec §4.1 (Limits): native accepts audio/mpeg, audio/wav, audio/aac and
// audio/mp4, and refuses anything else, parameters included, as badArgs.
describe("normaliseMime", () => {
  // One case per voice service, with the content type each one actually
  // sends (server/tts/*.ts, and the header /api/tts/speak passes on).
  it.each([
    ["ElevenLabs (elevenlabs.ts: always audio/mpeg)", "audio/mpeg", "audio/mpeg"],
    ["Flux and OpenAI (flux-speech.ts: response_format mp3)", "audio/mpeg", "audio/mpeg"],
    ["Flux and OpenAI sending WAV (flux-speech.test.ts)", "audio/wav", "audio/wav"],
    ["xAI (xai-speech.ts passes its own header on; parameters dropped)", "audio/mpeg; charset=binary", "audio/mpeg"],
    ["the Mac's system voices (system-voices.ts)", "audio/wav", "audio/wav"],
    ["Windows voices (windows-voices.ts)", "audio/wav", "audio/wav"],
  ])("%s", (_service, sent, normalised) => {
    expect(normaliseMime(sent)).toBe(normalised);
  });

  it("drops parameters and case", () => {
    expect(normaliseMime("Audio/MPEG;codecs=mp3")).toBe("audio/mpeg");
    expect(normaliseMime(" audio/aac ; rate=24000")).toBe("audio/aac");
  });

  it("folds the mp3 aliases into audio/mpeg", () => {
    expect(normaliseMime("audio/mp3")).toBe("audio/mpeg");
    expect(normaliseMime("audio/mpeg3")).toBe("audio/mpeg");
  });

  it("folds the wav aliases into audio/wav", () => {
    expect(normaliseMime("audio/wave")).toBe("audio/wav");
    expect(normaliseMime("audio/x-wav")).toBe("audio/wav");
  });

  it("keeps aac and mp4", () => {
    expect(normaliseMime("audio/aac")).toBe("audio/aac");
    expect(normaliseMime("audio/mp4")).toBe("audio/mp4");
  });

  it("labels a clip with no type audio/mpeg, every service's default; native sniffs the bytes anyway", () => {
    expect(normaliseMime("")).toBe("audio/mpeg");
    expect(normaliseMime(undefined)).toBe("audio/mpeg");
  });

  it("passes an unknown type through, so native refuses it rather than guessing", () => {
    expect(normaliseMime("audio/ogg")).toBe("audio/ogg");
  });
});
