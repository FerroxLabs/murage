// D1 is SQLite. This runs the relay's own migration on node:sqlite so the
// SQL is tested for real, without miniflare or a Cloudflare account.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, DbStatement } from "../src/db";

type Exec = DbStatement & { exec(): { changes: number } };

export function sqliteD1(raw = new DatabaseSync(":memory:")): Db & { raw: DatabaseSync } {
  raw.exec("PRAGMA foreign_keys=ON");
  const statement = (sql: string, values: SQLInputValue[] = []): Exec => ({
    bind: (...next: unknown[]) => statement(sql, next as SQLInputValue[]),
    first: async <T>() => ((raw.prepare(sql).get(...values) as T | undefined) ?? null),
    all: async <T>() => ({ results: raw.prepare(sql).all(...values) as T[] }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }),
    exec: () => ({ changes: Number(raw.prepare(sql).run(...values).changes) }),
  });
  return {
    raw,
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      raw.exec("BEGIN");
      try {
        const out = list.map((s) => ({ meta: (s as Exec).exec() }));
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function migrated(): Db & { raw: DatabaseSync } {
  const db = sqliteD1();
  // A plain path, not `new URL(...)`: with both @cloudflare/workers-types
  // and node's types loaded and no "dom" lib, the ambient global URL
  // resolves to the Workers Fetch URL, not node:url's, and node:fs's
  // PathLike (unqualified `URL`) then rejects it under --strict.
  const dir = join(import.meta.dirname, "../migrations");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) db.raw.exec(readFileSync(join(dir, file), "utf8"));
  return db;
}
