// The cache triggers install on the real node:sqlite database (SQLite forbids a
// qualified write target inside a trigger body on the versions that enforce it),
// installation is observable, and the caches survive a write they do not rest on.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { provenanceStamp, provenanceTriggersInstalled } from "./provenance-stamp.ts";
import { lineageTriggersInstalled } from "./replay-lineage.ts";
import type { Message } from "../store.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

it("no trigger body qualifies its write target", () => {
  for (const file of ["provenance-stamp.ts", "replay-lineage.ts"]) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(text).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+temp\.\w+[^"`]*(SET|VALUES|SELECT)[^`]*END;/);
    expect(text).not.toMatch(/"UPDATE temp\./);
    expect(text).not.toMatch(/INSERT INTO temp\.lineage_dirty (VALUES|SELECT)/);
  }
});

it("the provenance and identity triggers install on the real database and the stamp survives an unrelated write", () => {
  const db = database();
  expect(provenanceTriggersInstalled(db)).toBe(true);
  const triggers = db.prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND (name LIKE 'prov_%' OR name LIKE 'ident_%')").all();
  expect(triggers.length).toBeGreaterThan(20);
  const before = provenanceStamp(db);
  expect(before).toBeDefined();
  appendMessage("t", { id: "m1", role: "user", kind: "text", text: "unrelated", at: 1 } as Message);
  expect(provenanceStamp(db)).toBe(before);
  db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1");
  expect(provenanceStamp(db)).not.toBe(before);
});

it("the lineage triggers install on the real database", () => {
  expect(lineageTriggersInstalled()).toBe(true);
  const names = database().prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'lineage_%'").all();
  expect(names.length).toBeGreaterThan(15);
});

it("a failed install is reported, once, and the flag says so", () => {
  const bare = new DatabaseSync(":memory:");
  const warn: string[] = []; const original = console.warn; console.warn = (...a: unknown[]) => { warn.push(a.join(" ")); };
  try {
    expect(provenanceStamp(bare)).toBeUndefined();
    expect(provenanceStamp(bare)).toBeUndefined();
    expect(provenanceTriggersInstalled(bare)).toBe(false);
  } finally { console.warn = original; }
  expect(warn.filter(line => line.includes("provenance")).length).toBe(1);
});
