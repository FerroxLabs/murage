// A voice note's audio on a door that is not the desktop: the phone, the
// browser door and the phone app (1.0.14).
//
// The desktop plays a note through the media resolver, which only the desktop
// may ask. Every other door reads the note from the conversation's own route
// (shared/voice-note-audio.ts), which the harness answers only for a caller
// that may read that conversation, and only for a voice note the message
// lists. The bytes are fetched once and played from a blob made here, for
// three reasons: an <audio src> cannot carry a door's credential the way a
// fetch does, the door does not pass byte ranges (which iPhone Safari asks an
// <audio src> for), and play() on an iPhone must start in the tap itself, so
// the audio has to be ready before the tap.
import { VOICE_NOTE_AUDIO_MAX_BYTES, VOICE_NOTE_AUDIO_TYPES, voiceNoteAudioPath } from "../../shared/voice-note-audio";

/** What the conversation route answered for one message.
 * - `audio`: a voice note, ready to play.
 * - `unavailable`: a voice note whose saved copy is missing or changed; the
 *   player shows, but cannot play.
 * - `none`: not a voice note (another saved file, or nothing): no player. */
export type RemoteVoiceNote = { status: "audio"; blob: Blob } | { status: "unavailable" } | { status: "none" };

const PLAYABLE = new Set(Object.values(VOICE_NOTE_AUDIO_TYPES));

/** The answer for one response's status and type, before any body is read.
 * Pure, so the rule is tested without a network. */
export function remoteVoiceNoteVerdict(status: number, contentType: string | null): "read" | "unavailable" | "none" {
  if (status === 409 || status === 410) return "unavailable";
  if (status !== 200) return "none";
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return PLAYABLE.has(type) ? "read" : "none";
}

/** Fetch one message's voice note. Never throws for a refusal; an abort
 * rejects as fetch does. */
export async function fetchRemoteVoiceNote(
  threadId: string,
  messageId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RemoteVoiceNote> {
  const response = await fetcher(voiceNoteAudioPath(threadId, messageId), { redirect: "error", cache: "no-store", credentials: "same-origin", ...(signal ? { signal } : {}) });
  const verdict = remoteVoiceNoteVerdict(response.status, response.headers.get("content-type"));
  if (verdict !== "read") return { status: verdict };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > VOICE_NOTE_AUDIO_MAX_BYTES) return { status: "none" };
  const blob = await response.blob();
  if (!blob.size || blob.size > VOICE_NOTE_AUDIO_MAX_BYTES) return { status: "none" };
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return { status: "audio", blob: blob.type === type ? blob : new Blob([blob], { type }) };
}
