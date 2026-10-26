// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage's attachment list (1.0.3, ATTACHMENT-STORE-DESIGN r7):
// acceptance rows L1 to L8 and R1.9's server half.
import { mkdirSync, mkdtempSync, promises as fsp, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const { readAttachmentSpy } = vi.hoisted(() => ({ readAttachmentSpy: vi.fn(() => { throw new Error("the list must never read attachment bytes"); }) }));
vi.mock("./attachments.ts", () => ({ readAttachment: readAttachmentSpy }));

const { AttachmentList, ITEM_CONVERSATIONS, kindOf, realWalkFs, SNAPSHOT_TTL_MS, STALE_SNAPSHOT_MESSAGE, UNREADABLE_FOLDER_MESSAGE, walkAttachments } = await import("./storage-attachments.ts");
type WalkFs = import("./storage-attachments.ts").WalkFs;
type ListPage = import("./storage-attachments.ts").ListPage;

const scratch = mkdtempSync(join(tmpdir(), "murage-storage-list-"));
afterAll(() => removeTempDirSync(scratch));
afterEach(() => { vi.restoreAllMocks(); });

let n = 0;
const uuid = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`;
const freshDir = () => { const dir = join(scratch, `d${n++}`); mkdirSync(dir); return dir; };

function schema(db: DatabaseSync, { index = true, done = true } = {}) {
  db.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id))`);
  if (!index) return db;
  db.exec(`CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE attachment_name(name TEXT NOT NULL, thread_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(name, thread_id, id)) WITHOUT ROWID;`);
  db.prepare("INSERT INTO transcript_index_state VALUES ('attachment_name', ?, 0, 0)").run(done ? 1 : 0);
  return db;
}
const message = (db: DatabaseSync, thread: string, id: string, json: string) =>
  db.prepare("INSERT INTO messages VALUES (?, ?, 0, 'user', 'text', '', ?)").run(thread, id, json);
const pointer = (db: DatabaseSync, name: string, thread: string, id: string) =>
  db.prepare("INSERT INTO attachment_name VALUES (?, ?, ?)").run(name, thread, id);

/** Counts each statement's runs, by its SQL. */
function spied(db: DatabaseSync) {
  const runs = new Map<string, number>();
  const fetched = { n: 0 };
  const proxy = { prepare(sql: string) {
    const statement = db.prepare(sql);
    const count = () => runs.set(sql, (runs.get(sql) ?? 0) + 1);
    return { get: (...args: unknown[]) => { count(); return (statement.get as (...a: unknown[]) => unknown)(...args); },
      all: (...args: unknown[]) => { count(); const rows = (statement.all as (...a: unknown[]) => unknown[])(...args); if (sql.includes("FROM attachment_name WHERE")) fetched.n += rows.length; return rows; } };
  } } as unknown as DatabaseSync;
  const confirmations = () => [...runs].filter(([sql]) => sql.startsWith("SELECT 1 FROM messages")).reduce((sum, [, v]) => sum + v, 0);
  return { proxy, runs, confirmations, fetched };
}

const labels: Record<string, string> = { "t-bot": "Moss", "t-room": "Launch room" };
function makeList(dir: string, db: DatabaseSync = schema(new DatabaseSync(":memory:")), extra: Partial<ConstructorParameters<typeof AttachmentList>[0]> = {}) {
  return new AttachmentList({ dir, database: () => db, bots: () => [], threadLabel: (thread) => labels[thread], ...extra });
}
const ok = (answer: Awaited<ReturnType<InstanceType<typeof AttachmentList>["list"]>>) => {
  expect(answer.status).toBe(200);
  expect((answer.body as ListPage).state).toBe("ok");
  return answer.body as ListPage;
};

/** A fake folder: names in order, each one's lstat answer. */
function fakeFs(entries: Array<{ name: string; stat?: "file" | "dir" | "link"; size?: number; error?: string }>, options: { opendirError?: string; iteratorThrowsAt?: number } = {}) {
  const calls = { opendir: 0, lstat: [] as string[] };
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const fs: WalkFs = {
    async opendir() {
      calls.opendir++;
      if (options.opendirError) throw Object.assign(new Error(options.opendirError), { code: options.opendirError });
      let i = 0;
      return {
        async read() {
          if (options.iteratorThrowsAt === i) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return i < entries.length ? { name: entries[i++]!.name } : null;
        },
        async close() {},
      };
    },
    async lstat(path: string) {
      calls.lstat.push(path);
      const entry = byName.get(path.split(/[\\/]/).pop()!)!;
      if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.error });
      return { isFile: () => (entry.stat ?? "file") === "file", isSymbolicLink: () => entry.stat === "link", size: BigInt(entry.size ?? 10), mtimeMs: 1000n };
    },
  };
  return { fs, calls };
}

describe("the inventory walk (R1.2, R1.3)", () => {
  it("L1: 1,000 managed files page in 20 requests of 50 by size; newest order is stable", async () => {
    const dir = freshDir();
    for (let i = 0; i < 1000; i++) {
      const path = join(dir, `${uuid(i)}.png`);
      writeFileSync(path, Buffer.alloc(i % 97));
      utimesSync(path, 1_700_000_000 + (i % 13), 1_700_000_000 + (i % 13));
    }
    const list = makeList(dir);
    const first = ok(await list.list({ order: "size" }));
    const pages = [first];
    while (pages.at(-1)!.nextCursor) pages.push(ok(await list.list({ order: "size", snapshot: first.snapshot, cursor: pages.at(-1)!.nextCursor })));
    expect(pages).toHaveLength(20);
    const sizes = pages.flatMap(page => page.items.map(item => item.bytes));
    expect(sizes).toHaveLength(1000);
    expect(new Set(pages.flatMap(page => page.items.map(item => item.name))).size).toBe(1000);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    const newest = async () => {
      const out: string[] = [];
      let cursor: string | null = "";
      while (cursor !== null) { const page = ok(await list.list({ order: "newest", snapshot: first.snapshot, cursor })); out.push(...page.items.map(item => item.name)); cursor = page.nextCursor; }
      return out;
    };
    const a = await newest();
    expect(a).toHaveLength(1000);
    expect(await newest()).toEqual(a);
  });

  it("L2: a partial, a symlink, a directory and a foreign name are counted in other and never listed", async () => {
    const dir = freshDir();
    const managed = `${uuid(1)}.pdf`;
    writeFileSync(join(dir, managed), "pdf!");
    writeFileSync(join(dir, ".murage-upload-aaaa-bbbb.partial"), "xx");
    symlinkSync("/etc/hosts", join(dir, `${uuid(2)}.png`));
    mkdirSync(join(dir, `${uuid(3)}.jpg`));
    writeFileSync(join(dir, "notes.txt"), "abc");
    const page = ok(await makeList(dir).list({}));
    expect(page.items.map(item => item.name)).toEqual([managed]);
    expect(page.totals).toMatchObject({ count: 1, bytes: 4, other: { count: 4 } });
  });

  // 1.0.4 SL-H H3: Remove's marker folder is not a file Murage keeps.
  it("skips the .removed marker folder: never listed, never counted as other", async () => {
    const dir = freshDir();
    const managed = `${uuid(1)}.pdf`;
    writeFileSync(join(dir, managed), "pdf!");
    mkdirSync(join(dir, ".removed"));
    writeFileSync(join(dir, ".removed", `${uuid(2)}.png`), "");
    const page = ok(await makeList(dir).list({}));
    expect(page.items.map(item => item.name)).toEqual([managed]);
    expect(page.totals).toMatchObject({ count: 1, bytes: 4, other: { count: 0, bytes: 0 } });
  });

  it("L3: the walk reads no file bytes and opens nothing but the folder", async () => {
    const dir = freshDir();
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `${uuid(i)}.png`), "bytes");
    const open = vi.spyOn(fsp, "open");
    const readFile = vi.spyOn(fsp, "readFile");
    ok(await makeList(dir).list({}));
    expect(open).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    // with a fake folder that offers only opendir and lstat, one lstat per entry
    const managed = `${uuid(9)}.png`;
    const { fs, calls } = fakeFs([{ name: managed }, { name: "other" }]);
    expect((await walkAttachments("/x", fs)).ok).toBe(true);
    expect(calls).toEqual({ opendir: 1, lstat: [join("/x", managed), join("/x", "other")] });
  });

  it("lstat is called with bigint, so sizes are exact", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "f"), "abc");
    expect(typeof (await realWalkFs.lstat(join(dir, "f"))).size).toBe("bigint");
  });

  it("L4: 100,001 managed entries answer truncated", async () => {
    const entries = Array.from({ length: 100_001 }, (_, i) => ({ name: `${uuid(i)}.png` }));
    const { fs, calls } = fakeFs(entries);
    const result = await walkAttachments("/x", fs);
    expect(result.ok && result.totals).toMatchObject({ truncated: true, count: 100_000 });
    expect(calls.lstat).toHaveLength(100_000);
  });

  it("L4b: 99,999 foreign entries plus 2 managed stop at 100,000 examined, truncated", async () => {
    const entries = [...Array.from({ length: 99_999 }, (_, i) => ({ name: `foreign-${i}` })), { name: `${uuid(1)}.png` }, { name: `${uuid(2)}.png` }];
    const result = await walkAttachments("/x", fakeFs(entries).fs);
    expect(result.ok && result.totals).toMatchObject({ truncated: true, count: 1, other: { count: 99_999 } });
  });

  it("exactly 100,000 entries are not truncated", async () => {
    const result = await walkAttachments("/x", fakeFs(Array.from({ length: 100_000 }, (_, i) => ({ name: `f${i}` }))).fs);
    expect(result.ok && result.totals.truncated).toBe(false);
  });
});

describe("failures (R1.8, L8)", () => {
  const listWith = (fs: WalkFs) => makeList("/x", undefined, { fs });
  it("an entry deleted between readdir and lstat is vanished; the page is ok", async () => {
    const page = ok(await listWith(fakeFs([{ name: `${uuid(1)}.png` }, { name: `${uuid(2)}.png`, error: "ENOENT" }]).fs).list({}));
    expect(page.totals).toMatchObject({ vanished: 1, count: 1, other: { unreadable: 0 } });
  });
  it("an lstat EACCES on one entry is other.unreadable with its code; both together are both", async () => {
    const one = ok(await listWith(fakeFs([{ name: "a", error: "EACCES" }, { name: "b", error: "EIO" }]).fs).list({}));
    expect(one.totals).toMatchObject({ vanished: 0, other: { unreadable: 2, firstError: "EACCES" } });
    const both = ok(await listWith(fakeFs([{ name: "a", error: "EACCES" }, { name: "b", error: "ENOENT" }]).fs).list({}));
    expect(both.totals).toMatchObject({ vanished: 1, other: { unreadable: 1, firstError: "EACCES" } });
  });
  it("only opendir EACCES or an iterator error makes the folder unreadable; opendir ENOENT is an empty list", async () => {
    expect(await listWith(fakeFs([], { opendirError: "EACCES" }).fs).list({})).toEqual({ status: 200, body: { state: "unreadable", message: UNREADABLE_FOLDER_MESSAGE } });
    expect(await listWith(fakeFs([{ name: "a" }, { name: "b" }], { iteratorThrowsAt: 1 }).fs).list({})).toEqual({ status: 200, body: { state: "unreadable", message: UNREADABLE_FOLDER_MESSAGE } });
    const empty = ok(await listWith(fakeFs([], { opendirError: "ENOENT" }).fs).list({}));
    expect(empty.items).toEqual([]);
    expect(empty.totals.count).toBe(0);
  });
});

describe("snapshots and paging (R1.3, R1.4)", () => {
  it("a stale, expired or replaced snapshot answers 409", async () => {
    let now = 0;
    const { fs } = fakeFs([{ name: `${uuid(1)}.png` }, { name: `${uuid(2)}.png` }]);
    const list = makeList("/x", undefined, { fs, now: () => now });
    const first = ok(await list.list({ limit: "1" }));
    expect(ok(await list.list({ limit: "1", snapshot: first.snapshot, cursor: "1" })).items).toHaveLength(1);
    expect(await list.list({ snapshot: "nope" })).toEqual({ status: 409, body: { error: STALE_SNAPSHOT_MESSAGE } });
    const second = ok(await list.list({}));
    expect((await list.list({ snapshot: first.snapshot })).status).toBe(409);
    now = SNAPSHOT_TTL_MS + 1;
    expect((await list.list({ snapshot: second.snapshot })).status).toBe(409);
  });
  it("after a Remove the old snapshot's next page answers 409", async () => {
    const { fs } = fakeFs([{ name: `${uuid(1)}.png` }, { name: `${uuid(2)}.png` }]);
    const list = makeList("/x", undefined, { fs });
    const first = ok(await list.list({ limit: "1" }));
    list.forget();
    expect(await list.list({ limit: "1", snapshot: first.snapshot, cursor: "1" })).toEqual({ status: 409, body: { error: STALE_SNAPSHOT_MESSAGE } });
  });
  it("a snapshot is dropped after five minutes even when nobody asks again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const list = makeList("/x", undefined, { fs: fakeFs([{ name: `${uuid(1)}.png` }]).fs });
      ok(await list.list({}));
      expect(list.holdsSnapshot).toBe(true);
      vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
      expect(list.holdsSnapshot).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("one walk at a time: a request during a walk awaits it", async () => {
    const { fs, calls } = fakeFs([{ name: `${uuid(1)}.png` }]);
    const list = makeList("/x", undefined, { fs });
    const [a, b] = await Promise.all([list.list({}), list.list({})]);
    expect(calls.opendir).toBe(1);
    expect(ok(a).snapshot).toBe(ok(b).snapshot);
  });
  it("refuses a bad order, limit or cursor with 400", async () => {
    const list = makeList("/x", undefined, { fs: fakeFs([]).fs });
    for (const query of [{ order: "name" }, { limit: "0" }, { limit: "101" }, { limit: "x" }, { cursor: "-1" }, { cursor: "1.5" }]) expect((await list.list(query)).status).toBe(400);
    expect(ok(await list.list({ limit: "100" })).items).toEqual([]);
  });
  it("each item carries name, bytes, modifiedAt, kind and usedIn", async () => {
    const name = `${uuid(1)}.mp3`;
    const page = ok(await makeList("/x", undefined, { fs: fakeFs([{ name, size: 42 }]).fs }).list({}));
    expect(page.items[0]).toEqual({ name, bytes: 42, modifiedAt: 1000, kind: "audio", usedIn: { state: "unused" } });
  });
});

describe("where a file is used (R1.6, R1.7)", () => {
  const png = `${uuid(10)}.png`;
  const pdf = `${uuid(11)}.pdf`;
  const one = async (db: DatabaseSync, name: string, extra = {}) => ok(await makeList("/x", db, { fs: fakeFs([{ name }]).fs, ...extra }).list({})).items[0]!.usedIn;

  it("L5: a png and a pdf named in an attached-file tag and in a structured attachment resolve to the right labels", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    message(db, "t-bot", "m1", JSON.stringify({ text: `<attached-file path="/data/attachments/${pdf}" />` }));
    message(db, "t-room", "m2", JSON.stringify({ attachments: [{ path: `/api/attachments/${png}` }] }));
    pointer(db, pdf, "t-bot", "m1");
    pointer(db, png, "t-room", "m2");
    expect(await one(db, pdf)).toEqual({ state: "used", labels: ["Moss"], more: false });
    expect(await one(db, png)).toEqual({ state: "used", labels: ["Launch room"], more: false });
    pointer(db, png, "t-gone-label", "m3");
    message(db, "t-gone-label", "m3", `{"x":"${png}"}`);
    expect(await one(db, png)).toEqual({ state: "used", labels: ["Conversation", "Launch room"], more: false });
  });

  it("an avatar is Picture of <bot>", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    expect(await one(db, png, { bots: () => [{ name: "Moss", avatarUrl: `/api/attachments/${png}` }] })).toEqual({ state: "used", labels: ["Picture of Moss"], more: false });
  });

  it("L5b: a stale pointer is dropped; 500 rows of one conversation cost one confirmation; caps after a confirmation give more", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    pointer(db, png, "t-a", "stale");
    message(db, "t-a", "stale", "{}");
    expect(await one(db, png)).toEqual({ state: "unused" });
    const many = schema(new DatabaseSync(":memory:"));
    for (let i = 0; i < 500; i++) { pointer(many, png, "t-bot", `m${String(i).padStart(3, "0")}`); message(many, "t-bot", `m${String(i).padStart(3, "0")}`, `{"a":"${png}"}`); }
    const spy = spied(many);
    expect(await one(spy.proxy, png)).toEqual({ state: "used", labels: ["Moss"], more: false });
    expect(spy.confirmations()).toBe(1);
    const wide = schema(new DatabaseSync(":memory:"));
    for (let i = 0; i < ITEM_CONVERSATIONS + 5; i++) { pointer(wide, png, `t${i}`, "m"); message(wide, `t${i}`, "m", `{"a":"${png}"}`); }
    const used = await one(wide, png);
    expect(used).toMatchObject({ state: "used", more: true });
    expect(used.state === "used" && used.labels).toEqual(["Conversation"]);
  });

  it("L6: backfill not done, and table absent, give unknown and coverageComplete false; complete coverage with no pointers gives unused", async () => {
    const notDone = schema(new DatabaseSync(":memory:"), { done: false });
    expect(await one(notDone, png)).toEqual({ state: "unknown" });
    expect(ok(await makeList("/x", notDone, { fs: fakeFs([]).fs }).list({})).coverageComplete).toBe(false);
    const noTable = schema(new DatabaseSync(":memory:"), { index: false });
    expect(await one(noTable, png)).toEqual({ state: "unknown" });
    expect(ok(await makeList("/x", noTable, { fs: fakeFs([]).fs }).list({})).coverageComplete).toBe(false);
    const complete = schema(new DatabaseSync(":memory:"));
    expect(await one(complete, png)).toEqual({ state: "unused" });
    expect(ok(await makeList("/x", complete, { fs: fakeFs([]).fs }).list({})).coverageComplete).toBe(true);
  });

  it("L6b: 64 pointers that all fail confirmation with more left is unknown, never unused", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    for (let i = 0; i < 70; i++) { pointer(db, png, `t${String(i).padStart(2, "0")}`, "m"); message(db, `t${String(i).padStart(2, "0")}`, "m", "{}"); }
    expect(await one(db, png)).toEqual({ state: "unknown" });
  });

  it("a failed SQL read is that item's unknown", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    const broken = { prepare(sql: string) { if (sql.includes("FROM attachment_name WHERE")) throw new Error("SQLITE_BUSY"); return db.prepare(sql); } } as unknown as DatabaseSync;
    expect(await one(broken, png)).toEqual({ state: "unknown" });
  });

  it("the page budget of 3,000 pointer reads is shared across the page's items", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    const names = Array.from({ length: 60 }, (_, i) => `${uuid(100 + i)}.png`);
    for (const name of names) for (let i = 0; i < 64; i++) pointer(db, name, `t${String(i).padStart(2, "0")}`, "m");
    const spy = spied(db);
    const page = ok(await makeList("/x", spy.proxy, { fs: fakeFs(names.map(name => ({ name }))).fs }).list({ limit: "60" }));
    expect(spy.confirmations()).toBe(3000);
    expect(spy.fetched.n).toBe(3000);
    expect(page.items.every(item => item.usedIn.state === "unknown")).toBe(true);
  });

  it("every pointer row fetched counts against the caps, confirmed or skipped (Astra build review)", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    const names = Array.from({ length: 100 }, (_, i) => `${uuid(300 + i)}.png`);
    for (const name of names) for (let t = 0; t < 20; t++) for (let m = 0; m < 32; m++) {
      const thread = `t${String(t).padStart(2, "0")}`, id = `m${String(m).padStart(2, "0")}`;
      pointer(db, name, thread, id);
    }
    for (let t = 0; t < 20; t++) for (let m = 0; m < 32; m++) message(db, `t${String(t).padStart(2, "0")}`, `m${String(m).padStart(2, "0")}`, `{"a":"${names.join(",")}"}`);
    const single = spied(db);
    expect(await one(single.proxy, names[0]!)).toMatchObject({ state: "used", more: true });
    expect(single.fetched.n).toBeLessThanOrEqual(64);
    const spy = spied(db);
    ok(await makeList("/x", spy.proxy, { fs: fakeFs(names.map(name => ({ name }))).fs }).list({ limit: "100" }));
    expect(spy.fetched.n).toBeLessThanOrEqual(3000);
  });

  it("a SQL failure after a confirmation, or beside an avatar, is unknown", async () => {
    const db = schema(new DatabaseSync(":memory:"));
    for (const thread of ["t-a", "t-b"]) { pointer(db, png, thread, "m"); message(db, thread, "m", `{"a":"${png}"}`); }
    let confirms = 0;
    const flaky = { prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT 1 FROM messages")) return statement;
      return { get: (...args: unknown[]) => { if (++confirms > 1) throw new Error("SQLITE_BUSY"); return (statement.get as (...a: unknown[]) => unknown)(...args); } };
    } } as unknown as DatabaseSync;
    expect(await one(flaky, png)).toEqual({ state: "unknown" });
    const broken = { prepare(sql: string) { if (sql.includes("FROM attachment_name WHERE")) throw new Error("SQLITE_BUSY"); return db.prepare(sql); } } as unknown as DatabaseSync;
    expect(await one(broken, png, { bots: () => [{ name: "Moss", avatarUrl: `/api/attachments/${png}` }] })).toEqual({ state: "unknown" });
  });
});

describe("R1.9: the list requests no attachment bytes", () => {
  it("never calls readAttachment, and its route reaches nothing that reads bytes", async () => {
    const dir = freshDir();
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `${uuid(i)}.${["png", "pdf", "mp4", "mp3"][i % 4]}`), "x");
    ok(await makeList(dir).list({}));
    expect(readAttachmentSpy).not.toHaveBeenCalled();
    const source = readFileSync(join(import.meta.dirname, "storage-attachments.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/attachments\.ts"/);
    expect(source).not.toMatch(/readAttachment|createReadStream|readFile|\.open\(/);
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const at = index.indexOf('path === "/api/storage/attachments"');
    expect(at).toBeGreaterThan(0);
    const block = index.slice(at, index.indexOf("\n    }\n", at));
    expect(block).toContain("storageAttachmentList.list(");
    expect(block).not.toMatch(/readAttachment|attachmentPath|createReadStream/);
  });

  it("the kind icon comes from the extension alone", () => {
    expect(["a.png", "a.JPG", "a.pdf", "a.docx", "a.mp3", "a.mov", "a.zip", "a"].map(kindOf)).toEqual(["image", "image", "document", "document", "audio", "video", "other", "other"]);
  });
});
