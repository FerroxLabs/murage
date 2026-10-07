// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  closeMessageDb,
  deleteThread,
  insertMessage,
  readThread,
  searchMessages,
  setActiveLeaf,
  setAttachmentAdoptionObserver,
  threadsReferencingAttachment,
  updateMessage,
} from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);

    // Current-chat find scopes in SQL before LIMIT, so busy transcripts in
    // other conversations cannot crowd out this thread's matches.
    expect(searchMessages("railway", 40, "t5").map((hit) => hit.threadId)).toEqual(["t5"]);
    expect(searchMessages("railway", 40, "missing")).toEqual([]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } } as Message);

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });
});

describe("attachment adoption", () => {
  it("tells the observer which stored pictures a committed message names", () => {
    const seen: string[][] = [];
    setAttachmentAdoptionObserver(paths => seen.push(paths));
    try {
      insertMessage("t-adopt", msg("m1", "hi", { attachments: [{ kind: "image", path: "/data/attachments/a.png", mime: "image/png" }] }));
      insertMessage("t-adopt", msg("m2", "no picture"));
      expect(seen).toEqual([["a.png"]]);
    } finally { setAttachmentAdoptionObserver(null); }
  });
  it("also reports text-only references: attached-image tags, markdown images and edited messages", () => {
    const seen: string[][] = [];
    setAttachmentAdoptionObserver(paths => seen.push(paths));
    try {
      insertMessage("t-adopt2", msg("m1", "<attached-image path=\"/data/attachments/tag-1.png\">"));
      insertMessage("t-adopt2", msg("m2", "see ![x](/api/attachments/md-2.webp)"));
      expect(seen.flat()).toEqual(expect.arrayContaining(["tag-1.png", "md-2.webp"]));
    } finally { setAttachmentAdoptionObserver(null); }
  });
});


describe("attachment adoption uses the visibility definition of a reference", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });
  it("finds visible owners beyond repeated and substring-only attachment candidates", async () => {
    const { attachmentVisibleToRemote, RemoteUploadGrants } = await import("./attachment-access.ts");
    for (let i = 0; i < 220; i++) {
      insertMessage("a-hidden", msg(`repeat-${i}`, "abc-123.png"));
      insertMessage("a-substring", msg(`tail-${i}`, "prefix-def-456.png"));
    }
    for (const name of ["abc-123.png", "def-456.png"]) {
      insertMessage("z-visible", msg(name, `/api/attachments/${name}`));
      expect(attachmentVisibleToRemote({ visibleThreadIds: () => ["z-visible"], bots: [] }, name, threadsReferencingAttachment, new RemoteUploadGrants(), "companion")).toBe(true);
    }
    expect(threadsReferencingAttachment("abc-123.png")).toEqual(["a-hidden", "z-visible"]);
    expect(threadsReferencingAttachment("def-456.png")).toEqual(["z-visible"]);
  });
  it("consumes both suffix-related grants using the same references as visibility", async () => {
    const { RemoteUploadGrants } = await import("./attachment-access.ts");
    const uploads = new RemoteUploadGrants(), seen: string[] = [];
    for (const name of ["abc-123.png", "prefix-abc-123.png"]) uploads.grant(name, "companion");
    setAttachmentAdoptionObserver(paths => { seen.push(...paths); for (const path of paths) uploads.consume(path); });
    try {
      insertMessage("t-suffix", msg("m1", "abc-123.png ABC-123.PNG", { attachments: [{ kind: "image", path: "/legacy/prefix-abc-123.png", mime: "image/png" }] }));
      for (const name of ["abc-123.png", "prefix-abc-123.png"]) expect(threadsReferencingAttachment(name)).toEqual(["t-suffix"]);
      expect(new Set(seen.map(name => name.toLowerCase()))).toEqual(new Set(["abc-123.png", "prefix-abc-123.png"]));
      deleteThread("t-suffix");
      for (const name of ["abc-123.png", "prefix-abc-123.png"]) {
        expect(threadsReferencingAttachment(name)).toEqual([]);
        expect(uploads.allows(name, "companion")).toBe(false);
      }
    } finally { setAttachmentAdoptionObserver(null); }
  });
  it("a text reference in different case is both visible-owned and consumed, by one function", async () => {
    const { RemoteUploadGrants } = await import("./attachment-access.ts");
    const uploads = new RemoteUploadGrants();
    uploads.grant("abc-123.png", "companion");
    setAttachmentAdoptionObserver(paths => { for (const path of paths) uploads.consume(path); });
    try {
      insertMessage("t-case", msg("m1", "see ![x](/api/attachments/ABC-123.PNG)"));
      expect(threadsReferencingAttachment("abc-123.png")).toEqual(["t-case"]);
      expect(uploads.allows("abc-123.png", "companion")).toBe(false);
    } finally { setAttachmentAdoptionObserver(null); }
  });
  it("a name that is only the tail of a longer filename-shaped token is a reference to neither", () => {
    const seen: string[][] = [];
    setAttachmentAdoptionObserver(paths => seen.push(paths));
    try {
      insertMessage("t-tail", msg("m1", "see xyzabc-123.png"));
      expect(threadsReferencingAttachment("abc-123.png")).toEqual([]);
      expect(seen.flat()).not.toContain("abc-123.png");
    } finally { setAttachmentAdoptionObserver(null); }
  });
  it("a legacy-import message adopts its pictures too", () => {
    const seen: string[][] = [];
    writeFileSync(legacy("t-legacy"), JSON.stringify({ activeLeafId: "a", messages: [msg("a", "![x](/api/attachments/imp-9.png)")] }));
    setAttachmentAdoptionObserver(paths => seen.push(paths));
    try {
      readThread("t-legacy", legacy("t-legacy"));
      expect(seen.flat()).toContain("imp-9.png");
    } finally { setAttachmentAdoptionObserver(null); }
  });
});
