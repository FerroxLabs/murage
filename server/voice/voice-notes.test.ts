import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { initializeArtifacts } from "../artifacts.ts";
import type { AppConfig } from "../config.ts";
import { createVoiceNote, VOICE_NOTE_MAX_CHARS, voiceNotePieces, type VoiceNoteDeps } from "./voice-notes.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(voice = { voice: "eve", voiceProvider: "xai" as const }) {
  const dataDir = mkdtempSync(join(tmpdir(), "murage-voice-note-"));
  roots.push(dataDir);
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  databases.push(db);
  initializeArtifacts(db);
  const messages: any[] = [];
  const spoken: Array<{ text: string; voice?: string; own?: string }> = [];
  const store = {
    bot: (id: string) => (id === "bot-1" ? { id, name: "Ember", ...voice } : undefined),
    appendMessage: (threadId: string, message: any) => {
      const saved = { id: `m${messages.length + 1}`, threadId, ...message };
      messages.push(saved);
      return saved;
    },
  };
  const deps: VoiceNoteDeps = {
    db,
    dataDir,
    store: store as unknown as VoiceNoteDeps["store"],
    cfg: {} as AppConfig,
    speak: async (_cfg, text, voiceId, _run, own) => {
      spoken.push({ text, voice: voiceId, own });
      return { bytes: new TextEncoder().encode(`[${text.length}]`), mime: "audio/mpeg" };
    },
  };
  return { deps, dataDir, messages, spoken };
}

describe("voice notes", () => {
  it("says the text in the bot's own voice and leaves it in the chat as a playable audio file", async () => {
    const f = fixture();
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Morning, boss.  Two approvals are waiting." });
    expect(f.spoken).toEqual([{ text: "Morning, boss. Two approvals are waiting.", voice: "eve", own: "xai" }]);
    expect(note.artifact).toMatchObject({ name: "Voice note from Ember", filename: "Voice note from Ember.mp3", producer: "voice-note" });
    expect(f.messages).toEqual([expect.objectContaining({ id: note.messageId, role: "bot", kind: "text", text: "Morning, boss. Two approvals are waiting.", artifactIds: [note.artifact.id] })]);
    // kept in the private per-conversation folder and in Files
    const folder = join(f.dataDir, "workspaces", "bot-1", "generated-audio", "thread-1");
    expect(readdirSync(folder).filter((name) => name.endsWith(".mp3"))).toHaveLength(1);
    expect(readdirSync(join(f.dataDir, "artifact-files")).some((name) => name.endsWith(".mp3"))).toBe(true);
    expect(note.mime).toBe("audio/mpeg");
    expect(note.bytes.toString()).toBe("[41]");
  });

  it("speaks a longer note in pieces that end at sentences, and joins them into one file", async () => {
    const f = fixture();
    const sentence = "The market opened higher and the approvals are waiting for you in the inbox. ";
    const text = sentence.repeat(10).trim();
    const note = await createVoiceNote(f.deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text });
    expect(f.spoken.length).toBeGreaterThan(1);
    for (const piece of f.spoken) {
      expect(piece.text.length).toBeLessThanOrEqual(450);
      expect(piece.text).toMatch(/\.$/);
    }
    expect(f.spoken.map((piece) => piece.text).join(" ")).toBe(text);
    // one file, the pieces in order
    const folder = join(f.dataDir, "workspaces", "bot-1", "generated-audio", "thread-1");
    const [file] = readdirSync(folder).filter((name) => name.endsWith(".mp3"));
    expect(readFileSync(join(folder, file!)).toString()).toBe(f.spoken.map((piece) => `[${piece.text.length}]`).join(""));
    expect(note.bytes.toString()).toBe(readFileSync(join(folder, file!)).toString());
  });

  it("keeps nothing when the turn ended while the voice was being made", async () => {
    // Upstream OpenMausBot #1762: synthesis can outlive its turn. A Stop or a
    // settle during the wait must not leave a note in the chat afterwards.
    const f = fixture();
    let live = true;
    const speak = f.deps.speak;
    const deps: VoiceNoteDeps = {
      ...f.deps,
      speak: async (...args) => { const audio = await speak(...args); live = false; return audio; },
      stillLive: () => live,
    };
    await expect(createVoiceNote(deps, { botId: "bot-1", threadId: "thread-1", runId: "run-1", text: "Done." }))
      .rejects.toMatchObject({ status: 409 });
    expect(f.spoken).toHaveLength(1);
    expect(f.messages).toEqual([]);
    expect(existsSync(join(f.dataDir, "workspaces", "bot-1", "generated-audio", "thread-1"))).toBe(false);
  });

  it("refuses an empty note, one too long to be a note, and a bot that is gone, without speaking", async () => {
    const f = fixture();
    await expect(createVoiceNote(f.deps, { botId: "bot-1", threadId: "t", runId: "r", text: "   " })).rejects.toThrow("something to say");
    await expect(createVoiceNote(f.deps, { botId: "bot-1", threadId: "t", runId: "r", text: "x".repeat(VOICE_NOTE_MAX_CHARS + 1) })).rejects.toThrow("under 1500 characters");
    await expect(createVoiceNote(f.deps, { botId: "gone", threadId: "t", runId: "r", text: "Hi." })).rejects.toThrow("not available");
    expect(f.spoken).toEqual([]);
    expect(existsSync(join(f.dataDir, "workspaces"))).toBe(false);
  });

  it("never splits mid-word", () => {
    const pieces = voiceNotePieces(`${"word ".repeat(200)}end`, 100);
    for (const piece of pieces) expect(piece).toMatch(/^(word ?)+( end)?$|^end$/);
    expect(pieces.join(" ").split(" ").length).toBe(201);
  });
});
