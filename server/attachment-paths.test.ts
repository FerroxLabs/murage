import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { database } from "./database.ts";
import { insertMessage, readMessage, readThread, rebaseMessageAttachmentPaths, rowsNamingImage } from "./message-db.ts";

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
