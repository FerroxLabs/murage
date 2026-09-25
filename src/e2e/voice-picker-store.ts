// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stands in for "@/state/store" in voice-picker.human.spec.ts: the real
// VoiceSettings reads the workspace's voice setup from the store and lists
// voices with api(). Everything else on the page (the picker, the speaker,
// its /api/tts requests) is the real code; the spec's server answers those.
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) } });
  return res.json();
}

const state = {
  config: {
    tts: {
      provider: "flux",
      configured: true,
      available: { flux: true, xai: false, elevenlabs: false },
      routes: { speech: "flux" },
    },
  },
};

export function useStore() {
  return { state, dispatch: () => {} };
}
