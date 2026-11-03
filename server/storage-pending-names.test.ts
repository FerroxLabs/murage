// SPDX-License-Identifier: AGPL-3.0-or-later
// STORAGE-PENDING-NAMES: what a start shows and hands out while its boot work is still running.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { AttachmentList, type ListPage } from "./storage-attachments.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = mkdtempSync(join(tmpdir(), "murage-storage-pending-"));
afterAll(() => removeTempDirSync(scratch));
const name = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.png`;

describe("Settings, Storage, while a deletion of a conversation is still owed", () => {
  it("lists and counts none of its files in any order or page, and shows a file that stays once the deletion has passed it", async () => {
    const dir = join(scratch, "files");
    mkdirSync(dir);
    const names = [name(1), name(2), name(3)];
    names.forEach((file, i) => writeFileSync(join(dir, file), Buffer.alloc(10 ** i)));
    const owed = new Set([names[1]!]);
    const list = new AttachmentList({ dir, database: () => new DatabaseSync(":memory:"), bots: () => [], threadLabel: () => undefined, hidden: (file) => owed.has(file) });
    for (const order of ["size", "newest"]) {
      const first = (await list.list({ order, limit: "1" })).body as ListPage;
      const rest = (await list.list({ order, limit: "50", snapshot: first.snapshot, cursor: first.nextCursor! })).body as ListPage;
      expect([...first.items, ...rest.items].map((item) => item.name).sort()).toEqual([names[0]!, names[2]!].sort());
      expect(first.totals).toMatchObject({ count: 2, bytes: 101 });
    }
    owed.clear();
    expect(((await list.list({})).body as ListPage).totals).toMatchObject({ count: 3, bytes: 111 });
  });

  it("the server's list asks the deletions which names are owed", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/new AttachmentList\(\{[^}]*hidden: \(name\) => conversationDeletions\.attachmentPending\(name\)/);
  });
});

describe("a new bot on a start whose engine probe is still running", () => {
  it("every creation path picks an engine itself, so none reads the empty boot selection", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const creations = source.match(/store\.createBot\((?:\{[^\n]*\}|\s*\{[\s\S]*?\},\s*\{ seedMessages: false \},?\s*)\)/g) ?? [];
    expect(creations.length).toBeGreaterThanOrEqual(2);
    for (const call of creations) expect(call).toMatch(/modelSelection/);
    expect(source).toMatch(/const modelSelection = await defaultSelection\(\);[\s\S]{0,600}title: "External browser connection", modelSelection/);
  });
});
