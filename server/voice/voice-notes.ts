// Voice notes: an answer, said in the bot's own voice, left in the chat as
// an audio message (and, from the Chief, sent on to Telegram, Slack and
// Discord by the channels).
//
// The bytes follow the generated-image path (server/output-publication.ts):
// written into a private Murage-owned folder, DATA_DIR/workspaces/<bot>/
// generated-audio/<thread>, then saved to Files as a managed output, so the
// chat's existing audio player plays it and Files keeps it. The speaking is
// the same `speak()` a call uses, with the bot's own voice service and voice.
import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

import type { AppConfig } from "../config.ts";
import { registerArtifact } from "../artifacts.ts";
import type { Store } from "../store.ts";
import type { Audio } from "../tts/elevenlabs.ts";

/** About a minute and a half of speech. Hosted voices are paid per
 *  character, and a voice note is a summary, not the whole report. */
export const VOICE_NOTE_MAX_CHARS = 1_500;
/** The one-utterance cap of the speech route is 500 characters; a note is
 *  spoken in pieces this long and joined. */
const PIECE_CHARS = 450;

const identity = /^[\w-]{1,160}$/;
const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};

/** DATA_DIR/workspaces/<bot>/generated-audio/<thread>: every component a
 *  real directory inside DATA_DIR, never a link (as for generated images). */
export function managedAudioRoot(dataDir: string, botId: string, threadId: string, create: boolean): string {
  if (!identity.test(botId) || !identity.test(threadId)) throw Object.assign(new Error("Invalid voice note workspace."), { status: 403 });
  const root = realpathSync.native(dataDir);
  let directory = root;
  for (const part of ["workspaces", botId, "generated-audio", threadId]) {
    directory = join(directory, part);
    if (create) {
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, realpathSync.native(directory))) {
      throw Object.assign(new Error("Voice note workspace is not a private directory."), { status: 403 });
    }
  }
  return directory;
}

const EXTENSIONS: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg" };

/** Text in pieces a speech service takes in one request, split at sentence
 *  ends where it can (so no piece stops mid-word). */
export function voiceNotePieces(text: string, max = PIECE_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    const at = cut > max / 3 ? cut + 1 : Math.max(window.lastIndexOf(", ") + 1, window.lastIndexOf(" "), 1);
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export interface VoiceNoteDeps {
  db: DatabaseSync;
  dataDir: string;
  store: Store;
  cfg: AppConfig;
  /** tts.speak with the bot's own voice service and voice. */
  speak: (cfg: AppConfig, text: string, voiceId?: string, run?: undefined, own?: "flux" | "xai" | "elevenlabs" | "system") => Promise<Audio>;
}

export interface VoiceNote {
  artifact: ReturnType<typeof registerArtifact>;
  messageId: string;
  mime: string;
  /** The bytes, for a channel to send on without reading Files again. */
  bytes: Buffer;
}

export class VoiceNoteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Say `text` in the bot's voice and leave it in the conversation as an audio
 * message. The transcript is the message text, so the note can be read as
 * well as heard (and found by search).
 */
export async function createVoiceNote(
  deps: VoiceNoteDeps,
  input: { botId: string; threadId: string; runId: string; text: string; title?: string },
): Promise<VoiceNote> {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new VoiceNoteError(400, "A voice note needs something to say.");
  if (text.length > VOICE_NOTE_MAX_CHARS) {
    throw new VoiceNoteError(413, `Keep a voice note under ${VOICE_NOTE_MAX_CHARS} characters (about a minute and a half); summarise and point to the chat for the rest.`);
  }
  const bot = deps.store.bot(input.botId);
  if (!bot) throw new VoiceNoteError(404, "That bot is not available.");

  // One request per piece, joined: mp3 frames concatenate into one playable
  // file. Other formats (the built-in voices' wav) are spoken in one go.
  const clips: Audio[] = [];
  for (const piece of voiceNotePieces(text)) clips.push(await deps.speak(deps.cfg, piece, bot.voice, undefined, bot.voiceProvider));
  const mime = clips[0]?.mime.split(";")[0].trim() ?? "audio/mpeg";
  if (clips.length > 1 && !clips.every((clip) => clip.mime.split(";")[0].trim() === "audio/mpeg")) {
    throw new VoiceNoteError(422, "This voice can only say a short voice note. Keep it to a few sentences.");
  }
  const extension = EXTENSIONS[mime];
  if (!extension) throw new VoiceNoteError(502, "The voice service returned audio this app cannot keep.");
  const bytes = Buffer.concat(clips.map((clip) => Buffer.from(clip.bytes)));
  if (!bytes.length) throw new VoiceNoteError(502, "The voice service returned no audio.");

  const directory = managedAudioRoot(deps.dataDir, input.botId, input.threadId, true);
  const id = randomUUID();
  const name = `${id}.${extension}`;
  const partial = join(directory, `.${id}.partial`);
  try {
    writeFileSync(partial, bytes, { mode: 0o600, flag: "wx" });
    renameSync(partial, join(directory, name));
  } catch (error) {
    try {
      unlinkSync(partial);
    } catch {}
    throw error;
  }
  const artifact = registerArtifact(
    deps.db,
    join(deps.dataDir, "artifact-files"),
    { botId: input.botId, threadId: input.threadId, relativePath: name, name: input.title?.trim().slice(0, 120) || `Voice note from ${bot.name}` },
    { owner: true, scopes: [{ botId: input.botId, botName: bot.name, threadId: input.threadId, runId: input.runId, workspaceRoot: directory, managedOutput: true }] },
    { producer: "voice-note", allowManagedOutput: true },
  );
  const message = deps.store.appendMessage(input.threadId, { role: "bot", kind: "text", text, artifactIds: [artifact.id] });
  return { artifact, messageId: message.id, mime, bytes };
}

/** At most this many voice notes per turn (per capability generation). */
export const VOICE_NOTES_PER_TURN = 3;
const perTurn = new Map<string, number>();
/** Counts one against the turn, or refuses. Old turns are forgotten. */
export function admitVoiceNote(turn: string): boolean {
  const used = perTurn.get(turn) ?? 0;
  if (used >= VOICE_NOTES_PER_TURN) return false;
  perTurn.delete(turn);
  perTurn.set(turn, used + 1);
  while (perTurn.size > 500) perTurn.delete(perTurn.keys().next().value!);
  return true;
}

/** Voice notes made in a conversation that a channel may still owe its
 *  owner: a Chief turn that came in from Telegram, Slack or Discord sends
 *  them after its text reply. Held briefly in memory only; the chat and
 *  Files keep the real copy. */
export interface PendingVoiceNote { threadId: string; at: number; name: string; mime: string; bytes: Buffer; text: string }
const pending: PendingVoiceNote[] = [];
const PENDING_MS = 30 * 60_000;

export function rememberVoiceNote(note: PendingVoiceNote): void {
  pending.push(note);
  const cutoff = Date.now() - PENDING_MS;
  while (pending.length && (pending[0]!.at < cutoff || pending.length > 50)) pending.shift();
}

/** The voice notes made in `threadId` since `since` (ms), each handed out
 *  once. */
export function takeVoiceNotes(threadId: string, since: number): PendingVoiceNote[] {
  const taken: PendingVoiceNote[] = [];
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const note = pending[i]!;
    if (note.threadId === threadId && note.at >= since) {
      taken.unshift(note);
      pending.splice(i, 1);
    }
  }
  return taken;
}
