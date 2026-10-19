// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lineage S6 rule 28 (test 35, the grep part): session numbers are never deleted or reused, and no incarnation or session row is taken
// back. memory_session_no and memory_session_incarnation are append-only (no DELETE, no REPLACE, no UPDATE); memory_session_lineage rows
// are never deleted or replaced (its one UPDATE moves last_lsn). So ensureSessionNo's max-plus-one never hands out a number a
// memory_receipt_lines.session_no still names, and the allocator never hands out an n twice. A schema downgrade to a build that lacks a
// table drops the whole table (schema.ts), which is not a row being taken back.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
function serverFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "testing" && name !== "testdata" && name !== "node_modules") serverFiles(path, out); }
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const APPEND_ONLY = /\b(?:DELETE\s+FROM|REPLACE\s+INTO|UPDATE)\s+(?:OR\s+\w+\s+)?(memory_session_no|memory_session_incarnation)\b/gi;
const NEVER_DELETED = /\b(?:DELETE\s+FROM|REPLACE\s+INTO)\s+(memory_session_lineage)\b/gi;
/** Statements that would take a session row back, as `file:line table`. */
function sessionRowTakers(text: string, rel: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const re of [APPEND_ONLY, NEVER_DELETED]) for (const m of line.matchAll(re)) hits.push(`${rel}:${i + 1} ${m[1]}`);
  });
  return hits;
}

it("the matcher catches each way a row could be taken back (it is not vacuous)", () => {
  expect(sessionRowTakers("db.exec(`DELETE FROM memory_session_no WHERE no=?`)", "x")).toEqual(["x:1 memory_session_no"]);
  expect(sessionRowTakers("INSERT OR REPLACE INTO memory_session_incarnation(n) VALUES(1)", "x")).toEqual(["x:1 memory_session_incarnation"]);
  expect(sessionRowTakers("UPDATE memory_session_no SET no=1", "x")).toEqual(["x:1 memory_session_no"]);
  expect(sessionRowTakers("delete from memory_session_lineage where 1", "x")).toEqual(["x:1 memory_session_lineage"]);
  expect(sessionRowTakers("UPDATE memory_session_lineage SET last_lsn=MAX(last_lsn,?)", "x")).toEqual([]);
});

it("nothing in the server deletes, replaces or renumbers a row of memory_session_no, memory_session_incarnation or memory_session_lineage", () => {
  const hits = serverFiles(ROOT).flatMap(file => sessionRowTakers(readFileSync(file, "utf8"), file.slice(ROOT.length + 1)));
  expect(hits).toEqual([]);
});
