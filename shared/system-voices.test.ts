// W10': Windows owners could not reach a speech engine that already worked.
//
// The harness has driven two zero-key engines for releases — `say` on a Mac
// and System.Speech on Windows — behind one provider called "system". The
// settings UI offered that provider on Darwin only. A Windows owner had
// ElevenLabs (needs their own key) and nothing else, because Flux Router has
// no synthesis endpoint at all. The capability was shipped and unreachable.
//
// So the two things pinned here are the two halves of that mismatch:
// the harness's idea of "this machine can speak" and the settings UI's idea
// of "offer the built-in engine" must be the SAME set of platforms, and the
// UI must ask the shared rule rather than name one platform itself.
//
// The UI half used to be a gate AND four strings inline in a React component
// this node-environment suite cannot render, so the only check available was
// a scan of the component's source: green for any spelling the regex missed,
// and never once running the branch. The decision now lives in
// shared/system-voices.ts as `systemVoiceOffer`, and the component renders
// what it returns — so the test below RUNS the thing a Windows owner sees.
// One source check survives, and only to prove the component still asks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { systemVoicesAvailable } from "../server/tts/system-voices.ts";
import { windowsVoicesAvailable } from "../server/tts/windows-voices.ts";
import { SYSTEM_VOICE_PLATFORMS, platformHasSystemVoices, systemVoiceOffer } from "./system-voices.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const voiceSettings = () => stripComments(readFileSync(join(ROOT, "src/components/VoiceSettings.tsx"), "utf8"));

// Everything a desktop capability or `process.platform` can actually say.
const PLATFORMS = ["darwin", "win32", "linux", "other", "freebsd", "", undefined] as const;

describe("which platforms have a built-in voice", () => {
  it("names Windows alongside macOS", () => {
    expect([...SYSTEM_VOICE_PLATFORMS]).toEqual(["darwin", "win32"]);
    expect(platformHasSystemVoices("darwin")).toBe(true);
    expect(platformHasSystemVoices("win32")).toBe(true);
  });

  it("is false, not a crash, for a platform with no built-in engine", () => {
    for (const platform of ["linux", "other", "freebsd", "", undefined]) {
      expect(platformHasSystemVoices(platform)).toBe(false);
    }
  });

  it("agrees with the harness on every platform, so the two cannot drift apart", () => {
    for (const platform of PLATFORMS) {
      // What server/tts/index.ts calls platformCanSpeak(): either engine.
      const harness = systemVoicesAvailable(platform ?? "") || windowsVoicesAvailable(platform ?? "");
      expect(platformHasSystemVoices(platform)).toBe(harness);
    }
  });
});

describe("what the voice settings card offers, run for each platform", () => {
  it("offers a Windows owner the built-in engine, named for their machine", () => {
    const offer = systemVoiceOffer("win32", "system");
    expect(offer.available).toBe(true);
    expect(offer.label).toBe("Built-in Windows voices");
    // the two pieces of Mac-only wording a Windows owner used to be shown
    expect(offer.label).not.toContain("Mac");
    expect(offer.sentence).toContain("this PC");
    expect(offer.sentence).not.toContain("this Mac");
  });

  it("still names the Mac for a Mac owner", () => {
    const offer = systemVoiceOffer("darwin", "system");
    expect(offer.available).toBe(true);
    expect(offer.label).toBe("Built-in Mac voices");
    expect(offer.sentence).toContain("this Mac");
  });

  it("offers nobody an engine their machine does not have, and says what to do instead", () => {
    for (const platform of ["linux", "other", "freebsd", "", undefined]) {
      const offer = systemVoiceOffer(platform, "system");
      expect(offer.available).toBe(false);
      expect(offer.sentence).toContain("built-in voices are unavailable here");
      expect(offer.sentence).toContain("Switch to ElevenLabs");
    }
  });

  it("tells nobody that built-in voices are macOS-only, on any platform or provider", () => {
    for (const platform of PLATFORMS) {
      for (const provider of ["elevenlabs", "system"] as const) {
        const offer = systemVoiceOffer(platform, provider);
        expect(offer.sentence).not.toMatch(/only on macOS/);
        expect(offer.unavailableHint).toBe("Built-in voices are available on macOS and Windows");
      }
    }
  });

  it("agrees with the platform rule it is built on, everywhere", () => {
    for (const platform of PLATFORMS) {
      expect(systemVoiceOffer(platform, "system").available).toBe(platformHasSystemVoices(platform));
    }
  });

  it("says the ElevenLabs sentence when ElevenLabs is the chosen engine, even where built-ins exist", () => {
    expect(systemVoiceOffer("win32", "elevenlabs").sentence).toContain("ElevenLabs key is shared");
    expect(systemVoiceOffer("linux", "elevenlabs").sentence).toContain("ElevenLabs key is shared");
  });
});

// The one thing the function cannot prove about itself: that the component
// asks it. Read from the source with comments stripped, because server- and
// browser-side React cannot be rendered here.
describe("the voice settings card asks that function rather than deciding again", () => {
  it("takes its gate and its words from the shared offer", () => {
    const source = voiceSettings();
    expect(source).toContain("systemVoiceOffer(hostPlatform, provider)");
    // The old gate, and the two strings it used to spell out inline. Their
    // return is a Windows owner locked out, or shown Mac wording, again.
    expect(source).not.toMatch(/host\.platform === "darwin"/);
    expect(source).not.toMatch(/"Built-in Mac voices"/);
    expect(source).not.toMatch(/installed on this Mac/);
  });
});
