/** Desktop reply synthesis has one immutable plan and one direct adapter invocation. */
import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import type { VoiceEndpoint } from "../voice/voice-routes.ts";
import * as flux from "./flux-speech.ts";
import * as xai from "./xai-speech.ts";
import * as eleven from "./elevenlabs.ts";
import { compileSpeechSource } from "./speech-source.ts";
import { SpeechRefusal, type ReplyState, type SpeechAccount } from "./reply-state.ts";
import type { SpeechPolicy } from "./speech-policy.ts";

type Provider = "flux" | "xai" | "elevenlabs" | "system";
export interface ReplyVoiceTarget { voice?: string; voiceProvider?: Provider }
export interface ReplyPlan extends SpeechAccount { readonly provider: "flux" | "openai" | "xai" | "elevenlabs"; readonly available: true }
export interface PreparedReply { readonly plan: ReplyPlan; readonly text: string }
export interface ReplyProviderDeps {
  config(): Pick<AppConfig, "tts">;
  speech(): readonly VoiceEndpoint[];
  xai(): xai.XaiSpeechEndpoint | null;
  state: ReplyState;
}
const digest = (parts: readonly string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export class ReplyProvider {
  private readonly invoke = new WeakMap<ReplyPlan, (text: string, policy: SpeechPolicy) => Promise<eleven.Clip>>();
  private readonly prepared = new WeakSet<PreparedReply>();
  private readonly deps: ReplyProviderDeps;
  constructor(deps: ReplyProviderDeps) { this.deps = deps; }
  resolve(target: ReplyVoiceTarget): ReplyPlan {
    const cfg = this.deps.config(), routes = this.deps.speech();
    const provider = target.voiceProvider ?? cfg.tts?.provider ?? (cfg.tts?.key ? "elevenlabs" : routes.length ? "flux" : "elevenlabs");
    if (provider === "system") throw new SpeechRefusal(409, "hosted_voice_required");
    const hosted = routes.find(route => route.via === "flux");
    const ownXai = this.deps.xai();
    let voice = target.voice || cfg.tts?.voice;
    let key: string, binding: ReplyPlan["provider"], identity: string[];
    let invoke: (text: string, policy: SpeechPolicy) => Promise<eleven.Clip>;
    if (provider === "elevenlabs") {
      key = cfg.tts?.key?.trim() ?? "";
      if (!key || !voice || !/^[A-Za-z0-9]{1,128}$/.test(voice) || flux.isFluxElevenVoice(voice)) throw new SpeechRefusal(409, "hosted_voice_required");
      const selectedVoice = voice;
      binding = "elevenlabs"; identity = [binding, selectedVoice];
      invoke = (text, policy) => eleven.synthesizeClip(text, selectedVoice, key, true, policy);
    } else if (provider === "xai" && ownXai) {
      const own = Object.freeze({ ...ownXai });
      voice ??= "eve";
      if (!own.key.trim() || !xai.isXaiVoice(voice)) throw new SpeechRefusal(409, "hosted_voice_required");
      const selectedVoice = voice;
      key = own.key.trim(); binding = "xai"; identity = [binding, own.baseUrl, selectedVoice];
      invoke = (text, policy) => xai.synthesizeClip(text, selectedVoice, own, true, fetch, policy);
    } else {
      voice ??= hosted ? "eve" : "marin";
      let selected: VoiceEndpoint | undefined;
      if (provider === "xai" || xai.isXaiVoice(voice)) {
        if (!xai.isXaiVoice(voice)) throw new SpeechRefusal(409, "hosted_voice_required");
        selected = hosted && { ...hosted, model: flux.FLUX_GROK_MODEL };
      } else if (flux.isFluxElevenVoice(voice)) selected = hosted && { ...hosted, model: flux.FLUX_ELEVEN_MODEL };
      else if (flux.isFluxVoice(voice)) selected = routes.find(route => route.via === "flux" || route.via === "openai");
      if (!selected?.key.trim() || selected.via !== "flux" && selected.via !== "openai") throw new SpeechRefusal(409, "hosted_voice_required");
      const endpoint = Object.freeze({ ...selected });
      const selectedVoice = voice;
      key = endpoint.key.trim(); binding = endpoint.via as "flux" | "openai";
      identity = [binding, endpoint.baseUrl, endpoint.model, selectedVoice];
      invoke = (text, policy) => flux.synthesizeClip(text, selectedVoice, endpoint, true, fetch, undefined, policy);
    }
    // Only the opaque random account id leaves this module. A credential fingerprint
    // recognizes the same configured binding across aliases, renames and restarts.
    const credentialVersion = digest([binding, key]);
    const account = this.deps.state.plan(this.deps.state.account(binding, credentialVersion), digest([...identity, credentialVersion]));
    const plan: ReplyPlan = Object.freeze({ ...account, provider: binding, available: true });
    this.invoke.set(plan, invoke); return plan;
  }
  prepare(target: ReplyVoiceTarget, source: string, prefix?: string): PreparedReply {
    const plan = this.resolve(target);
    const text = compileSpeechSource(source, { maxUnits: 1500, prefix });
    const prepared = Object.freeze({ plan, text }); this.prepared.add(prepared); return prepared;
  }
  /** Called synchronously after reservation and controller installation. Never retries. */
  start(prepared: PreparedReply, signal: AbortSignal): { audio: Promise<eleven.Clip>; closed: Promise<void> } {
    const invoke = this.invoke.get(prepared.plan);
    if (!invoke || !this.prepared.delete(prepared) || !prepared.text || prepared.text.length > 1500) throw new SpeechRefusal(409, "speech_unavailable");
    signal.throwIfAborted();
    const tracked: Promise<void>[] = [];
    const audio = invoke(prepared.text, { signal, attempts: 1, track: closed => tracked.push(closed) });
    const closed = audio.then(() => {}, () => {}).then(async () => { await Promise.all(tracked); });
    return { audio, closed };
  }
}
