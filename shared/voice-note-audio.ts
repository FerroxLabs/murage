// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The conversation route that serves one voice note's audio to every door
// (server/voice/voice-note-audio.ts serves it; src/lib/voice-note-audio.ts
// asks for it). Shared so the two can never spell it differently.

/** The route, anchored. Group 1 is the thread id, group 2 the message id. */
export const VOICE_NOTE_AUDIO_ROUTE = /^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/voice-note$/;

/** The path a client asks for one message's voice note. */
export const voiceNoteAudioPath = (threadId: string, messageId: string): string =>
  `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/voice-note`;

/** The audio types a voice note is kept and served as. A closed list: the
 * server names the type from it and the client plays nothing else. */
export const VOICE_NOTE_AUDIO_TYPES: Readonly<Record<string, string>> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };

/** The largest voice note a door is sent or a client keeps (a note is under
 * about a minute and a half of speech, well under 4 MB). */
export const VOICE_NOTE_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
