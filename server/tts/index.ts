// Voice, wired to config. Three engines live behind this file: ElevenLabs
// (elevenlabs.ts, needs a key) and the two built-in voices that need no key
// at all, the Mac's (system-voices.ts) and Windows' (windows-voices.ts).
// This file is only the part that reads ~/.murage/config.json, picks the
// engine, and decides whether there is a voice at all.
//
// "system" is ONE provider with two implementations, chosen by platform,
// rather than two providers a person has to know the difference between.
// Nobody picking a voice should have to know which operating system wrote it.
import type { AppConfig } from "../config.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as systemVoices from "./system-voices.ts";
import * as windowsVoices from "./windows-voices.ts";

/** Whether this machine can speak without a key. Windows was missing before,
 *  which left a Windows owner with no voice at all on day one: ElevenLabs
 *  needs their key, and Flux Router has no synthesis endpoint (see the note
 *  at the top of server/voice/flux-voice.ts). */
function platformCanSpeak(): boolean {
  return systemVoices.systemVoicesAvailable() || windowsVoices.windowsVoicesAvailable();
}

export type VoiceProvider = "elevenlabs" | "system";

export class NoVoiceConfigured extends Error {
  // a plain field rather than a constructor parameter property: the harness
  // runs under `node --experimental-strip-types`, which is strip-ONLY, so a
  // parameter property is rejected at load time even though it typechecks
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice") {
    super(
      reason === "key"
        ? "Add an ElevenLabs key in Settings on the computer to turn on voice."
        : "Pick a voice in the agent profile.",
    );
    this.reason = reason;
  }
}

export function voiceProvider(cfg: AppConfig): VoiceProvider {
  return cfg.tts?.provider === "system" ? "system" : "elevenlabs";
}

/** The system provider needs no credential — it is only ever offered where
 * the platform actually has it, so "configured" means "this engine can
 * speak", not "a key is on file". */
export function providerConfigured(cfg: AppConfig): boolean {
  return voiceProvider(cfg) === "system" ? platformCanSpeak() : Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  if (voiceProvider(cfg) === "system") {
    return platformCanSpeak() && Boolean(cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  if (voiceProvider(cfg) === "system") {
    return platformCanSpeak() && Boolean(voiceId || cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && (voiceId || cfg.tts?.voice));
}

/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential. */
export function describeVoice(cfg: AppConfig) {
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice ?? "",
    provider: voiceProvider(cfg),
  };
}

export function verifyKey(key: string) {
  return elevenlabs.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner): Promise<elevenlabs.Voice[]> {
  if (voiceProvider(cfg) === "system") {
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.listWindowsVoices(run)
      : systemVoices.listSystemVoices(run);
  }
  const key = cfg.tts?.key;
  if (!key) return [];
  return elevenlabs.listVoices(key);
}

/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner) {
  if (voiceProvider(cfg) === "system") {
    const voice = voiceId || cfg.tts?.voice;
    // An injected runner is the cross-platform test seam for the two native
    // binaries; production calls omit it and stay strictly platform-gated.
    if (!platformCanSpeak() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.synthesizeWindows(text, voice, run)
      : systemVoices.synthesizeSystem(text, voice, run);
  }
  const key = cfg.tts?.key;
  if (!key) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesize(text, voice, key);
}

export type { Voice } from "./elevenlabs.ts";
