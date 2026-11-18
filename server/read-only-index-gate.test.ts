// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md row A5): the look a read-only start takes at the database file before anything is written.
// A file the look cannot read ends the start there: going on would let the lease, the roots and the stores write before the open path meets the same file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { TURN_INDEX, TurnIndexNotReadyError } from "./message-tables.ts";
import { assertRequiredIndexesForReadOnlyStart } from "./read-only-index-gate.ts";
import { enterReadOnly, isReadOnly } from "./read-only-start.ts";

describe("the read-only start's index look", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-index-gate-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dirWith = (name: string, write: (file: string) => void) => { const dir = mkdtempSync(join(root, `${name}-`)); write(join(dir, "messages.db")); return dir; };

  it("a normal start does not look", () => {
    expect(isReadOnly()).toBe(false);
    expect(() => assertRequiredIndexesForReadOnlyStart(dirWith("normal", file => writeFileSync(file, "not a database, sixteen bytes and more")))).not.toThrow();
  });

  it("read-only: no file passes, the index present passes, the index missing stops the start, an unreadable file stops the start", () => {
    enterReadOnly("index-gate-fixture");
    expect(() => assertRequiredIndexesForReadOnlyStart(mkdtempSync(join(root, "first-")))).not.toThrow();
    const seeded = (index: boolean) => dirWith(index ? "present" : "missing", file => {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE messages(thread_id TEXT, json TEXT)"); if (index) db.exec(`CREATE INDEX ${TURN_INDEX} ON messages(thread_id)`);
      db.close();
    });
    expect(() => assertRequiredIndexesForReadOnlyStart(seeded(true))).not.toThrow();
    expect(() => assertRequiredIndexesForReadOnlyStart(seeded(false))).toThrow(TurnIndexNotReadyError);
    const unreadable = dirWith("unreadable", file => writeFileSync(file, "not a database, sixteen bytes and more".repeat(200)));
    let thrown: unknown;
    try { assertRequiredIndexesForReadOnlyStart(unreadable); } catch (error) { thrown = error; }
    expect(thrown, "the look's own failure is not swallowed").toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TurnIndexNotReadyError);
  });
});
