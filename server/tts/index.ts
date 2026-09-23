// Voice, wired to config. Four engines live behind this file: Flux
// (flux-speech.ts, on the workspace's Flux key, the default when no other
// engine was chosen), ElevenLabs (elevenlabs.ts, the owner's own key) and
// the two built-in voices that need no key at all, the Mac's
// (system-voices.ts) and Windows' (windows-voices.ts).
// This file is only the part that reads ~/.murage/config.json, picks the
// engine, and decides whether there is a voice at all.
//
// "system" is ONE provider with two implementations, chosen by platform,
// rather than two providers a person has to know the difference between.
// Nobody picking a voice should have to know which operating system wrote it.
import type { AppConfig } from "../config.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as fluxSpeech from "./flux-speech.ts";
import * as xaiSpeech from "./xai-speech.ts";
import { pronounceable } from "./speech-text.ts";
import { isUnavailable, markUnavailable, resetUnavailable, type VoiceEndpoint, type VoicePart } from "../voice/voice-routes.ts";

/** Where hosted speech runs (Flux, or an own OpenAI key) and which provider
 *  serves each part of a call. Injected by the harness, which owns the model
 *  connections; nothing here reads a key from config itself. */
let speechRoutes: () => VoiceEndpoint[] = () => [];
let voiceRoutes: () => Record<VoicePart, string | null> | null = () => null;
let xaiRoute: () => xaiSpeech.XaiSpeechEndpoint | null = () => null;
export function useVoiceRoutes(routes: {
  speech: () => VoiceEndpoint[];
  describe: () => Record<VoicePart, string | null>;
  /** An owner's own xAI key, for xAI's voices. */
  xai?: () => xaiSpeech.XaiSpeechEndpoint | null;
}) {
  speechRoutes = routes.speech;
  voiceRoutes = routes.describe;
  xaiRoute = routes.xai ?? (() => null);
  resetUnavailable();
}
const hostedSpeech = () => speechRoutes().length > 0;

/** Hosted speech, one source after another. When every source refuses as
 *  not switched on, the computer's own voice speaks rather than nothing:
 *  a call that goes silent looks broken, and a plainer voice does not. */
async function speakHosted(text: string, voice: string, run?: systemVoices.Runner) {
  let refused: Error | null = null;
  for (const route of speechRoutes()) {
    if (isUnavailable(route)) continue;
    try {
      return await fluxSpeech.synthesize(text, voice, route);
    } catch (error) {
      if (!(error instanceof fluxSpeech.SpeechUnavailable)) throw error;
      markUnavailable(route);
      refused = error;
    }
  }
  if (platformCanSpeak() || run) {
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.synthesizeWindows(text, undefined, run)
      : systemVoices.synthesizeSystem(text, undefined, run);
  }
  throw refused ?? new NoVoiceConfigured("key");
}
import * as systemVoices from "./system-voices.ts";
import * as windowsVoices from "./windows-voices.ts";

/** Whether this machine can speak without a key. Windows was missing before,
 *  which left a Windows owner with no voice at all on day one. */
function platformCanSpeak(): boolean {
  return systemVoices.systemVoicesAvailable() || windowsVoices.windowsVoicesAvailable();
}

export type VoiceProvider = "flux" | "xai" | "elevenlabs" | "system";

/** The voice service an agent speaks with: its own choice, else the
 *  workspace's. Each agent can have its own, so a room of agents can mix
 *  xAI, OpenAI and ElevenLabs voices. */
export function effectiveProvider(cfg: AppConfig, own?: VoiceProvider): VoiceProvider {
  return own ?? voiceProvider(cfg);
}

/** Which voice services can speak right now; the settings panel offers these. */
export function availableProviders(cfg: AppConfig): Record<VoiceProvider, boolean> {
  return { flux: hostedSpeech(), xai: xaiRoute() !== null, elevenlabs: Boolean(cfg.tts?.key), system: platformCanSpeak() };
}

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

/** An explicit choice always wins. With none, an owner who pasted an
 *  ElevenLabs key keeps it; everyone else speaks through Flux. */
export function voiceProvider(cfg: AppConfig, hosted: boolean = hostedSpeech()): VoiceProvider {
  const chosen = cfg.tts?.provider;
  if (chosen === "system" || chosen === "flux" || chosen === "elevenlabs" || chosen === "xai") return chosen;
  if (cfg.tts?.key) return "elevenlabs";
  return hosted ? "flux" : "elevenlabs";
}

/** The system provider needs no credential — it is only ever offered where
 * the platform actually has it, so "configured" means "this engine can
 * speak", not "a key is on file". */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") return platformCanSpeak();
  if (provider === "flux") return hostedSpeech();
  return Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  // Hosted speech always has a voice: an agent without one gets the default.
  if (voiceProvider(cfg) === "flux") return hostedSpeech();
  if (voiceProvider(cfg) === "system") {
    return platformCanSpeak() && Boolean(cfg.tts?.voice);
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string, own?: VoiceProvider): boolean {
  const provider = effectiveProvider(cfg, own);
  if (provider === "flux") return hostedSpeech();
  if (provider === "xai") return xaiRoute() !== null;
  if (provider === "system") {
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
    /** Which provider serves each part of a call; never a key. */
    routes: voiceRoutes(),
    /** Which voice services an agent can pick from here. */
    available: availableProviders(cfg),
  };
}

export function verifyKey(key: string) {
  return elevenlabs.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner, own?: VoiceProvider): Promise<elevenlabs.Voice[]> {
  const provider = effectiveProvider(cfg, own);
  if (provider === "flux") return fluxSpeech.FLUX_VOICES;
  if (provider === "xai") return xaiSpeech.XAI_VOICES;
  if (provider === "system") {
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
export function speak(cfg: AppConfig, written: string, voiceId?: string, run?: systemVoices.Runner, own?: VoiceProvider) {
  const text = pronounceable(written);
  const provider = effectiveProvider(cfg, own);
  if (provider === "xai") return xaiSpeech.synthesize(text, voiceId, xaiRoute());
  if (provider === "flux") {
    if (!hostedSpeech()) throw new NoVoiceConfigured("key");
    return speakHosted(text, voiceId || cfg.tts?.voice || "marin", run);
  }
  if (provider === "system") {
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
