// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLine, ACTIVITY_MAX_AGE_MS, ACTIVITY_MAX_LINE_BYTES, ACTIVITY_MAX_LINES, BrowserActivityStore,
  configureBrowserActivity, recordBrowserActivity, sameFile,
} from "./browser-extension-activity.ts";
import { BROWSER_EXTENSION_FILES, classifyDataDirEntry } from "./data-dir-inventory.ts";
import { routeClass, conversationSubject } from "./route-policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
let clock = 1_800_000_000_000;
const now = () => clock;
const entry = (over: Record<string, unknown> = {}) => ({
  botId: "bot1", bindingId: "bind1", taskId: "task1", site: "example.com", action: "click",
  target: "Save draft", level: 2 as const, decision: "allowed for this task" as const, decidedBy: "grant" as const, outcome: "done" as const, ...over,
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "activity-")); clock = 1_800_000_000_000; });
afterEach(() => { configureBrowserActivity(undefined); removeTempDirSync(dir); });

describe("browser activity store", () => {
  it("records the allowed fields and nothing else", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record({ ...entry(), value: "hunter2", text: "my password", password: "x", typed: "y" } as never)).toBe(true);
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(Object.keys(line!).sort()).toEqual(["action", "at", "botId", "bindingId", "decidedBy", "decision", "fromPage", "id", "level", "outcome", "site", "target", "taskId"].sort());
    expect(JSON.stringify(readFileSync(join(dir, "bind1.ndjson"), "utf8"))).not.toMatch(/hunter2|password|my password/);
  });

  it("keeps only the length of typed text", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ action: "type", target: "Email field", textLength: 14 }));
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(line!.textLength).toBe(14);
  });

  it("refuses bad ids, unknown enums and path escapes", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ bindingId: "../escape" }))).toBe(false);
    expect(store.record(entry({ level: 9 }))).toBe(false);
    expect(store.record(entry({ decision: "whatever" }))).toBe(false);
    expect(store.record(entry({ botId: "" }))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caps every line at 512 bytes, whatever the label", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ target: "é".repeat(5000), site: "a".repeat(5000), action: "b".repeat(5000) }))).toBe(true);
    for (const raw of readFileSync(join(dir, "bind1.ndjson"), "utf8").split("\n").filter(Boolean)) expect(Buffer.byteLength(raw) + 1).toBeLessThanOrEqual(ACTIVITY_MAX_LINE_BYTES);
  });

  it("strips control characters and marks page-derived labels", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ target: "Buy\u0000 now\n‮", fromPage: true }));
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(line!.target).toBe("Buy now");
    expect(line!.fromPage).toBe(true);
  });

  it("keeps at most 2,000 lines per binding, newest last", () => {
    const store = new BrowserActivityStore(dir, now);
    for (let i = 0; i < ACTIVITY_MAX_LINES + 130; i++) { clock += 1; store.record(entry({ target: `n${i}` })); }
    const lines = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(lines.length).toBe(ACTIVITY_MAX_LINES);
    expect(lines.at(-1)!.target).toBe(`n${ACTIVITY_MAX_LINES + 129}`);
    expect(lines[0]!.target).toBe("n130");
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(ACTIVITY_MAX_LINES + 100);
  });

  it("drops lines older than 30 days", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ target: "old" }));
    clock += ACTIVITY_MAX_AGE_MS + 1;
    store.record(entry({ target: "new" }));
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).map(l => l.target)).toEqual(["new"]);
    store.prune();
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).not.toContain("old");
  });

  it("filters by task and never shows another bot's lines", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ taskId: "t1", target: "a" }));
    store.record(entry({ taskId: "t2", target: "b" }));
    store.record(entry({ botId: "other", taskId: "t1", target: "c" }));
    expect(store.list({ botId: "bot1", bindingId: "bind1", taskId: "t1" }).map(l => l.target)).toEqual(["a"]);
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).map(l => l.target)).toEqual(["a", "b"]);
    expect(store.list({ botId: "bot1", bindingId: "../x" })).toEqual([]);
  });

  it("lists every binding of a bot when no binding is named", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ bindingId: "b1", target: "a" })); clock += 1;
    store.record(entry({ bindingId: "b2", target: "b" }));
    store.record(entry({ botId: "other", bindingId: "b3", target: "c" }));
    expect(store.list({ botId: "bot1" }).map(l => l.target)).toEqual(["a", "b"]);
  });

  it("is deleted with the binding and survives a corrupt line", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry());
    writeFileSync(join(dir, "bind1.ndjson"), readFileSync(join(dir, "bind1.ndjson"), "utf8") + "{not json\n");
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).length).toBe(1);
    store.deleteBinding("bind1");
    expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
  });

  it("returns true once the line is on disk, even when the counting after it fails (RESIDUALS-1018 Astra r3)", () => {
    const store = new BrowserActivityStore(dir, now);
    Object.assign(store as object, { read: () => { throw new Error("read failed"); } });
    expect(store.record(entry())).toBe(true);
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    // Nothing was written: false.
    expect(store.record(entry({ action: "" }))).toBe(false);
  });

  it("a torn tail from a failed append leaves exactly one parsed record after the next write (RESIDUALS-1018 Astra r2)", () => {
    const store = new BrowserActivityStore(dir, now);
    // The state a failed append leaves: half a JSON line, no newline, in a file with no other line.
    writeFileSync(join(dir, "bind1.ndjson"), '{"at":1800000000000,"botId":"bot1","bindingId":"bi');
    expect(store.record(entry())).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(1);
    // A good line first, then a torn one, then the next write: two parsed records, the torn piece is dropped.
    const again = new BrowserActivityStore(dir, now);
    writeFileSync(join(dir, "bind1.ndjson"), readFileSync(join(dir, "bind1.ndjson"), "utf8") + '{"at":18000');
    expect(again.record(entry({ action: "type" }))).toBe(true);
    expect(again.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(2);
  });

  it("a file that already ends in a partial line when the store starts gives exactly one parsed record", () => {
    writeFileSync(join(dir, "bind2.ndjson"), "{not finished");
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ bindingId: "bind2" }))).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind2" })).toHaveLength(1);
  });

  // The stub file calls below close the real descriptor before they fail, so no test leaves one open.
  const closing = (fail: boolean): typeof closeSync => ((fd: number) => { closeSync(fd); if (fail) throw new Error("EIO on close"); }) as never;

  it("a failing close does not undo a complete append; a short write is a failure, never continued", () => {
    const path = join(dir, "short.ndjson"); const json = '{"a":1}';
    appendLine(path, json, { write: writeSync, close: closing(true) });
    expect(readFileSync(path, "utf8")).toBe("\n" + json + "\n");
    let calls = 0;
    const short: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => { calls++; return writeSync(fd, buffer, offset, Math.min(length, 3)); }) as never;
    expect(() => appendLine(join(dir, "short2.ndjson"), json, { write: short, close: closing(false) })).toThrow();
    expect(calls).toBe(1);
  });

  it("a short write returns normally but short: record() retries the whole record and the file reads as one", () => {
    let first = true;
    const shortOnce: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => { const n = first ? 12 : length; first = false; return writeSync(fd, buffer, offset, n); }) as never;
    const store = new BrowserActivityStore(dir, now, { write: shortOnce, close: closing(false) });
    expect(store.record(entry())).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(1);
  });

  it("a record cut off right after its id is not counted as written", () => {
    // Both writes stop after the id field: nothing readable landed, so record() is false and the caller writes its own line.
    const cut: typeof writeSync = ((fd: number, buffer: Buffer) => { const text = buffer.toString("utf8"); const end = text.indexOf('"id":"') + 6 + 36 + 1; writeSync(fd, buffer, 0, Buffer.byteLength(text.slice(0, end))); return Buffer.byteLength(text.slice(0, end)); }) as never;
    const store = new BrowserActivityStore(dir, now, { write: cut, close: closing(false) });
    expect(store.record(entry())).toBe(false);
    expect(store.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(0);
  });

  it("a short write that stops in the middle of the json leaves one parsed record after the next write", () => {
    const half: typeof writeSync = ((fd: number, buffer: Buffer, offset: number) => { writeSync(fd, buffer, offset, 12); throw new Error("ENOSPC"); }) as never;
    const torn = new BrowserActivityStore(dir, now, { write: half, close: closing(false) });
    expect(torn.record(entry())).toBe(false);
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8").length).toBeGreaterThan(0);
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ action: "type" }))).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(1);
  });

  it("the json landed but the trailing newline failed: record() says written and a fallback append shows one record", () => {
    // Every byte but the last newline is written, then the write throws.
    const allButNewline: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => { writeSync(fd, buffer, offset, length - 1); throw new Error("EIO"); }) as never;
    const store = new BrowserActivityStore(dir, now, { write: allButNewline, close: closing(false) });
    expect(store.record(entry())).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(1);
    // The same record written twice (a retry after a landed record) is read once; the next record is its own line.
    const text = readFileSync(join(dir, "bind1.ndjson"), "utf8").trim();
    writeFileSync(join(dir, "bind1.ndjson"), `\n${text}\n\n${text}\n`);
    expect(new BrowserActivityStore(dir, now).list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(1);
    expect(new BrowserActivityStore(dir, now).record(entry({ action: "type" }))).toBe(true);
    expect(new BrowserActivityStore(dir, now).list({ botId: "bot1", bindingId: "bind1" })).toHaveLength(2);
  });

  it("a caller's id is kept when it is a UUID, so a fallback line with the same id reads as one record; any other id is replaced", () => {
    const store = new BrowserActivityStore(dir, now);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(store.record(entry({ id, outcome: "denied", decision: "not done" }))).toBe(true);
    expect(store.record(entry({ id, outcome: "failed", decision: "not done" }))).toBe(true);
    const lines = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id, outcome: "denied" });
    expect(store.record(entry({ id: "../not a uuid" }))).toBe(true);
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).every(line => line.id !== "../not a uuid")).toBe(true);
  });

  it("an empty file or a new file holds one record per write", () => {
    writeFileSync(join(dir, "bind3.ndjson"), "");
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ bindingId: "bind3" }))).toBe(true);
    expect(store.record(entry({ bindingId: "bind4" }))).toBe(true);
    for (const id of ["bind3", "bind4"]) {
      expect(readFileSync(join(dir, `${id}.ndjson`), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
      expect(store.list({ botId: "bot1", bindingId: id })).toHaveLength(1);
    }
  });

  describe("a compaction in another process never loses an append", () => {
    const targets = (store: BrowserActivityStore, bindingId = "bind1") => store.list({ botId: "bot1", bindingId }).map(l => l.target);
    const asides = () => readdirSync(dir).filter(name => name.endsWith(".aside"));

    it("a write that lands after a compaction took the file is written again and reads as one record", () => {
      const other = new BrowserActivityStore(dir, now);
      other.record(entry({ target: "before" }));
      // The appender has its descriptor open; the other process compacts; the write lands in a file that is no longer the log.
      let raced = 0;
      const late: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => { if (!raced++) other.prune(); return writeSync(fd, buffer, offset, length); }) as never;
      const store = new BrowserActivityStore(dir, now, { write: late, close: closeSync });
      expect(store.record(entry({ target: "late" }))).toBe(true);
      expect(raced).toBe(2);
      expect(targets(store).sort()).toEqual(["before", "late"]);
      expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).toContain('"target":"late"');
      expect(asides()).toEqual([]);
    });

    it("an append that creates a new log while a compaction holds the old one keeps both", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "old" }));
      const compactor = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, afterMoveAside: () => { expect(writer.record(entry({ target: "during" }))).toBe(true); } });
      compactor.prune();
      expect(targets(writer).sort()).toEqual(["during", "old"]);
      expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).toContain('"target":"during"');
      expect(asides()).toEqual([]);
    });

    it("an append during a compaction that keeps nothing is not removed with the expired lines", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "expired" }));
      clock += ACTIVITY_MAX_AGE_MS + 1;
      const compactor = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, afterMoveAside: () => { writer.record(entry({ target: "fresh" })); } });
      compactor.prune();
      expect(targets(writer)).toEqual(["fresh"]);
    });

    it("two compactions at once leave every record, once", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "a" })); clock += 1;
      writer.record(entry({ target: "b" })); clock += 1;
      const second = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, afterMoveAside: () => { writer.record(entry({ target: "c" })); } });
      const first = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, afterMoveAside: () => { second.prune(); } });
      first.prune();
      expect(targets(writer)).toEqual(["a", "b", "c"]);
      expect(asides()).toEqual([]);
    });

    it("a crash between the move and the copy loses nothing: the reader reads the aside and the next prune takes it back", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "kept" }));
      const path = join(dir, "bind1.ndjson");
      const aside = `${path}.11111111-2222-4333-8444-555555555555.aside`;
      writeFileSync(aside, readFileSync(path));
      rmSync(path);
      expect(targets(store)).toEqual(["kept"]);
      store.prune();
      expect(targets(store)).toEqual(["kept"]);
      expect(asides()).toEqual([]);
      expect(readFileSync(path, "utf8")).toContain('"target":"kept"');
    });

    it("a crash after a partial copy reads as one record per id and one per older line with no id", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "with-id" }));
      const path = join(dir, "bind1.ndjson");
      const withId = readFileSync(path, "utf8").trim();
      const noId = JSON.stringify({ ...JSON.parse(withId), id: undefined, target: "no-id" });
      writeFileSync(`${path}.11111111-2222-4333-8444-555555555555.aside`, `${withId}\n${noId}\n`);
      writeFileSync(path, `\n${withId}\n${noId}\n`);
      expect(targets(store).sort()).toEqual(["no-id", "with-id"]);
      store.prune();
      expect(targets(store).sort()).toEqual(["no-id", "with-id"]);
      expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
      expect(asides()).toEqual([]);
    });

    it("a copy whose file moved under it is not confirmed: the sources stay, and the next compaction takes them", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "kept" }));
      const path = join(dir, "bind1.ndjson");
      let moved = 0;
      const moving: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
        // Another compaction renames the compactor's destination after it was opened and before it is written.
        if (!moved++) renameSync(path, `${path}.11111111-2222-4333-8444-555555555555.aside`);
        return writeSync(fd, buffer, offset, length);
      }) as never;
      new BrowserActivityStore(dir, now, { write: moving, close: closeSync }).prune();
      expect(moved).toBe(1);
      expect(asides()).toHaveLength(2);
      expect(targets(store)).toEqual(["kept"]);
      store.prune();
      expect(asides()).toEqual([]);
      expect(targets(store)).toEqual(["kept"]);
    });

    it("a file system with no usable file id: a record is written once and a compaction finishes, by reading the log back", () => {
      expect(sameFile({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n })).toBe(false);
      expect(sameFile({ dev: 1n, ino: 7n }, { dev: 1n, ino: 7n })).toBe(true);
      expect(sameFile({ dev: 1n, ino: 7n }, { dev: 1n, ino: 8n })).toBe(false);
      const store = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, same: () => false });
      expect(store.record(entry({ target: "one" }))).toBe(true);
      const path = join(dir, "bind1.ndjson");
      expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
      store.prune();
      expect(asides()).toEqual([]);
      expect(targets(store)).toEqual(["one"]);
    });

    it("a reader that finds the log gone because a compaction just moved it reads again and misses nothing", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "kept" }));
      const path = join(dir, "bind1.ndjson");
      let moved = 0;
      const reader = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeRead: read => { if (read === path && !moved++) renameSync(path, `${path}.11111111-2222-4333-8444-555555555555.aside`); } });
      expect(targets(reader)).toEqual(["kept"]);
      expect(moved).toBe(2);
    });

    it("a reader that finds a new log because a compaction just moved the old one reads again and misses nothing", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "old" }));
      const path = join(dir, "bind1.ndjson");
      let moved = 0;
      const reader = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeRead: read => {
        if (read !== path || moved++) return;
        renameSync(path, `${path}.11111111-2222-4333-8444-555555555555.aside`);
        writer.record(entry({ target: "new" }));
      } });
      expect(targets(reader).sort()).toEqual(["new", "old"]);
    });

    it("two compactions under a reader with no log at either check: the listed aside has gone, so the reader reads again and misses nothing", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "kept" }));
      const path = join(dir, "bind1.ndjson"), first = `${path}.11111111-2222-4333-8444-555555555555.aside`;
      renameSync(path, first);
      let moved = false, finished = false;
      const other = new BrowserActivityStore(dir, now);
      const reader = new BrowserActivityStore(dir, now, {
        write: writeSync, close: closeSync,
        // The reader has seen no log and listed the aside. One compaction copies it to a new log and removes it; a second moves that log aside.
        beforeRead: read => { if (read === first && !moved) { moved = true; other.prune(); expect(existsSync(first)).toBe(false); renameSync(path, `${path}.66666666-2222-4333-8444-555555555555.aside`); } },
        // No log at either check. The second compaction then copies back and removes its aside, so the listing is clean too.
        beforeRelist: () => { if (moved && !finished) { finished = true; expect(existsSync(path)).toBe(false); other.prune(); expect(asides()).toEqual([]); } },
      });
      expect(targets(reader)).toEqual(["kept"]);
      expect(finished).toBe(true);
    });

    it("a record written and moved during the read, and copied back before the listing is checked: the last look at the log sends the reader back", () => {
      const writer = new BrowserActivityStore(dir, now);
      const path = join(dir, "bind1.ndjson");
      let step = 0;
      const other = new BrowserActivityStore(dir, now);
      const reader = new BrowserActivityStore(dir, now, {
        write: writeSync, close: closeSync,
        // No log and no aside so far. An append makes the log and a compaction moves it, so the read and the stat after it both find no log.
        beforeRead: read => { if (read === path && step === 0) { step = 1; expect(writer.record(entry({ target: "written" }))).toBe(true); renameSync(path, `${path}.11111111-2222-4333-8444-555555555555.aside`); } },
        // The compaction copies back and removes its aside, so the listing is clean.
        beforeRelist: () => { if (step === 1) { step = 2; expect(existsSync(path)).toBe(false); other.prune(); expect(asides()).toEqual([]); expect(existsSync(path)).toBe(true); } },
      });
      expect(targets(reader)).toEqual(["written"]);
      expect(step).toBe(2);
    });

    it("no log and then a log counts as a change: the reader reads again", () => {
      const writer = new BrowserActivityStore(dir, now);
      const path = join(dir, "bind1.ndjson");
      let logReads = 0;
      const reader = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeRead: read => { if (read === path && !logReads++) writer.record(entry({ target: "new" })); } });
      expect(targets(reader)).toEqual(["new"]);
      expect(logReads).toBe(2);
    });

    it("a compaction that finishes between the read and the check leaves a clean listing, and the changed log still sends the reader back", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "old" }));
      const path = join(dir, "bind1.ndjson");
      let raced = 0;
      const reader = new BrowserActivityStore(dir, now, {
        write: writeSync, close: closeSync,
        // Before the read: the log moves and an append makes a new one, so the read sees only "new".
        beforeRead: read => { if (read === path && raced === 0) { raced = 1; renameSync(path, `${path}.${randomUUID()}.aside`); writer.record(entry({ target: "new" })); } },
        // After the read: the compaction copies everything back and removes its asides, so no aside is left to give it away.
        same: (a, b) => { if (raced === 1) { raced = 2; new BrowserActivityStore(dir, now).prune(); expect(asides()).toEqual([]); } return sameFile(a, b); },
      });
      expect(targets(reader).sort()).toEqual(["new", "old"]);
      expect(raced).toBe(2);
    });

    it("a log whose file id comes back after two compactions still counts as changed, by its birth time", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "old" }));
      const path = join(dir, "bind1.ndjson");
      let logReads = 0, cleaned = false;
      // The file id is forced to match and no aside is left when the listing is checked, so only the birth time can tell the two logs apart.
      const reader = new BrowserActivityStore(dir, now, {
        write: writeSync, close: closeSync,
        same: () => { if (!cleaned) { cleaned = true; new BrowserActivityStore(dir, now).prune(); expect(asides()).toEqual([]); } return true; },
        beforeRead: read => {
          if (read !== path || logReads++) return;
          renameSync(path, `${path}.${randomUUID()}.aside`);
          const until = Date.now() + 20; while (Date.now() < until) { /* a later birth time */ }
          writer.record(entry({ target: "new" }));
        },
      });
      expect(targets(reader).sort()).toEqual(["new", "old"]);
      expect(logReads).toBe(2);
    });

    it("a log that keeps moving: three reads and no more, a record can be hidden for that one read, and the next read shows it", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "first" }));
      const path = join(dir, "bind1.ndjson");
      let logReads = 0, moving = true;
      const reader = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeRead: read => {
        if (read !== path) return;
        logReads++;
        if (moving) { renameSync(path, `${path}.${randomUUID()}.aside`); writer.record(entry({ target: `moved ${logReads}` })); }
      } });
      expect(targets(reader).sort()).toEqual(["first", "moved 1", "moved 3"]);
      expect(logReads).toBe(3);
      moving = false; logReads = 0;
      expect(targets(reader).sort()).toEqual(["first", "moved 1", "moved 2", "moved 3"]);
      expect(logReads).toBe(1);
    });

    it("the copy's folder is synced before an aside goes, and a failed sync keeps the sources", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "kept" }));
      const path = join(dir, "bind1.ndjson");
      let works = false;
      const seen: { target: string; asides: number; copied: boolean }[] = [];
      const store = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, syncFolder: (target: string) => {
        seen.push({ target, asides: asides().length, copied: readFileSync(path, "utf8").includes('"target":"kept"') });
        if (!works) throw new Error("EIO");
      } });
      store.prune();
      expect(seen).toEqual([{ target: path, asides: 1, copied: true }]);
      expect(asides()).toHaveLength(1);
      expect(targets(writer)).toEqual(["kept"]);
      works = true; seen.length = 0;
      store.prune();
      expect(seen).toEqual([{ target: path, asides: 2, copied: true }]);
      expect(asides()).toEqual([]);
      expect(targets(writer)).toEqual(["kept"]);
    });

    it("a compaction with nothing to keep and no mark needs no sync", () => {
      const writer = new BrowserActivityStore(dir, now);
      writer.record(entry({ target: "expired" }));
      clock += ACTIVITY_MAX_AGE_MS + 1;
      new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, syncFolder: () => { throw new Error("no sync expected"); } }).prune();
      expect(asides()).toEqual([]);
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
    });

    it("a binding deleted while another process's compaction holds its records stays deleted", () => {
      const other = new BrowserActivityStore(dir, now);
      other.record(entry({ target: "gone" }));
      new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeCopy: () => { other.deleteBinding("bind1"); } }).prune();
      expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).toContain('"target":"gone"');
      expect(targets(other)).toEqual([]);
      other.prune();
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
    });

    const markOf = (id: string) => join(dir, "deleted", id);

    it("a mark outlives the pass that removes its records, and any later pass, however old", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "before" }));
      expect(store.deleteBinding("bind1")).toBe(true);
      expect(readFileSync(markOf("bind1"), "utf8")).toBe("");
      expect(store.record(entry({ target: "late" }))).toBe(true);
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(true);
      expect(targets(store)).toEqual([]);
      store.prune();
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
      expect(existsSync(markOf("bind1"))).toBe(true);
      clock += 10 * ACTIVITY_MAX_AGE_MS;
      store.prune();
      expect(readdirSync(dir)).toEqual(["deleted"]);
      expect(readdirSync(join(dir, "deleted"))).toEqual(["bind1"]);
    });

    it("a fresh append after a pass has looked at a marked id stays hidden, then and after every later pass", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "before" }));
      store.deleteBinding("bind1");
      clock += 10 * ACTIVITY_MAX_AGE_MS;
      store.record(entry({ target: "seen by the pass" }));
      // The pass has found the id marked and kept nothing; the append lands after that, and after the pass has moved on.
      let appended = 0;
      const pass = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, beforeCopy: () => { appended++; expect(store.record(entry({ target: "fresh" }))).toBe(true); } });
      pass.prune();
      expect(appended).toBe(1);
      expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).toContain('"target":"fresh"');
      expect(targets(store)).toEqual([]);
      expect(store.record(entry({ target: "after the pass" }))).toBe(true);
      expect(targets(new BrowserActivityStore(dir, now))).toEqual([]);
      expect(existsSync(markOf("bind1"))).toBe(true);
      store.prune();
      expect(targets(new BrowserActivityStore(dir, now))).toEqual([]);
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
      expect(store.list({ botId: "bot1" })).toEqual([]);
    });

    it("the marks folder is not read as a binding, and other bindings' logs and asides are untouched by it", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "gone" }));
      store.record(entry({ bindingId: "bind2", target: "stays" }));
      store.deleteBinding("bind1");
      store.prune();
      expect(store.list({ botId: "bot1" }).map(line => line.target)).toEqual(["stays"]);
      expect(readdirSync(dir).sort()).toEqual(["bind2.ndjson", "deleted"]);
    });

    it("a mark that cannot be written: false, and the log stays and still reads", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "kept" }));
      const failing = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, writeMark: () => { throw new Error("ENOSPC"); } });
      expect(failing.deleteBinding("bind1")).toBe(false);
      expect(existsSync(markOf("bind1"))).toBe(false);
      expect(existsSync(join(dir, "bind1.ndjson"))).toBe(true);
      expect(targets(store)).toEqual(["kept"]);
    });

    // Fails the sync of this folder only, and writes every sync and removal to one list, so the order is what is checked.
    const syncing = (failing: string | undefined) => {
      const events: string[] = [], state = { failing };
      return { events, state, io: {
        write: writeSync, close: closeSync,
        syncFolder: (target: string) => { events.push(`sync ${target}`); if (target === state.failing) throw new Error("EIO"); },
        rm: ((target: string, options: { force?: boolean }) => { events.push(`rm ${target}`); rmSync(target, options); }) as never,
      } };
    };
    const syncSteps = () => [markOf("bind1"), join(dir, "deleted")];

    for (const step of [0, 1]) {
      it(`deleteBinding with sync ${step + 1} of 2 failing: false and nothing removed, also on a retry that finds the mark there; files go only after both succeed`, () => {
        const path = join(dir, "bind1.ndjson");
        new BrowserActivityStore(dir, now).record(entry({ target: "kept" }));
        const steps = syncSteps(), { events, state, io } = syncing(steps[step]);
        const store = new BrowserActivityStore(dir, now, io);
        const tried = steps.slice(0, step + 1).map(target => `sync ${target}`);
        expect(store.deleteBinding("bind1")).toBe(false);
        expect(events).toEqual(tried);
        expect(existsSync(markOf("bind1"))).toBe(true);
        expect(existsSync(path)).toBe(true);
        // The retry finds the mark already there and must still sync before it removes anything.
        events.length = 0;
        expect(store.deleteBinding("bind1")).toBe(false);
        expect(events).toEqual(tried);
        expect(existsSync(path)).toBe(true);
        state.failing = undefined; events.length = 0;
        expect(store.deleteBinding("bind1")).toBe(true);
        expect(events).toEqual([`sync ${steps[0]}`, `sync ${steps[1]}`, `rm ${path}`]);
        expect(existsSync(path)).toBe(false);
        expect(targets(new BrowserActivityStore(dir, now))).toEqual([]);
      });

      it(`prune after a failed sync, with sync ${step + 1} of 2 still failing: a marked id's sources stay until its mark is safe`, () => {
        new BrowserActivityStore(dir, now).record(entry({ target: "hidden" }));
        const steps = syncSteps(), { state, io } = syncing(steps[step]);
        const store = new BrowserActivityStore(dir, now, io);
        expect(store.deleteBinding("bind1")).toBe(false);
        store.prune();
        expect(asides()).toHaveLength(1);
        expect(readFileSync(join(dir, asides()[0]!), "utf8")).toContain('"target":"hidden"');
        expect(targets(store)).toEqual([]);
        state.failing = undefined;
        store.prune();
        expect(asides()).toEqual([]);
        expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
        expect(existsSync(markOf("bind1"))).toBe(true);
      });
    }

    it("a mark written and a remove that fails: true, hidden now, and the next prune removes it", () => {
      const path = join(dir, "bind1.ndjson");
      const store = new BrowserActivityStore(dir, now, { write: writeSync, close: closeSync, rm: (() => { throw new Error("EBUSY"); }) as never });
      store.record(entry({ target: "stuck" }));
      expect(store.deleteBinding("bind1")).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(targets(store)).toEqual([]);
      store.prune();
      expect(existsSync(path)).toBe(false);
      expect(asides()).toEqual([]);
    });

    it("the service logs when a retired binding's log could not be removed", () => {
      const service = readFileSync(join(process.cwd(), "server", "browser-extension-service.ts"), "utf8");
      expect(service).toMatch(/deleteBinding\(entry\.context\.bindingId\) === false\) console\.warn\(/);
    });

    it("real processes: two appenders and two compactors that overlap them lose nothing and show nothing twice", async () => {
      const moduleUrl = pathToFileURL(join(process.cwd(), "server", "browser-extension-activity.ts")).href;
      const appendersDone = join(dir, "appenders-done");
      const roles = ["a", "b", "compact1", "compact2"];
      const run = (role: string) => new Promise<{ code: number | null; moves: number }>((resolve, reject) => {
        // A handshake makes the overlap real. Nobody starts until all four are loaded. Each appender stops at record 150 until each compactor
        // has moved a log by its own rename, in a pass begun after both appenders got there, so every compactor moved records in the middle
        // of the appends, with 300 more still to come. A child that never sees its step exits non-zero at the deadline, which fails the test.
        const script = `import { randomUUID } from "node:crypto";
import { closeSync, existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const { BrowserActivityStore } = await import(${JSON.stringify(moduleUrl)});
const dir = ${JSON.stringify(dir)}, role = ${JSON.stringify(role)}, flag = ${JSON.stringify(appendersDone)}, deadline = Date.now() + 100000;
const has = name => existsSync(join(dir, name));
const put = name => writeFileSync(join(dir, name), "");
let moves = 0, armed = false;
const store = new BrowserActivityStore(dir, Date.now, { write: writeSync, close: closeSync, afterMoveAside: moved => {
  if (!moved || !armed) return;
  moves++;
  put("moved-" + role);
} });
put("ready-" + role);
while (!${JSON.stringify(roles)}.every(other => has("ready-" + other))) { if (Date.now() > deadline) process.exit(4); }
if (role.startsWith("compact")) {
  while (!existsSync(flag)) { if (Date.now() > deadline) process.exit(5); armed = has("half-a") && has("half-b"); store.prune(); }
  process.stdout.write(String(moves));
} else for (let i = 0; i < 300; i++) {
  if (i === 150) {
    put("half-" + role);
    while (!has("moved-compact1") || !has("moved-compact2")) { if (Date.now() > deadline) process.exit(6); }
  }
  // A false is "not confirmed" and a caller writes again with the same id (the executor's fallback does), so this does too.
  const id = randomUUID();
  let tries = 0;
  while (!store.record({ id, botId: "bot1", bindingId: "bind1", taskId: "task1", site: "example.com", action: "click", target: role + i, level: 2, decision: "free" })) if (++tries > 50) process.exit(3);
}`;
        const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOME: dir, USERPROFILE: dir } });
        let out = "";
        child.stdout.on("data", chunk => { out += String(chunk); });
        child.on("error", reject); child.on("close", code => resolve({ code, moves: Number(out) || 0 }));
      });
      const compactors = [run("compact1"), run("compact2")];
      const appenders = await Promise.all([run("a"), run("b")]);
      writeFileSync(appendersDone, "");
      const compacted = await Promise.all(compactors);
      expect([...appenders, ...compacted].map(result => result.code)).toEqual([0, 0, 0, 0]);
      for (const compactor of compacted) expect(compactor.moves).toBeGreaterThan(0);
      const store = new BrowserActivityStore(dir);
      store.prune();
      const seen = store.list({ botId: "bot1", bindingId: "bind1" }).map(line => line.target);
      expect(seen).toHaveLength(600);
      expect(new Set(seen).size).toBe(600);
      expect(asides()).toEqual([]);
    }, 120_000);

    it("deleting a binding takes its asides, and another binding's aside stays", () => {
      const store = new BrowserActivityStore(dir, now);
      store.record(entry({ target: "gone" }));
      store.record(entry({ bindingId: "bind2", target: "stays" }));
      writeFileSync(join(dir, "bind1.ndjson.11111111-2222-4333-8444-555555555555.aside"), readFileSync(join(dir, "bind1.ndjson")));
      writeFileSync(join(dir, "bind2.ndjson.11111111-2222-4333-8444-555555555555.aside"), readFileSync(join(dir, "bind2.ndjson")));
      store.deleteBinding("bind1");
      expect(targets(store)).toEqual([]);
      expect(asides()).toEqual(["bind2.ndjson.11111111-2222-4333-8444-555555555555.aside"]);
      expect(targets(store, "bind2")).toEqual(["stays"]);
    });
  });

  it("recordBrowserActivity is a quiet no-op until configured and never throws", () => {
    expect(recordBrowserActivity(entry())).toBe(false);
    configureBrowserActivity(new BrowserActivityStore(join(dir, "missing", "deeper"), now));
    expect(recordBrowserActivity(entry())).toBe(true);
    // A log folder that cannot be made (its parent is a file) must not throw into the action.
    writeFileSync(join(dir, "blocker"), "x");
    configureBrowserActivity(new BrowserActivityStore(join(dir, "blocker", "child"), now));
    expect(() => recordBrowserActivity(entry())).not.toThrow();
  });
});

describe("browser activity wiring", () => {
  it("is classified as a left-out file of the browser-extension folder", () => {
    expect(Object.keys(BROWSER_EXTENSION_FILES)).toContain("activity");
    expect(classifyDataDirEntry("browser-extension")).toMatchObject({ backup: "excluded" });
  });
  it("the route is a companion route (desktop or paired phone) and shows only visible bots", () => {
    expect(routeClass("GET", "/api/bots/abc/browser-extension/activity")).toBe("companion");
    expect(conversationSubject("/api/bots/abc/browser-extension/activity")).toEqual({ scope: "bot", botId: "abc" });
  });
  it("index.ts serves it behind mayApprove, read only", () => {
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const at = index.indexOf("browser-extension\\/activity");
    expect(at).toBeGreaterThan(0);
    const block = index.slice(at, at + 900);
    expect(block).toMatch(/mayApprove\(req, url\)/);
    expect(block).toMatch(/method !== "GET"/);
    expect(index).toMatch(/join\(DATA_DIR, "browser-extension", "activity"\)/);
  });
});
