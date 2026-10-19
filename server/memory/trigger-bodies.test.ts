// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Some SQLite builds refuse a qualified table name (main.x) in the BODY of a trigger; a TEMP trigger may name main.<table> only in its ON clause.
// The 48 GB probe crashed at boot on exactly that. The scan is by source, so it holds on any SQLite build; the boot test uses the real initializer.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sources = (): string[] => {
  const out = [join(here, "..", "app-write-revision.ts"), join(here, "..", "database.ts")];
  for (const dir of [here, join(here, "..")]) for (const f of readdirSync(dir)) if (f.endsWith(".ts") && !f.includes(".test.")) out.push(join(dir, f));
  return [...new Set(out)];
};

it("no trigger body in the branch names a qualified table", () => {
  const bad: string[] = [];
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/CREATE (?:TEMP |TEMPORARY )?TRIGGER[\s\S]*?\bEND;?/gi)) {
      const body = m[0].replace(/^[\s\S]*?\bBEGIN\b/i, "");
      if (/\b(UPDATE|INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM)\s+(main|temp)\./i.test(body)) bad.push(`${file}: ${m[0].slice(0, 100)}`);
    }
    for (const m of text.matchAll(/^const (BUMP|NOTE|STRUCT|PIN_BUMP|SOFT_BUMP|bump)\b.*$/gm)) if (/\b(main|temp)\./i.test(m[0])) bad.push(`${file}: ${m[0]}`);
  }
  expect(bad).toEqual([]);
});

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
it("the real initializer boots on an on-disk file, reopens it, and a counted write moves the revision", () => {
  const first = database();
  first.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m1',1,'user','text','x','{}')").run();
  const n = () => Number(database().prepare("SELECT n FROM app_write_revision WHERE id=1").get()!.n);
  const before = n();
  expect(before).toBeGreaterThan(0);
  closeDatabase();
  const again = database(); // second boot over the existing file
  again.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m2',2,'user','text','y','{}')").run();
  expect(n()).toBeGreaterThan(before);
});
