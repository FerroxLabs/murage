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
  // 1.0.15 BIRTH-FUIGO (design BIRTH-FUIGO-1014.md section 1 P4, section 3 "P4 pairing"): a route with no owner pick passes no selection,
  // and createBot births the bot by the one birth rule in the same tick (Fuigo when usable, else the Chief's own selection on desktop, else
  // the empty seed plus the mark that moves it to Fuigo). The boot probe's reading feeds only the first desktop bot. Behaviour:
  // birth-selection.test.ts and startup-order.test.ts.
  it("no creation path reads the boot selection: a bot with no owner pick is born by the birth rule, and marked", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const creations = index.match(/store\.createBot\((?:\{[^\n]*\}|\s*\{[\s\S]*?\},\s*\{ seedMessages: false \},?\s*)\)/g) ?? [];
    expect(creations.length).toBeGreaterThanOrEqual(2);
    for (const call of creations) expect(call).not.toMatch(/bootSelection|defaultSelection/);
    expect(index).not.toMatch(/await defaultSelection\(\)/);
    // the pairing body is strict (label and profileId), so there is no owner pick to carry and none is invented
    expect(index).toMatch(/z\.object\(\{ action: z\.literal\("pair"\), label: [^\n]*, profileId: [^\n]*\}\)\.strict\(\)/);
    expect(index).toMatch(/store\.createBot\(\{ name: body\.label, title: "External browser connection" \}, \{ seedMessages: false \}\)/);
    expect(store).toMatch(/const born = profile\.modelSelection === undefined;/);
    expect(store).toMatch(/modelSelection: this\.completeNewBotSelection\(born \? this\.birthSelection\(\) : profile\.modelSelection!\)/);
    expect(store).toMatch(/if \(born \|\| opts\.engineAutoPicked === true\) bot\.engineAutoPicked = true;/);
    expect(store).toMatch(/if \(!source && this\.birth\.copyChief && this\.birth\.firstBot\) \{/);
  });
});
