// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The own transcription key (Sean 11-06, Settings v1): with Flux Router, or any engine that transcribes, transcription
// goes through that engine and no extra key is ever asked for or shown. A key saved by an older version stays stored and
// keeps working when nothing else transcribes, and only then shows, on Search, images and dictation in Advanced
// (standing 11-19: an optional integration is invisible unless it is used).
//
// `route` is /api/config tts.routes.transcribe: an engine name, null when none transcribes, undefined while unknown.

/** The field shows only for a saved key with no engine that transcribes; unknown hides it. */
export function showOwnTranscriptionKey(route: string | null | undefined, keySaved: boolean | null): boolean {
  return route === null && keySaved === true;
}

/** The skill recorder: the engine when one transcribes, a key saved earlier otherwise, or nothing. */
export function recorderTranscription(route: string | null | undefined, keySaved: boolean | null): "engine" | "own-key" | "none" {
  if (typeof route === "string" && route) return "engine";
  return keySaved === true ? "own-key" : "none";
}
