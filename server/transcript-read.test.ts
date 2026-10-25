// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptReader, TRANSCRIPT_READ_PENDING } from "./transcript-read.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [], readers: TranscriptReader[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.close()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transcript-read-")); roots.push(root);
  const file = join(root, "messages.db"), db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE messages(thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id));
    CREATE INDEX messages_at ON messages(at DESC);
    CREATE TABLE memory_sources(id TEXT PRIMARY KEY, message_id TEXT);
    CREATE TABLE memory_tombstones(target_type TEXT,target_id TEXT);
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'user','text','remember this email','{"turnId":"turn"}');
    INSERT INTO memory_sources VALUES('s','m'); INSERT INTO memory_tombstones VALUES('source','s');`);
  db.close();
  return file;
}
async function allPages(reader: TranscriptReader) {
  let after = 0; const items = [];
  for (;;) { const page = await reader.forgotten(after); items.push(...page.items); if (page.last === null) return items; after = page.last; }
}

it("reads compact forgotten pages off-thread, without executing SQL on the caller, and again from the first page", async () => {
  const file = fixture();
  const reader = new TranscriptReader(file); readers.push(reader);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  expect(await allPages(reader)).toEqual([{ threadId: "t", turnId: "turn", needle: "remember this email" }]);
  expect(await allPages(reader)).toEqual([{ threadId: "t", turnId: "turn", needle: "remember this email" }]);
  expect(prepare).not.toHaveBeenCalled();
});

it("health finishes while the read worker is held inside a synchronous step, with zero main-thread SQL statements", async () => {
  const file = fixture();
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const reader = new TranscriptReader(file, { gate: gate.buffer as SharedArrayBuffer }); readers.push(reader);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const server = createServer(async (req, res) => {
    if (req.url === "/api/health") { res.end("healthy"); return; }
    res.end(JSON.stringify(await reader.forgotten(0)));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const page = fetch(`${url}/api/forgotten`).then(res => res.json()) as Promise<{ items: unknown[]; last: number | null }>;
    // Logical ordering, not an elapsed-time assertion: the worker cannot proceed until AFTER health replies.
    await vi.waitFor(() => expect(Atomics.load(gate, 1)).toBe(1));
    expect(await fetch(`${url}/api/health`).then(res => res.text())).toBe("healthy");
    expect(prepare).not.toHaveBeenCalled();
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    expect((await page).items).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("bounds admission and rejects work at shutdown without an inline fallback of its own", async () => {
  const file = fixture();
  const reader = new TranscriptReader(file, { gate: new SharedArrayBuffer(8) }); readers.push(reader);
  const reads = Array.from({ length: TRANSCRIPT_READ_PENDING }, () => reader.forgotten(0).catch(error => error.message));
  await expect(reader.forgotten(0)).rejects.toThrow("busy");
  expect(reader.isStopped).toBe(false);
  await reader.close();
  expect(reader.isStopped).toBe(true);
  expect(await Promise.all(reads)).toEqual(Array(TRANSCRIPT_READ_PENDING).fill("Transcript reader stopped"));
  await expect(reader.forgotten(0)).rejects.toThrow("stopped");
});

it("a worker launch failure rejects the request and leaves the reader usable for the caller's fallback decision", async () => {
  const reader = new TranscriptReader(fixture(), { workerPath: join(tmpdir(), "missing-transcript-worker.mjs") }); readers.push(reader);
  await expect(reader.forgotten(0)).rejects.toThrow();
  expect(reader.isStopped).toBe(false);
});

it("ships the read worker, routes the prune's lookup through it with a bounded inline fallback, and leaves search on its own path", () => {
  expect(SPAWNED_PROXIES.transcriptReadWorker).toContain("transcript-read-worker.ts");
  expect(readFileSync(new URL("../scripts/bundle-server.mjs", import.meta.url), "utf8")).toContain('"transcript-read-worker.ts"');
  expect(readFileSync(new URL("../scripts/after-pack.mjs", import.meta.url), "utf8")).toContain('path.join(server, "transcript-read-worker.js")');
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("transcriptReader.forgotten(after)");
  expect(source).toContain('heldStep("events.prune.forgotten", () => inline!())');
  expect(source).toContain("await transcriptReader.close()");
  // Search stays on its own path: the /api/search route calls message-db's searchMessagesWithMeta directly, never the
  // transcript read worker. fix/rc12-search2 added the reader's audience ({ owner: desktop }) as a fourth argument; the 1.0.6 chats
  // view (47456b4dd, merged 5f538b096) caps its hits at 40, answers the owner's All chats as the owner and leaves forgotten lines out.
  expect(source).toContain("searchMessagesWithMeta(q, chatsView ? Math.min(limit, 40) : limit, scope, { owner: desktop || chatsView, ...(chatsView ? { excludeForgotten: true } : {}) })");
  expect(source).not.toContain("transcriptReader.search(");
});
