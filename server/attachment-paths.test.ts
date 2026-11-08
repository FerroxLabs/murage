import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { database } from "./database.ts";
import { insertMessage, readMessage, readThread, rebaseMessageAttachmentPaths, rowsNamingImage } from "./message-db.ts";
import { rowToMessage, storedJson } from "./transcript-seq.ts";
import { rebasedAttachmentPath } from "./attachment-read.ts";
import { attachmentConstructors } from "./attachment-paths.ts";

const old = join(DATA_DIR, "previous");
const name = "12345678-1234-1234-1234-123456789abc.png";
function setup(previous = true) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: previous ? old : DATA_DIR, previous: [] }));
  bootDataRoots();
}
const attachment = (path: string) => ({ kind: "image" as const, path, mime: "image/png" });

it("S5 site 14 migrates message attachment paths and their index while preserving text and shape", () => {
  setup();
  const path = join(old, "attachments", name), next = join(DATA_DIR, "attachments", name);
  insertMessage("s5-14-a", { id: "a", role: "user", kind: "text", at: 1, text: path, attachments: [attachment(path)] });
  expect(rebaseMessageAttachmentPaths()).toBe(1);
  expect(readMessage("s5-14-a", "a")).toMatchObject({ text: path, attachments: [attachment(next)] });
  expect(rowsNamingImage("s5-14-a", next)).toHaveLength(1);
  expect(rebaseMessageAttachmentPaths()).toBe(0);
});

it("S5 site 14 keeps a refused record byte-identical and requires recorded provenance", () => {
  setup();
  const path = join(old, "attachments", name);
  insertMessage("s5-14-b", { id: "b", role: "user", kind: "text", at: 1, attachments: [attachment(path), attachment(join(old, "attachments", "nested", name))] });
  const raw = () => database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get("s5-14-b", "b")?.json;
  const before = raw();
  expect(rebaseMessageAttachmentPaths()).toBe(0);
  expect(raw()).toBe(before);
  setup(false);
  insertMessage("s5-14-c", { id: "c", role: "user", kind: "text", at: 1, attachments: [attachment(path)] });
  expect(rebaseMessageAttachmentPaths()).toBe(0);
  expect(readMessage("s5-14-c", "c")?.attachments?.[0].path).toBe(path);
});

it("S5 site 14 imports legacy structured attachments at the new location without rewriting text history", () => {
  setup();
  const path = join(old, "attachments", name), file = join(DATA_DIR, "messages-s5-14-legacy.json");
  writeFileSync(file, JSON.stringify([{ id: "legacy", role: "user", kind: "text", at: 1, text: path, attachments: [attachment(path)] }]));
  expect(readThread("s5-14-legacy", file).messages[0]).toMatchObject({ text: path, attachments: [attachment(join(DATA_DIR, "attachments", name))] });
});

it("S5 site 14 decodes and encodes through rowToMessage/storedJson: the rebased row is the bytes the b18 JSON.stringify path wrote, and an unchanged row is never rewritten", () => {
  setup();
  const path = join(old, "attachments", name), next = join(DATA_DIR, "attachments", name);
  const message = { id: "e", role: "user" as const, kind: "text" as const, at: 1, text: path, attachments: [attachment(path)] };
  // P3: the rows are written the way b18 wrote them, with plain JSON.stringify and no seq, never through today's writer (insertMessage uses storedJson)
  const b18Row = (thread: string, row: { id: string; role: "user"; kind: "text"; at: number; text?: string; attachments: ReturnType<typeof attachment>[] }) =>
    database().prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(thread, row.id, row.at, row.role, row.kind, row.text ?? null, JSON.stringify(row));
  b18Row("s5-14-e", message);
  b18Row("s5-14-f", { id: "f", role: "user", kind: "text", at: 2, attachments: [attachment(join(DATA_DIR, "attachments", name))] });
  const raw = (thread: string, id: string) => database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(thread, id)?.json as string;
  const stored = raw("s5-14-e", "e"), untouched = raw("s5-14-f", "f");
  expect(stored).toBe(JSON.stringify(message));
  // the row reads back the same through the one decoder as through the b18 JSON.parse
  expect(rowToMessage({ json: stored })).toEqual(JSON.parse(stored));
  // for this row shape (no seq, no tool) the one encoder writes exactly what JSON.stringify wrote
  expect(storedJson(JSON.parse(stored))).toBe(stored);
  // rows of the earlier cases in this file (same database) may move too; this case checks its own two rows
  expect(rebaseMessageAttachmentPaths()).toBeGreaterThanOrEqual(1);
  const rebased = raw("s5-14-e", "e");
  expect(rebased).toBe(JSON.stringify({ ...JSON.parse(stored), attachments: [attachment(next)] }));
  expect(raw("s5-14-f", "f")).toBe(untouched);
});

it("S5 site 14 (P8): rebasedAttachmentPath takes exactly one leaf, under Windows and POSIX rules on every host", () => {
  const root = join(DATA_DIR, "previous");
  expect(rebasedAttachmentPath(root, name)).toBe(join(root, "attachments", name));
  expect(attachmentConstructors(name)(root)).toEqual([join(root, "attachments", name)]);
  const refused = [
    "", ".", "..",
    "a/b.png", "a\\b.png", "../x.png", "..\\x.png", "x.png/", "x.png\\",
    "/abs.png", "\\abs.png", "\\\\server\\share\\x.png",
    "C:", "c:", "C:x.png", "C:\\x.png", "C:/x.png", "\\\\?\\C:\\x.png", "\\\\?\\UNC\\server\\share\\x.png",
    "x\0.png", "\0",
  ];
  for (const leaf of refused) {
    expect(rebasedAttachmentPath(root, leaf), JSON.stringify(leaf)).toBeNull();
    expect(attachmentConstructors(leaf)(root), JSON.stringify(leaf)).toEqual([]);
  }
});
