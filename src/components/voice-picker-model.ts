// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the voice picker knows, without React: the list's order, its filters,
// the keyboard, and each row's preview. Kept pure so a node test can run it.
//
// The picker takes whatever list GET /api/tts/voices sends. Today that is
// the static FLUX_VOICES/XAI_VOICES rows; if Flux ships its own voice list,
// the server can send that instead and nothing here changes. A row needs an
// id and a label; description, gender and accent are used when present.

import type { SpeechSnapshot } from "@/lib/tts";

export interface PickerVoice {
  /** The provider's id: what is stored on the bot and sent. */
  id: string;
  /** The name Murage shows. */
  label: string;
  /** "Warm, natural, American". */
  description?: string;
  gender?: "female" | "male" | "neutral";
  /** Where a list says it outright; otherwise read from the description. */
  accent?: string;
  provider?: "openai" | "grok";
}

export type GenderFilter = "all" | "female" | "male" | "neutral";
export interface VoiceFilter {
  query: string;
  gender: GenderFilter;
  /** "all", or one of pickerFilters().accents */
  accent: string;
}

const GENDERS = ["female", "male", "neutral"] as const;
/** Accents the approved descriptions end with. A server list can name others
 *  through `accent`. */
const KNOWN_ACCENTS = new Set(["American", "British", "Australian", "Irish", "Scottish", "Indian", "Canadian", "South African", "New Zealand"]);

/** Alphabetical by the name Murage shows. */
export function sortVoices<T extends PickerVoice>(voices: T[]): T[] {
  return [...voices].sort((a, b) => a.label.localeCompare(b.label));
}

export function voiceAccent(voice: PickerVoice): string | undefined {
  if (voice.accent) return voice.accent;
  const last = voice.description?.split(",").at(-1)?.trim();
  return last && KNOWN_ACCENTS.has(last) ? last : undefined;
}

/** The filters worth showing for this list: a gender filter only when the
 *  list says genders, an accent filter only when there are two or more. */
export function pickerFilters(voices: PickerVoice[]): { genders: Array<(typeof GENDERS)[number]>; accents: string[] } {
  const genders = GENDERS.filter((g) => voices.some((v) => v.gender === g));
  const accents = [...new Set(voices.map(voiceAccent).filter((a): a is string => Boolean(a)))].sort();
  return { genders, accents: accents.length > 1 ? accents : [] };
}

export function filterVoices<T extends PickerVoice>(voices: T[], filter: VoiceFilter): T[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return voices.filter((v) => {
    if (filter.gender !== "all" && v.gender !== filter.gender) return false;
    if (filter.accent !== "all" && voiceAccent(v) !== filter.accent) return false;
    if (!words.length) return true;
    const text = `${v.label} ${v.description ?? ""} ${v.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const PAGE = 8;

/** Where a key moves the active row, or null when the key is not a move. */
export function listKey(key: string, active: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  switch (key) {
    case "ArrowDown":
      return active < 0 ? 0 : clamp(active + 1);
    case "ArrowUp":
      return active < 0 ? last : clamp(active - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown":
      return clamp(Math.max(active, 0) + PAGE);
    case "PageUp":
      return clamp(active - PAGE);
    default:
      return null;
  }
}

/** The row whose name starts with what was typed, searching on from `from`
 *  and wrapping. Typing one letter again moves on to the next name with it;
 *  a longer prefix stays put while the current name still fits. -1: none. */
export function typeAhead(voices: PickerVoice[], typed: string, from: number): number {
  const text = typed.toLowerCase();
  if (!text || !voices.length) return -1;
  const repeat = [...text].every((c) => c === text[0]);
  const prefix = repeat ? text[0]! : text;
  const start = repeat ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < voices.length; step += 1) {
    const i = (((start + step) % voices.length) + voices.length) % voices.length;
    if (voices[i]!.label.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

/** Each voice of each bot is its own preview, so a row can tell whether the
 *  speaker is playing it. The speaker plays one thing at a time. */
export function previewMessageId(botId: string, voiceId: string): string {
  return `voice-preview:${botId}:${voiceId || "default"}`;
}

/** Whether the speaker's message is one of this bot's voice previews. */
export function isVoicePreview(messageId: string | undefined, botId: string): boolean {
  return Boolean(messageId?.startsWith(`voice-preview:${botId}:`));
}

export type RowPreviewState = "idle" | "loading" | "playing" | "error";

export function rowPreview(speech: SpeechSnapshot, messageId: string): { state: RowPreviewState; error?: string } {
  if (speech.messageId !== messageId) return { state: "idle" };
  if (speech.status === "preparing") return { state: "loading" };
  if (speech.status === "speaking") return { state: "playing" };
  return speech.error ? { state: "error", error: speech.error } : { state: "idle" };
}

export function previewButton(state: RowPreviewState, name: string): { text: string; label: string } {
  if (state === "loading") return { text: "Loading", label: `Loading ${name}` };
  if (state === "playing") return { text: "Stop", label: `Stop ${name}` };
  return { text: "Play", label: `Play ${name}` };
}
