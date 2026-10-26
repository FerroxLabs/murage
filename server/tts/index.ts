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
import { clearUnavailable, isUnavailable, markUnavailable, resetUnavailable, type VoiceEndpoint, type VoicePart } from "../voice/voice-routes.ts";

/** Where hosted speech runs (Flux, or an own OpenAI key) and which provider
 *  serves each part of a call. Injected by the harness, which owns the model
 *  connections; nothing here reads a key from config itself. */
let speechRoutes: () => VoiceEndpoint[] = () => [];
let voiceRoutes: () => Record<VoicePart, string | null> | null = () => null;
let xaiRoute: () => xaiSpeech.XaiSpeechEndpoint | null = () => null;
let streamRoute: () => boolean = () => false;
export function useVoiceRoutes(routes: {
  speech: () => VoiceEndpoint[];
  describe: () => Record<VoicePart, string | null>;
  /** An owner's own xAI key, for xAI's voices. */
  xai?: () => xaiSpeech.XaiSpeechEndpoint | null;
  /** Streaming transcription is on and a Flux key is present. */
  stream?: () => boolean;
}) {
  speechRoutes = routes.speech;
  voiceRoutes = routes.describe;
  xaiRoute = routes.xai ?? (() => null);
  streamRoute = routes.stream ?? (() => false);
  resetUnavailable();
  resetElevenCatalog();
}
/** What speaks when no voice was chosen at all (xAI's own default). */
export const DEFAULT_GROK_VOICE = "eve";
const hostedSpeech = () => speechRoutes().length > 0;
/** xAI's voices through Flux, for an owner with a Flux key and no xAI key of
 *  their own. Null when Flux does not serve speech here. */
function fluxGrokRoute(): VoiceEndpoint | null {
  const flux = speechRoutes().find((route) => route.via === "flux");
  return flux ? { ...flux, model: fluxSpeech.FLUX_GROK_MODEL } : null;
}
const xaiVoicesAvailable = () => xaiRoute() !== null || fluxGrokRoute() !== null;

/** ElevenLabs' voices through Flux (flux-voice-speak-eleven), on the Flux
 *  key alone: no ElevenLabs key of the owner's own. Null without Flux. */
function fluxElevenRoute(): VoiceEndpoint | null {
  const flux = speechRoutes().find((route) => route.via === "flux");
  return flux ? { ...flux, model: fluxSpeech.FLUX_ELEVEN_MODEL } : null;
}

/** Flux's own voice list (GET /v1/audio/voices, never billed, filtered to
 *  the calling key) decides whether ElevenLabs' voices are offered. Read when
 *  the picker opens, kept for ten minutes per Flux key, and read again at
 *  once by `recheckFluxEleven` (the picker's "Check again") so a key fixed at
 *  Flux shows up without the wait. The speech call's 403 stays the backstop. */
const ELEVEN_CATALOG_MS = 10 * 60_000;
let elevenCatalog: { source: string; at: number; value: fluxSpeech.ElevenCatalog } | null = null;
let elevenCatalogRead: { source: string; promise: Promise<fluxSpeech.ElevenCatalog | null> } | null = null;
const catalogSource = (route: VoiceEndpoint) => `${route.baseUrl} ${route.key}`;
function resetElevenCatalog(): void {
  elevenCatalog = null;
  elevenCatalogRead = null;
}
/** The last list Flux sent for this key, while it is fresh. */
function knownElevenCatalog(route: VoiceEndpoint, now = Date.now()): fluxSpeech.ElevenCatalog | null {
  const cached = elevenCatalog;
  return cached && cached.source === catalogSource(route) && now - cached.at < ELEVEN_CATALOG_MS ? cached.value : null;
}
function readElevenCatalog(route: VoiceEndpoint, fresh: boolean): Promise<fluxSpeech.ElevenCatalog | null> {
  const source = catalogSource(route);
  if (!fresh) {
    const known = knownElevenCatalog(route);
    if (known) return Promise.resolve(known);
  }
  if (elevenCatalogRead?.source === source) return elevenCatalogRead.promise;
  const promise = fluxSpeech.readElevenCatalog(route).then((value) => {
    if (value) elevenCatalog = { source, at: Date.now(), value };
    else if (elevenCatalog?.source !== source) elevenCatalog = null;
    // an unreadable list keeps the last good answer for this key while it is
    // still fresh; the list and fluxElevenStatus read the same answer
    return value ?? knownElevenCatalog(route);
  });
  elevenCatalogRead = { source, promise };
  void promise.finally(() => {
    if (elevenCatalogRead?.promise === promise) elevenCatalogRead = null;
  });
  return promise;
}

export type FluxElevenStatus = fluxSpeech.ElevenOnKey | "unchecked" | "none";

/** Whether the Flux list carries ElevenLabs' voices: "on" when Flux's voice
 *  list returned them as playable for this key; "notOnKey" when the list left
 *  them out, or a speech call answered 403 model_not_allowed; "locked" when
 *  the list marked them premium_locked; "unchecked" while the list could not
 *  be read (none shown); "none" without a Flux key. */
export function fluxElevenStatus(): FluxElevenStatus {
  const route = fluxElevenRoute();
  if (!route) return "none";
  if (isUnavailable(route)) return "notOnKey";
  return knownElevenCatalog(route)?.status ?? "unchecked";
}

/** "Check again" in the picker: forget a 403 and the cached list for the
 *  ElevenLabs model, then ask Flux's voice list now. */
export async function recheckFluxEleven(): Promise<FluxElevenStatus> {
  const route = fluxElevenRoute();
  if (!route) return "none";
  clearUnavailable(route);
  await readElevenCatalog(route, true);
  return fluxElevenStatus();
}

/** The ElevenLabs rows for the Flux list: only the names Flux listed as
 *  playable on this key. */
async function fluxElevenVoices(): Promise<elevenlabs.Voice[]> {
  const route = fluxElevenRoute();
  if (!route || isUnavailable(route)) return [];
  const catalog = await readElevenCatalog(route, false);
  if (!catalog || catalog.status !== "on" || isUnavailable(route)) return [];
  return fluxSpeech.FLUX_ELEVEN_VOICES.filter((v) => catalog.names.has(v.id));
}

/** An ElevenLabs voice picked from the Flux list: always Flux's ElevenLabs
 *  model. When Flux will not speak it (the key may not use the model, the
 *  account has it locked, or the name left Flux's list), a call keeps talking
 *  in the Flux list's default voice rather than going silent. A preview is
 *  `exact`: it says why instead, since a sample in some other voice would
 *  answer a question nobody asked. */
async function speakFluxEleven(text: string, voice: string, run: systemVoices.Runner | undefined, streamed: boolean, exact: boolean): Promise<elevenlabs.Clip> {
  const flux = fluxElevenRoute();
  if (!flux) {
    // hosted speech on an own OpenAI key: no Flux to reach these voices
    if (exact) throw new Error("ElevenLabs voices in this list speak through Flux. Add a Flux key in Settings to hear them.");
    return speakHosted(text, voice, run, streamed);
  }
  // what Flux's voice list already said for this key, when it has been read
  const known = knownElevenCatalog(flux);
  if (isUnavailable(flux) || known?.status === "notOnKey") {
    if (exact) throw new fluxSpeech.ElevenNotOnKey(fluxSpeech.ELEVEN_NOT_ON_KEY);
  } else if (known?.status === "locked") {
    if (exact) throw new fluxSpeech.ElevenNotOnKey(fluxSpeech.ELEVEN_LOCKED);
  } else if (known && !known.names.has(voice)) {
    if (exact) throw new fluxSpeech.ElevenVoiceNotOffered(`Flux no longer offers the ElevenLabs voice ${voice}. Pick another voice.`);
  } else {
    try {
      return await fluxSpeech.synthesizeClip(text, voice, flux, streamed);
    } catch (error) {
      if (error instanceof fluxSpeech.ElevenNotOnKey) markUnavailable(flux);
      else if (!(error instanceof fluxSpeech.ElevenRefused)) throw error;
      if (exact) throw error;
    }
  }
  // the rest of the Flux list, in its own default voice
  return speakFluxGrok(text, DEFAULT_GROK_VOICE, run, streamed);
}

/** xAI's voices: on the owner's own xAI key when there is one, else on
 *  their Flux key through Flux's xAI alias. */
async function speakXai(text: string, voice: string | undefined, streamed: boolean): Promise<elevenlabs.Clip> {
  const own = xaiRoute();
  const flux = own ? null : fluxGrokRoute();
  if (!flux || isUnavailable(flux)) return xaiSpeech.synthesizeClip(text, voice, own, streamed);
  try {
    return await fluxSpeech.synthesizeClip(text, voice ?? DEFAULT_GROK_VOICE, flux, streamed);
  } catch (error) {
    if (error instanceof fluxSpeech.SpeechUnavailable) markUnavailable(flux);
    throw error;
  }
}

/** A Grok voice picked from the Flux list: always Flux's xAI alias, since
 *  that is where the list said it comes from. If Flux will not speak it,
 *  an own xAI key takes over, else the Flux list's other voices do. */
async function speakFluxGrok(text: string, voice: string, run: systemVoices.Runner | undefined, streamed: boolean): Promise<elevenlabs.Clip> {
  const flux = fluxGrokRoute();
  if (flux && !isUnavailable(flux)) {
    try {
      return await fluxSpeech.synthesizeClip(text, voice, flux, streamed);
    } catch (error) {
      if (!(error instanceof fluxSpeech.SpeechUnavailable)) throw error;
      markUnavailable(flux);
    }
  }
  const own = xaiRoute();
  if (own) return xaiSpeech.synthesizeClip(text, voice, own, streamed);
  return speakHosted(text, voice, run, streamed);
}

/** Hosted speech, one source after another. When every source refuses as
 *  not switched on, the computer's own voice speaks rather than nothing:
 *  a call that goes silent looks broken, and a plainer voice does not. */
async function speakHosted(text: string, voice: string, run: systemVoices.Runner | undefined, streamed: boolean): Promise<elevenlabs.Clip> {
  let refused: Error | null = null;
  for (const route of speechRoutes()) {
    if (isUnavailable(route)) continue;
    try {
      return await fluxSpeech.synthesizeClip(text, voice, route, streamed);
    } catch (error) {
      if (!(error instanceof fluxSpeech.SpeechUnavailable)) throw error;
      markUnavailable(route);
      refused = error;
    }
  }
  if (platformCanSpeak() || run) {
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.synthesizeWindows(text, undefined)
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
  return { flux: hostedSpeech(), xai: xaiVoicesAvailable(), elevenlabs: Boolean(cfg.tts?.key), system: platformCanSpeak() };
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
        : "Pick a voice in the bot's settings.",
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
  if (provider === "xai") return xaiVoicesAvailable();
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
    /** Whether the page may open a streaming transcription call. */
    streamTranscribe: streamRoute(),
    /** Which voice services an agent can pick from here. */
    available: availableProviders(cfg),
    /** An xAI key of the owner's own. Without one, xAI's voices sit in the
     *  Flux list instead of an engine of their own. */
    xaiKey: xaiRoute() !== null,
  };
}

export function verifyKey(key: string) {
  return elevenlabs.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner, own?: VoiceProvider): Promise<elevenlabs.Voice[]> {
  const provider = effectiveProvider(cfg, own);
  // One Flux list: OpenAI's voices, plus xAI's through Flux's xAI alias
  // when Flux itself is connected (an own OpenAI key cannot reach them).
  // Grok voices lead the list, since they are what a bot starts with.
  // ElevenLabs' voices follow, through Flux's ElevenLabs model, when Flux's
  // voice list for this key returns them as playable (fluxElevenStatus tells
  // the picker why when it does not).
  if (provider === "flux") {
    return [
      ...(fluxGrokRoute() ? xaiSpeech.XAI_VOICES : []),
      ...fluxSpeech.FLUX_VOICES,
      ...(await fluxElevenVoices()),
    ];
  }
  if (provider === "xai") return xaiSpeech.XAI_VOICES;
  if (provider === "system") {
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.listWindowsVoices()
      : systemVoices.listSystemVoices(run);
  }
  const key = cfg.tts?.key;
  if (!key) return [];
  return elevenlabs.listVoices(key);
}

/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg: AppConfig, written: string, voiceId?: string, run?: systemVoices.Runner, own?: VoiceProvider): Promise<elevenlabs.Audio> {
  return speakClip(cfg, written, voiceId, run, own, false) as Promise<elevenlabs.Audio>;
}

/** speak(), with the audio handed on as it arrives where the service sends
 *  it that way (Flux, OpenAI, xAI, ElevenLabs); the built-in voices still
 *  come as one clip. The call screen starts playing on the first bytes. */
export function speakStreamed(cfg: AppConfig, written: string, voiceId?: string, own?: VoiceProvider, opts: SpeakOptions = {}): Promise<elevenlabs.Clip> {
  return speakClip(cfg, written, voiceId, undefined, own, true, opts);
}

export interface SpeakOptions {
  /** A voice sample from the picker: speak exactly this voice or say why
   *  not, never stand in another voice for it. */
  preview?: boolean;
}

function speakClip(cfg: AppConfig, written: string, voiceId: string | undefined, run: systemVoices.Runner | undefined, own: VoiceProvider | undefined, streamed: boolean, opts: SpeakOptions = {}): Promise<elevenlabs.Clip> {
  const text = pronounceable(written);
  const provider = effectiveProvider(cfg, own);
  // A Grok voice on a bot with no service of its own is the default the app
  // assigned (bot-voice.ts). It belongs to the Flux list, so where the
  // workspace speaks another way (an own ElevenLabs key, the built-in
  // voices) it is set aside and that way speaks as it always did.
  if (!own && (provider === "elevenlabs" || provider === "system") && xaiSpeech.isXaiVoice(voiceId)) voiceId = undefined;
  // Same for Flux's ElevenLabs voices: a name, which an own ElevenLabs key
  // (raw voice ids) or a built-in voice would not know.
  if ((provider === "elevenlabs" || provider === "system") && fluxSpeech.isFluxElevenVoice(voiceId)) voiceId = undefined;
  if (provider === "xai") return speakXai(text, voiceId, streamed);
  if (provider === "flux") {
    if (!hostedSpeech()) throw new NoVoiceConfigured("key");
    // no voice chosen anywhere: Flux's Grok default where Flux serves it,
    // else the OpenAI default
    const voice = voiceId || cfg.tts?.voice || (fluxGrokRoute() ? DEFAULT_GROK_VOICE : "marin");
    // ids never collide between the three lists, so the voice says which
    if (xaiSpeech.isXaiVoice(voice)) return speakFluxGrok(text, voice, run, streamed);
    if (fluxSpeech.isFluxElevenVoice(voice)) return speakFluxEleven(text, voice, run, streamed, Boolean(opts.preview));
    return speakHosted(text, voice, run, streamed);
  }
  if (provider === "system") {
    const voice = voiceId || cfg.tts?.voice;
    // An injected runner is the cross-platform test seam for the two native
    // binaries; production calls omit it and stay strictly platform-gated.
    if (!platformCanSpeak() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return windowsVoices.windowsVoicesAvailable()
      ? windowsVoices.synthesizeWindows(text, voice)
      : systemVoices.synthesizeSystem(text, voice, run);
  }
  const key = cfg.tts?.key;
  if (!key) throw new NoVoiceConfigured("key");
  // a workspace voice saved from the Flux list is a name an own key would not know
  const workspaceVoice = fluxSpeech.isFluxElevenVoice(cfg.tts?.voice) ? undefined : cfg.tts?.voice;
  const voice = voiceId || workspaceVoice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesizeClip(text, voice, key, streamed);
}

export type { Voice, Audio, Clip, StreamedAudio } from "./elevenlabs.ts";

/**
 * Time one clip for the harness log: headers are when the service answered
 * (this is called as speakStreamed resolves), first audio is the first chunk
 * out of a streamed body (a whole-bytes clip has both at once). Logs once,
 * numbers and the provider's name only, never the words.
 */
export function timedClip(
  clip: elevenlabs.Clip,
  startedAt: number,
  log: (line: string) => void,
  info: { length: number; via: string },
): elevenlabs.Clip {
  const headersMs = Date.now() - startedAt;
  let logged = false;
  const emit = () => {
    if (logged) return;
    logged = true;
    const firstAudioMs = "bytes" in clip ? headersMs : Date.now() - startedAt;
    log(`[tts] speak timing: headers ${headersMs} ms, first audio ${firstAudioMs} ms, length ${info.length}, via ${info.via}`);
  };
  if ("bytes" in clip) {
    emit();
    return clip;
  }
  const reader = clip.stream.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      emit();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      // cancelled before any audio: there is no first audio to report
      return reader.cancel(reason);
    },
  });
  return { stream, mime: clip.mime };
}
