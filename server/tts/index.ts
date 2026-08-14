// Voice registry — the static array is the whole thing (drivers/builtIn.ts
// is the model). Adding a voice provider is one file plus one line here.
import type { AppConfig } from "../config.ts";
import { CartesiaProvider } from "./cartesia.ts";
import { ElevenLabsProvider } from "./elevenlabs.ts";
import { KokoroProvider } from "./kokoro.ts";
import type { TtsProvider, TtsVoice, VerifyResult } from "./types.ts";

export const BUILT_IN_VOICE_PROVIDERS: readonly TtsProvider[] = [
  KokoroProvider,
  ElevenLabsProvider,
  CartesiaProvider,
];

/** The voice used when nothing is configured: the local one, so a fresh
 * install can speak before it has been given anything. */
export const DEFAULT_PROVIDER_ID = KokoroProvider.id;

export function voiceProvider(id: string | undefined): TtsProvider | null {
  return BUILT_IN_VOICE_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The provider a turn should actually use, honouring config and falling
 * back to local rather than failing — a missing key must never mean
 * silence when a working voice is sitting right there. */
export function activeProvider(cfg: AppConfig): TtsProvider {
  const chosen = voiceProvider(cfg.tts?.provider);
  if (!chosen) return KokoroProvider;
  if (chosen.needsKey && !cfg.tts?.key) return KokoroProvider;
  return chosen;
}

/** Provider list for the settings panel. Never includes the key itself —
 * the same write-only rule the rest of /api/config follows. */
export function describeProviders(cfg: AppConfig) {
  const active = activeProvider(cfg);
  return {
    provider: cfg.tts?.provider ?? DEFAULT_PROVIDER_ID,
    effectiveProvider: active.id,
    voice: cfg.tts?.voice ?? "",
    configured: Boolean(cfg.tts?.key),
    providers: BUILT_IN_VOICE_PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      runsOn: p.runsOn,
      needsKey: p.needsKey,
      blurb: p.blurb,
    })),
  };
}

export async function verifyVoiceKey(providerId: string, key: string): Promise<VerifyResult> {
  const provider = voiceProvider(providerId);
  if (!provider) return { ok: false, message: `unknown voice provider "${providerId}"` };
  if (!provider.needsKey) return { ok: true };
  if (!provider.verifyKey) return { ok: true };
  return provider.verifyKey(key);
}

export async function listVoices(cfg: AppConfig): Promise<TtsVoice[]> {
  const provider = voiceProvider(cfg.tts?.provider) ?? KokoroProvider;
  if (!provider.listVoices) return [];
  const key = cfg.tts?.key ?? "";
  if (provider.needsKey && !key) return [];
  return provider.listVoices(key);
}

export class ClientSideVoice extends Error {
  // a plain field, not a constructor parameter property: the harness runs
  // under `node --experimental-strip-types`, which is strip-ONLY — a
  // parameter property has to emit an assignment, so it is rejected at
  // load time even though it typechecks
  readonly providerId: string;

  constructor(providerId: string) {
    super(`"${providerId}" is synthesized in the app, not the harness`);
    this.providerId = providerId;
  }
}

/** Synthesize one utterance with the configured provider.
 *
 * Throws ClientSideVoice when the active provider runs in the renderer —
 * the route turns that into a 409 the client understands as "you own this
 * one", which keeps the decision in ONE place (here) rather than letting
 * client and server disagree about who speaks. */
export async function speak(cfg: AppConfig, text: string, voiceId?: string) {
  const provider = activeProvider(cfg);
  if (provider.runsOn === "client" || !provider.synthesize) throw new ClientSideVoice(provider.id);
  return provider.synthesize({
    text,
    voiceId: voiceId || cfg.tts?.voice,
    key: cfg.tts?.key ?? "",
    options: cfg.tts?.options,
  });
}

export type { TtsProvider, TtsVoice } from "./types.ts";
