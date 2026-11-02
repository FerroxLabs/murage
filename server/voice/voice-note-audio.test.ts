// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A voice note plays on every door (1.0.14): the conversation route serves a
// note's audio to a caller that may read the conversation, and nothing else
// in Files. Proved on the real artifact store with real voice notes, the way
// server/index.ts wires it (host access scoped to the one saved file's own
// conversation, after the message and owner checks).
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { artifactOwner, describeArtifact, initializeArtifacts, readArtifact, registerArtifact, type ArtifactScope } from "../artifacts.ts";
import type { AppConfig } from "../config.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { VOICE_NOTE_AUDIO_ROUTE, voiceNoteAudioPath } from "../../shared/voice-note-audio.ts";
import { voiceNoteAudio, voiceNoteAudioType, type VoiceNoteAudioDeps } from "./voice-note-audio.ts";
import { createVoiceNote, managedAudioOutputPath, type VoiceNoteDeps } from "./voice-notes.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

const BOTS: Record<string, { id: string; name: string; voice: string; voiceProvider: "xai" }> = {
  "bot-1": { id: "bot-1", name: "Ember", voice: "eve", voiceProvider: "xai" },
  "bot-2": { id: "bot-2", name: "Sable", voice: "eve", voiceProvider: "xai" },
};

function fixture(mime = "audio/mpeg") {
  const dataDir = mkdtempSync(join(tmpdir(), "murage-voice-audio-"));
  roots.push(dataDir);
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  databases.push(db);
  initializeArtifacts(db);
  const messages: Array<{ id: string; threadId: string; role?: unknown; artifactIds?: unknown; [field: string]: unknown }> = [];
  const store = {
    bot: (id: string) => BOTS[id],
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const saved = { id: `m${messages.length + 1}`, threadId, ...message };
      messages.push(saved);
      return saved;
    },
  };
  const deps: VoiceNoteDeps = {
    db, dataDir, store: store as unknown as VoiceNoteDeps["store"], cfg: {} as AppConfig,
    speak: async (_cfg, text) => ({ bytes: new TextEncoder().encode(`AUDIO[${text}]`), mime }),
  };
  const storageRoot = join(dataDir, "artifact-files");
  // The scopes server/index.ts artifactScopes(owner) builds for a voice note.
  const scopesFor = (id: string): ArtifactScope[] => {
    const owner = artifactOwner(db, id);
    if (!owner) return [];
    const bot = BOTS[owner.botId]!;
    return [{ botId: bot.id, botName: bot.name, threadId: owner.threadId, workspaceRoot: managedAudioOutputPath(dataDir, bot.id, owner.threadId), managedOutput: true }];
  };
  const audioDeps: VoiceNoteAudioDeps = {
    message: (threadId, messageId) => messages.find((message) => message.threadId === threadId && message.id === messageId),
    owner: (id) => artifactOwner(db, id),
    describe: (id) => describeArtifact(db, storageRoot, id, { owner: true, scopes: scopesFor(id) }),
    read: (id) => readArtifact(db, storageRoot, id, { owner: true, scopes: scopesFor(id) }),
  };
  return { deps, db, dataDir, storageRoot, messages, audioDeps };
}

describe("voice note audio for every door", () => {
  it("serves the note's own audio, typed from a closed list, with no path, name or folder in the answer", async () => {
    const f = fixture();
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Morning, boss." });
    const answer = voiceNoteAudio(f.audioDeps, "thread-1", note.messageId);
    expect(answer.status).toBe(200);
    if (answer.status !== 200) return;
    expect(answer.mime).toBe("audio/mpeg");
    expect(answer.bytes.toString()).toBe("AUDIO[Morning, boss.]");
    expect(Object.keys(answer).sort()).toEqual(["bytes", "mime", "status"]);
  });

  it("a wav voice is served as wav", async () => {
    const f = fixture("audio/wav");
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Hi." });
    expect(voiceNoteAudio(f.audioDeps, "thread-1", note.messageId)).toMatchObject({ status: 200, mime: "audio/wav" });
  });

  it("asked through another conversation, the same message is not found", async () => {
    const f = fixture();
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Mine." });
    expect(voiceNoteAudio(f.audioDeps, "thread-2", note.messageId).status).toBe(404);
  });

  it("a message in a readable conversation that lists another conversation's voice note gets nothing", async () => {
    const f = fixture();
    const foreign = await createVoiceNote(f.deps, { botId: "bot-2", threadId: "thread-secret", runId: "run-9", text: "Not for you." });
    // A row the reader may see, pointing at a saved file it may not.
    f.messages.push({ id: "planted", threadId: "thread-1", role: "bot", kind: "text", text: "look", artifactIds: [foreign.artifact.id] });
    expect(voiceNoteAudio(f.audioDeps, "thread-1", "planted").status).toBe(404);
  });

  it("another saved file on a message is never served, even in the same conversation", async () => {
    const f = fixture();
    const folder = managedAudioOutputPath(f.dataDir, "bot-1", "thread-1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "report.mp3"), "NOT A NOTE");
    // Registered by something other than the voice-note producer.
    const other = registerArtifact(f.db, f.storageRoot, { botId: "bot-1", threadId: "thread-1", relativePath: "report.mp3", name: "report" },
      { owner: true, scopes: [{ botId: "bot-1", botName: "Ember", threadId: "thread-1", runId: "run-1", workspaceRoot: folder, managedOutput: true }] }, { allowManagedOutput: true });
    f.messages.push({ id: "file-row", threadId: "thread-1", role: "bot", kind: "text", text: "Saved file: report", artifactIds: [other.id] });
    expect(voiceNoteAudio(f.audioDeps, "thread-1", "file-row").status).toBe(404);
  });

  it("only a bot row carries a voice note; a user row that names one is ignored", async () => {
    const f = fixture();
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Hi." });
    f.messages.push({ id: "user-row", threadId: "thread-1", role: "user", kind: "text", text: "x", artifactIds: [note.artifact.id] });
    expect(voiceNoteAudio(f.audioDeps, "thread-1", "user-row").status).toBe(404);
    expect(voiceNoteAudio(f.audioDeps, "thread-1", "no-such-message").status).toBe(404);
  });

  it("ids that are not saved-file ids are skipped without a lookup", async () => {
    const f = fixture();
    const asked: string[] = [];
    const deps: VoiceNoteAudioDeps = { ...f.audioDeps, owner: (id) => { asked.push(id); return f.audioDeps.owner(id); } };
    f.messages.push({ id: "odd", threadId: "thread-1", role: "bot", kind: "text", text: "x", artifactIds: ["../../etc/passwd", 7, "/Users/x/a.mp3"] });
    expect(voiceNoteAudio(deps, "thread-1", "odd").status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("a saved copy that changed or went missing says so, and serves no bytes", async () => {
    const f = fixture();
    const changed = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "One." });
    const gone = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Two." });
    const blob = (sha: string) => join(f.storageRoot, readdirSync(f.storageRoot).find((name) => name.startsWith(sha))!);
    writeFileSync(blob(changed.artifact.sha256), "TAMPERED!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!".slice(0, changed.bytes.length));
    unlinkSync(blob(gone.artifact.sha256));
    const first = voiceNoteAudio(f.audioDeps, "thread-1", changed.messageId);
    const second = voiceNoteAudio(f.audioDeps, "thread-1", gone.messageId);
    expect(first).toEqual({ status: 409, error: "This voice note changed and cannot be played." });
    expect(second).toEqual({ status: 410, error: "This voice note is no longer available." });
  });

  it("names the audio type from the extension, from a closed list only", () => {
    expect(voiceNoteAudioType("Voice note from Ember.mp3")).toBe("audio/mpeg");
    expect(voiceNoteAudioType("a.WAV")).toBe("audio/wav");
    expect(voiceNoteAudioType("a.ogg")).toBe("audio/ogg");
    expect(voiceNoteAudioType("a.html")).toBeNull();
    expect(voiceNoteAudioType("a.svg")).toBeNull();
    expect(voiceNoteAudioType("mp3")).toBeNull();
  });

  it("the client path and the server route are the same route", () => {
    const path = voiceNoteAudioPath("thread-1", "m-2");
    expect(path).toBe("/api/threads/thread-1/messages/m-2/voice-note");
    expect(VOICE_NOTE_AUDIO_ROUTE.exec(path)?.slice(1)).toEqual(["thread-1", "m-2"]);
    expect(VOICE_NOTE_AUDIO_ROUTE.test(voiceNoteAudioPath("../x", "m"))).toBe(false);
  });
});
