// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The options inside a bot's voice picker. Flux's list mixes OpenAI's and
// xAI's voices, so it is grouped by how each voice sounds and each option
// says whose it is. A list that carries no gender (ElevenLabs, the built-in
// voices) stays flat, as before.

export interface PickerVoice {
  id: string;
  label: string;
  description?: string;
  gender?: "female" | "male" | "neutral";
  provider?: "openai" | "grok";
}

const GROUPS = [
  { gender: "female", label: "Female" },
  { gender: "male", label: "Male" },
  { gender: "neutral", label: "Neutral" },
] as const;
const PROVIDER = { openai: "OpenAI", grok: "Grok" } as const;

/** Female, Male, Neutral, each alphabetical; empty groups are left out. */
export function voiceGroups(voices: PickerVoice[]) {
  return GROUPS.map(({ gender, label }) => ({
    label,
    voices: voices.filter((v) => v.gender === gender).sort((a, b) => a.label.localeCompare(b.label)),
  })).filter((group) => group.voices.length > 0);
}

/** "Nova, upbeat and energetic (OpenAI)"; the provider only where the list
 *  mixes two. */
export function voiceOptionText(voice: PickerVoice, showProvider: boolean): string {
  const text = voice.description ? `${voice.label}, ${voice.description}` : voice.label;
  return showProvider && voice.provider ? `${text} (${PROVIDER[voice.provider]})` : text;
}

export function VoiceOptions({ voices }: { voices: PickerVoice[] }) {
  const showProvider = new Set(voices.map((v) => v.provider).filter(Boolean)).size > 1;
  const option = (v: PickerVoice) => (
    <option key={v.id} value={v.id}>
      {voiceOptionText(v, showProvider)}
    </option>
  );
  if (!voices.some((v) => v.gender)) return <>{voices.map(option)}</>;
  const ungrouped = voices.filter((v) => !v.gender);
  return (
    <>
      {voiceGroups(voices).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.voices.map(option)}
        </optgroup>
      ))}
      {ungrouped.map(option)}
    </>
  );
}

/** What the Try button says while a voice sample is made and played. */
export function tryButtonState(status: "idle" | "preparing" | "speaking"): { text: string; label: string } {
  if (status === "preparing") return { text: "Loading", label: "Loading this voice" };
  if (status === "speaking") return { text: "Stop", label: "Stop playing this voice" };
  return { text: "Try", label: "Hear this voice" };
}
