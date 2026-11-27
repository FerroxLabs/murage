// q1022-startup MAIN-RULING STARTUP-1022 H2-sameKey: after a data folder move, every message write (insert, append, update, and the
// top row deleted and written again under the same (thread_id, id), which takes back its rowid) stores its attachment paths under the
// current data root, so the boot rebase pass's high-water cursor never has an old-root row behind it. One row per write site (SITES.md).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DATA_DIR, ensureDirs } from "./config.ts";
import { bootDataRoots } from "./data-roots.ts";
import { database } from "./database.ts";
import { appendMessage, insertMessage, readMessage, rebaseMessageAttachmentPaths, updateMessage } from "./message-db.ts";

const old = join(DATA_DIR, "root-old");
const image = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.png`;
const line = (id: string, path: string) => ({ id, role: "user" as const, kind: "text" as const, at: Date.now(), attachments: [{ kind: "image" as const, path, mime: "image/png" }] });
const oldPath = (n: number) => join(old, "attachments", image(n));
let moved = false;
function movedFromOld() {
  if (moved) return;
  ensureDirs();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
  moved = true;
}

const sites: Array<[string, number, (thread: string, n: number) => void]> = [
  ["insertMessage", 1, (thread, n) => insertMessage(thread, line("m", oldPath(n)))],
  ["appendMessage", 2, (thread, n) => appendMessage(thread, line("m", oldPath(n)))],
  ["updateMessage (patch of a stored row)", 3, (thread, n) => { insertMessage(thread, line("m", join(DATA_DIR, "attachments", image(n)))); updateMessage(thread, line("m", oldPath(n))); }],
  ["top row deleted and the same (thread_id, id) written again after the boot pass", 4, (thread, n) => {
    insertMessage(thread, line("m", join(DATA_DIR, "attachments", image(n))));
    rebaseMessageAttachmentPaths(); // the boot pass ran: its high-water is this thread's top row
    database().prepare("DELETE FROM messages WHERE thread_id=? AND id=?").run(thread, "m");
    insertMessage(thread, line("m", oldPath(n))); // same key, reuses the top rowid
  }],
];

it.each(sites)("W-WRITE-CURRENT-ROOT %s stores the attachment under the current data root", (_name, n, write) => {
  movedFromOld();
  const thread = `wcr-${n}`;
  write(thread, n);
  expect(readMessage(thread, "m")?.attachments?.[0].path).toBe(join(DATA_DIR, "attachments", image(n)));
});
