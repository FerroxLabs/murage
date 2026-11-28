// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** G4: the voice scope the Settings page reads. One function answers "who speaks for this bot and can it right now" from the same
 * helpers the speaker uses, so the page never invents a state the server would not act on. Never includes a key. */
import type { AppConfig } from "../config.ts";
import { effectiveProvider, voiceReady, type VoiceProvider } from "./index.ts";

export interface VoiceScope { provider: VoiceProvider; source: "bot" | "app"; voice: string; ready: boolean }
type BotVoice = { voice?: string; voiceProvider?: VoiceProvider };

export function voiceScopeFor(cfg: AppConfig, bot: BotVoice | undefined): VoiceScope {
  const own = bot?.voiceProvider;
  return {
    provider: effectiveProvider(cfg, own),
    source: own ? "bot" : "app",
    voice: bot?.voice ?? cfg.tts?.voice ?? "",
    ready: voiceReady(cfg, bot?.voice, own),
  };
}
