// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Transcription for a voice note that arrived through a chat channel (WhatsApp first). It is the same path as the
// push-to-talk route: the same `transcribe()`, the same container allowlist, the same 4 MB clip cap and the same
// process-wide `VoiceBudget`, which the route keeps and this file draws on. A channel is therefore never a way
// around the hourly allowance. Failures come back as values so the caller can say one honest sentence.
import { BILLED_SECONDS_FLOOR, MAX_CLIP_BYTES, containerOf, estimateBilledSeconds, filenameFor, processBudget, type VoiceBudget } from "./transcribe-route.ts";
import { TranscriptionUnavailable, transcribe as transcribeWithFlux, type Transcript, type TranscribeOptions } from "./flux-voice.ts";

export type ChannelTranscript =
  | { ok: true; text: string }
  | { ok: false; reason: "unconfigured" | "busy" | "too-large" | "format" | "failed" | "empty" };

export interface ChannelTranscribeDeps {
  /** Production passes the route's endpoint choice (Flux, or the owner's own Groq or OpenAI key). */
  transcribe?: (recording: { bytes: Uint8Array; filename: string; mime?: string }, options?: TranscribeOptions) => Promise<Transcript>;
  budget?: VoiceBudget;
  options?: TranscribeOptions;
}

export async function transcribeChannelClip(clip: { bytes: Uint8Array; mime: string }, deps: ChannelTranscribeDeps = {}): Promise<ChannelTranscript> {
  if (clip.bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (clip.bytes.byteLength > MAX_CLIP_BYTES) return { ok: false, reason: "too-large" };
  const container = containerOf(clip.mime);
  const filename = container ? filenameFor(container) : null;
  if (!container || !filename) return { ok: false, reason: "format" };
  const slot = (deps.budget ?? processBudget).begin();
  if (!slot.ok) return { ok: false, reason: "busy" };
  try {
    const transcript = await (deps.transcribe ?? transcribeWithFlux)({ bytes: clip.bytes, filename, mime: container }, deps.options);
    slot.done(transcript.billedSeconds ?? (transcript.duration === undefined ? estimateBilledSeconds(clip.bytes.byteLength) : Math.max(BILLED_SECONDS_FLOOR, Math.ceil(transcript.duration))));
    const text = transcript.text.trim();
    return text ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch (error) {
    // A refusal before anything was sent costs nothing; anything else is charged at the estimate, the same rule as the route.
    slot.done(error instanceof TranscriptionUnavailable && (error.reason === "key" || error.reason === "format" || error.reason === "too_large") ? 0 : estimateBilledSeconds(clip.bytes.byteLength));
    if (error instanceof TranscriptionUnavailable && error.reason === "key") return { ok: false, reason: "unconfigured" };
    return { ok: false, reason: "failed" };
  }
}
