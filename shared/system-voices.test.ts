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
// The UI half is a gate inside a React component that this node-environment
// suite cannot render, so it is read out of the SOURCE with comments stripped
// first — a check that matched prose could be satisfied by a paragraph like
// this one instead of by the code.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { systemVoicesAvailable } from "../server/tts/system-voices.ts";
import { windowsVoicesAvailable } from "../server/tts/windows-voices.ts";
import { SYSTEM_VOICE_PLATFORMS, platformHasSystemVoices } from "./system-voices.ts";

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

describe("the voice settings gate", () => {
  it("asks the shared rule instead of naming a platform of its own", () => {
    const source = voiceSettings();
    expect(source).toContain("platformHasSystemVoices(hostPlatform)");
    // The old gate. Its return is a Windows owner locked out again.
    expect(source).not.toMatch(/host\.platform === "darwin"/);
  });

  it("does not offer a Windows owner Mac voices", () => {
    const source = voiceSettings();
    expect(source).toContain("Built-in Windows voices");
    // The engine button's label and the sentence above it both used to be
    // Mac-only wording that no longer matches who can see them.
    expect(source).not.toMatch(/label: "Built-in Mac voices"/);
    expect(source).not.toMatch(/installed on this Mac/);
  });

  it("stops telling anyone built-in voices are macOS-only", () => {
    expect(voiceSettings()).not.toMatch(/available only on macOS/);
  });
});
