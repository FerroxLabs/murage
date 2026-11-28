// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { checkpointKey, ConversationDeletions, runConversationDeletion, rustUrlEncode } from "./conversation-deletion.ts";
import { initializeArtifacts } from "./artifacts.ts";
import type { AppConfig } from "./config.ts";
import { createVoiceNote, type VoiceNoteDeps } from "./voice/voice-notes.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// Faults affect only the named fixture folder; all other filesystem work is real.
const readFault = vi.hoisted(() => ({ path: "", operation: "", code: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const check = (operation: string, path: unknown) => {
    if (readFault.operation === operation && String(path) === readFault.path) {
      throw Object.assign(new Error("Fixture folder is temporarily unreadable"), { code: readFault.code });
    }
  };
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { check("lstat", args[0]); return fs.lstatSync(...args); },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => { check("readdir", args[0]); return fs.readdirSync(...args); },
  };
});

const services: ConversationDeletions[] = [];
const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  readFault.path = readFault.operation = readFault.code = "";
  for (const service of services.splice(0)) service.dispose();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const touch = (file: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture content"); return file; };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-leftovers-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT, id TEXT, json TEXT)");
  const deletions = new ConversationDeletions({ dataDir: root, database: () => db, retryDelaysMs: [] });
  services.push(deletions);
  return { root, db, deletions };
}
const workspaces = ["bot", "bot.general", "bot.teams/team", "bot.projects/project", "bot.rooms/room"];

for (const wholeBot of [false, true]) it(`deleting a ${wholeBot ? "bot" : "chat"} removes its managed audio, images and partition desks only`, async () => {
  const { root, db, deletions } = fixture();
  const gone: string[] = [], kept: string[] = [];
  for (const workspace of workspaces) {
    const base = join(root, "workspaces", workspace);
    gone.push(touch(join(base, "threads", "thread", "report.txt")));
    for (const kind of ["generated-audio", "generated-images"]) {
      gone.push(touch(join(base, kind, "thread", kind === "generated-audio" ? "note.mp3" : "image.png")));
      const other = touch(join(base, kind, "other", "keep.bin"));
      (wholeBot ? gone : kept).push(other);
    }
    const topic = touch(join(base, "memory", "topic.md"));
    (wholeBot ? gone : kept).push(topic);
  }
  kept.push(touch(join(root, "workspaces", "another", "generated-audio", "other", "note.mp3")));
  const attachment = "11111111-1111-4111-8111-111111111111.txt";
  gone.push(touch(join(root, "attachments", attachment)));
  const shared = "22222222-2222-4222-8222-222222222222.png";
  kept.push(touch(join(root, "attachments", shared)));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("thread", "message", JSON.stringify({ attachments: [attachment, shared] }));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("other", "message", JSON.stringify({ attachments: [shared] }));
  // Routines use one shared scheduler document, not a chat-owned folder.
  kept.push(touch(join(root, "routines.json")));
  const { report } = await runConversationDeletion(deletions, { threadIds: ["thread"], ...(wholeBot ? { botIds: ["bot"] } : {}) }, () => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run("thread");
    return true;
  });
  expect(report.failed).toEqual([]);
  expect(gone.filter(existsSync)).toEqual([]);
  expect(kept.filter(file => !existsSync(file))).toEqual([]);
  expect(deletions.pending()).toEqual([]);
});

it("records a partition desk before commit and removes its checkpoints after a restart", async () => {
  const { root, db, deletions } = fixture();
  const desk = join(root, "workspaces", "bot.teams", "team", "threads", "thread");
  const source = touch(join(desk, "notes.txt"));
  const shadow = touch(join(root, "checkpoints", "bot", checkpointKey(desk), "snapshot"));
  const home = join(root, ".fuigo");
  const transcript = touch(join(home, "sessions", rustUrlEncode(desk), "session", "chat_history.jsonl"));
  const entry = deletions.begin({ threadIds: ["thread"], engineHomes: [{ engine: "fuigo", home }] });
  expect(entry.desks).toHaveLength(1);
  const recovered = new ConversationDeletions({ dataDir: root, database: () => db, retryDelaysMs: [] });
  const saved = recovered.pending()[0]!;
  expect(saved.desks).toEqual(entry.desks);
  expect((await recovered.finish(saved)).failed).toEqual([]);
  expect(existsSync(source)).toBe(false);
  expect(existsSync(shadow)).toBe(false);
  expect(existsSync(transcript)).toBe(false);
});

it("unlinks an output-folder link without following it or a partition link", async () => {
  const { root, deletions } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "murage-leftovers-outside-")); roots.push(outside);
  const keep = touch(join(outside, "threads", "thread", "keep.txt"));
  const audio = join(root, "workspaces", "bot", "generated-audio"); mkdirSync(audio, { recursive: true });
  symlinkSync(outside, join(audio, "thread"), process.platform === "win32" ? "junction" : "dir");
  const teams = join(root, "workspaces", "bot.teams"); mkdirSync(teams, { recursive: true });
  symlinkSync(outside, join(teams, "team"), process.platform === "win32" ? "junction" : "dir");
  const result = await runConversationDeletion(deletions, { threadIds: ["thread"] }, () => true);
  expect(result.report.failed).toEqual([]);
  expect(existsSync(join(audio, "thread"))).toBe(false);
  expect(readFileSync(keep, "utf8")).toBe("fixture content");
});

it("a restarted bot deletion removes partition notes even when no chat desk exists", async () => {
  const { root, db, deletions } = fixture();
  const gone = touch(join(root, "workspaces", "bot.teams", "team", "memory", "topic.md"));
  const kept = touch(join(root, "workspaces", "another.teams", "team", "memory", "topic.md"));
  deletions.begin({ threadIds: ["thread"], botIds: ["bot"] });
  const recovered = new ConversationDeletions({ dataDir: root, database: () => db, retryDelaysMs: [] });
  expect((await recovered.finish(recovered.pending()[0]!)).failed).toEqual([]);
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(recovered.pending()).toEqual([]);
});

it("a saved partition path cannot name another bot or leave the workspaces root", async () => {
  const { root, deletions } = fixture();
  const kept = touch(join(root, "workspaces", "another", "threads", "thread", "keep.txt"));
  const entry = deletions.begin({ threadIds: ["thread"] });
  const forged = ["../another", "bot.teams/../../another", "another", "bot.teams/team/extra"];
  await deletions.finish({ ...entry, desks: forged.map(workspace => ({ botId: "bot", threadId: "thread", workspace })) });
  expect(readFileSync(kept, "utf8")).toBe("fixture content");
});

it("a bot deletion collects its picture and preserves pictures another bot or chat uses", async () => {
  const { root, db, deletions } = fixture();
  const names = ["33333333-3333-4333-8333-333333333333.png", "44444444-4444-4444-8444-444444444444.png", "55555555-5555-4555-8555-555555555555.png"];
  const files = names.map(name => touch(join(root, "attachments", name)));
  const bots = names.map((name, i) => ({ id: `bot-${i}`, threadId: `thread-${i}`, avatarUrl: `/api/attachments/${name}` }));
  bots.push({ id: "another", threadId: "other", avatarUrl: `/api/attachments/${names[1]}` });
  writeFileSync(join(root, "bots.json"), JSON.stringify(bots));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("other", "message", JSON.stringify({ image: names[2] }));
  await runConversationDeletion(deletions, { threadIds: ["thread-0", "thread-1", "thread-2"], botIds: ["bot-0", "bot-1", "bot-2"] }, () => {
    writeFileSync(join(root, "bots.json"), JSON.stringify(bots.filter(bot => bot.id === "another")));
    return true;
  });
  expect(existsSync(files[0])).toBe(false);
  expect(existsSync(files[1])).toBe(true);
  expect(existsSync(files[2])).toBe(true);
});

it("deleting a chat keeps an attached image that is still a bot's picture", async () => {
  const { root, db, deletions } = fixture();
  const name = "66666666-6666-4666-8666-666666666666.png";
  const image = touch(join(root, "attachments", name));
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", avatarUrl: `/api/attachments/${name}` }]));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("thread", "message", JSON.stringify({ image: name }));
  await runConversationDeletion(deletions, { threadIds: ["thread"] }, () => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run("thread");
    return true;
  });
  expect(existsSync(image)).toBe(true);
});

it("checks a picture adopted while the engine settles before removing an attachment", async () => {
  const { root, db, deletions } = fixture();
  const name = "77777777-7777-4777-8777-777777777777.png";
  const image = touch(join(root, "attachments", name));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("thread", "message", JSON.stringify({ image: name }));
  await runConversationDeletion(deletions, { threadIds: ["thread"] }, () => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run("thread");
    return true;
  }, async () => {
    writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "another", threadId: "other", avatarUrl: `/api/attachments/${name}` }]));
  });
  expect(existsSync(image)).toBe(true);
});

it("an unreadable roster cannot be treated as proof that a picture is unused", () => {
  const { root, db, deletions } = fixture();
  const name = "88888888-8888-4888-8888-888888888888.png";
  const image = touch(join(root, "attachments", name));
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run("thread", "message", JSON.stringify({ image: name }));
  writeFileSync(join(root, "bots.json"), "{");
  expect(() => deletions.begin({ threadIds: ["thread"] })).toThrow();
  expect(existsSync(image)).toBe(true);
  expect(deletions.pending()).toEqual([]);
});

it("removes a published voice note's source and saved copy, keeping another chat's note", async () => {
  const { root, db, deletions } = fixture();
  initializeArtifacts(db);
  const deps: VoiceNoteDeps = {
    dataDir: root, db, cfg: {} as AppConfig,
    store: {
      bot: () => ({ id: "bot", name: "Fixture" }),
      appendMessage: (threadId: string, message: unknown) => {
        db.prepare("INSERT INTO messages VALUES(?,?,?)").run(threadId, "note", JSON.stringify(message));
        return { id: "note" };
      },
    } as unknown as VoiceNoteDeps["store"],
    speak: async (_cfg, text) => ({ bytes: new TextEncoder().encode(text), mime: "audio/mpeg" }),
  };
  const removed = await createVoiceNote(deps, { botId: "bot", threadId: "thread", runId: "run", text: "Removed note." });
  const kept = await createVoiceNote(deps, { botId: "bot", threadId: "other", runId: "other-run", text: "Kept note." });
  await runConversationDeletion(deletions, { threadIds: ["thread"] }, () => {
    db.prepare("DELETE FROM messages WHERE thread_id=?").run("thread");
    return true;
  });
  expect(existsSync(join(root, "workspaces", "bot", "generated-audio", "thread"))).toBe(false);
  expect(existsSync(join(root, "workspaces", "bot", "generated-audio", "other"))).toBe(true);
  expect(db.prepare("SELECT 1 FROM artifacts WHERE id=?").get(removed.artifact.id)).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM artifacts WHERE id=?").get(kept.artifact.id)).toBeDefined();
  expect(existsSync(join(root, "artifact-files", `${removed.artifact.sha256}.mp3`))).toBe(false);
  expect(readFileSync(join(root, "artifact-files", `${kept.artifact.sha256}.mp3`), "utf8")).toBe("Kept note.");
});

for (const operation of ["lstat", "readdir"]) for (const code of ["EACCES", "EIO"]) {
  it(`a ${operation} ${code} during partition discovery refuses deletion before commit`, async () => {
    const { root, deletions } = fixture();
    const partition = join(root, "workspaces", "bot.teams");
    const desk = touch(join(partition, "team", "threads", "thread", "notes.txt"));
    Object.assign(readFault, { path: partition, operation, code });
    let committed = false;
    await expect(runConversationDeletion(deletions, { threadIds: ["thread"] }, () => {
      committed = true;
      return true;
    })).rejects.toMatchObject({ code });
    expect(committed).toBe(false);
    expect(deletions.pending()).toEqual([]);
    expect(existsSync(desk)).toBe(true);
  });

  it(`a ${operation} ${code} during a partition sweep stays pending and finishes after restart`, async () => {
    const { root, db, deletions } = fixture();
    const partition = join(root, "workspaces", "bot.teams");
    const desk = join(partition, "team", "threads", "thread");
    const gone = [touch(join(desk, "notes.txt")), touch(join(root, "checkpoints", "bot", checkpointKey(desk), "snapshot"))];
    for (const kind of ["generated-audio", "generated-images"]) gone.push(touch(join(partition, "team", kind, "thread", "source.bin")));
    const kept = touch(join(partition, "team", "generated-audio", "other", "keep.mp3"));
    const entry = deletions.begin({ threadIds: ["thread"] });
    Object.assign(readFault, { path: partition, operation, code });
    await expect(deletions.finish(entry)).rejects.toMatchObject({ code });
    expect(deletions.pending().map(item => item.id)).toEqual([entry.id]);
    expect(gone.every(existsSync)).toBe(true);
    deletions.dispose();
    readFault.path = "";
    const recovered = new ConversationDeletions({ dataDir: root, database: () => db, retryDelaysMs: [] });
    services.push(recovered);
    expect((await recovered.finish(recovered.pending()[0]!)).failed).toEqual([]);
    expect(gone.filter(existsSync)).toEqual([]);
    expect(readFileSync(kept, "utf8")).toBe("fixture content");
    expect(recovered.pending()).toEqual([]);
  });
}
