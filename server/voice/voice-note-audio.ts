// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A voice note's audio for every door (1.0.14).
//
// The desktop plays a voice note through the media resolver, which only the
// desktop may ask (server/media-assets.ts, U-04). The phone, the browser door
// and the phone app read the same conversation through doors that never see
// Files, so until now they showed the note's words and no player.
//
// This route is the conversation's own, shaped like the screen image route
// beside it: GET /api/threads/:threadId/messages/:messageId/voice-note. The
// caller is checked the way the transcript is (`mayReadThread`), and then the
// bytes are served only when ALL of these hold:
// - the message is a bot row in that very conversation,
// - it lists the saved file by id (ids come from the server, never a path),
// - the saved file belongs to that same conversation,
// - the voice-note producer made it (server/voice/voice-notes.ts),
// - its verified saved copy is intact (artifacts.ts readArtifact).
// So a door reaches the audio of a note it can already read the words of,
// and nothing else in Files. No path, name on disk or folder is ever sent.
import type { Artifact } from "../../shared/artifacts.ts";
import { VOICE_NOTE_AUDIO_MAX_BYTES, VOICE_NOTE_AUDIO_ROUTE, VOICE_NOTE_AUDIO_TYPES } from "../../shared/voice-note-audio.ts";

export { VOICE_NOTE_AUDIO_ROUTE };

const ARTIFACT_ID = /^[a-f0-9-]{36}$/;
/** As many ids as a message's card row ever reads (ArtifactCards). */
const MAX_IDS = 20;

type Described = Pick<Artifact, "producer" | "threadId" | "filename" | "savedState">;

export interface VoiceNoteAudioDeps {
  /** The stored row by id, inside this thread only. */
  message(threadId: string, messageId: string): { role?: unknown; artifactIds?: unknown } | undefined;
  /** Which conversation owns a saved file (artifacts.ts artifactOwner). */
  owner(artifactId: string): { threadId: string } | undefined;
  /** The saved file's metadata, no bytes read. Throws when it is unavailable. */
  describe(artifactId: string): Described;
  /** The saved bytes, verified against the recorded digest. Throws an error
   * carrying `status` (409 changed, 410 missing) when they cannot be served. */
  read(artifactId: string): { artifact: Described; bytes: Buffer };
}

export type VoiceNoteAudio =
  | { status: 200; mime: string; bytes: Buffer }
  | { status: 404 | 409 | 410; error: string };

const NONE = { status: 404, error: "no voice note on that message" } as const;

/** The audio type for a saved voice note's filename, or null. */
export function voiceNoteAudioType(filename: string): string | null {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return match ? VOICE_NOTE_AUDIO_TYPES[match[1]!.toLowerCase()] ?? null : null;
}

/** The voice note on one message, for a caller already allowed to read
 * `threadId`. Never throws for a missing or foreign file: those are 404. */
export function voiceNoteAudio(deps: VoiceNoteAudioDeps, threadId: string, messageId: string): VoiceNoteAudio {
  const message = deps.message(threadId, messageId);
  if (!message || message.role !== "bot" || !Array.isArray(message.artifactIds)) return NONE;
  for (const id of message.artifactIds.slice(0, MAX_IDS)) {
    if (typeof id !== "string" || !ARTIFACT_ID.test(id)) continue;
    if (deps.owner(id)?.threadId !== threadId) continue;
    let described: Described;
    try { described = deps.describe(id); } catch { continue; }
    if (described.producer !== "voice-note" || described.threadId !== threadId) continue;
    const mime = voiceNoteAudioType(described.filename);
    if (!mime) continue;
    try {
      const { artifact, bytes } = deps.read(id);
      // Read again from the row the bytes came with: a file swapped between
      // the two reads is not served under the first one's name.
      if (artifact.producer !== "voice-note" || artifact.threadId !== threadId || voiceNoteAudioType(artifact.filename) !== mime) return NONE;
      if (!bytes.length || bytes.length > VOICE_NOTE_AUDIO_MAX_BYTES) return NONE;
      return { status: 200, mime, bytes };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 409) return { status: 409, error: "This voice note changed and cannot be played." };
      if (status === 410) return { status: 410, error: "This voice note is no longer available." };
      return NONE;
    }
  }
  return NONE;
}
