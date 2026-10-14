// SPDX-License-Identifier: AGPL-3.0-or-later
// The real Murage 1.0.1 code (git archive d950cbf67, extracted into the gitignored .v101-ref directory of the worktree before a run), for tests that
// check the downgrade against what 1.0.1 itself accepts. Test data only; never imported by the server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const V101 = join(process.cwd(), ".v101-ref");
export const haveV101 = existsSync(join(V101, "server", "installation-database-snapshot.ts"));

/** The 1.0.1 inspector and reference schema. referenceSchema() is module-private in 1.0.1; the copy beside it only adds `export` (and `rawSchema`, the same
 * initializers read back raw: the executable definitions, comments and line breaks intact, that the frozen manifest keeps beside the normalized text). */
export async function realV101() {
  const source = readFileSync(join(V101, "server", "installation-database-snapshot.ts"), "utf8").replace("function referenceSchema()", "export function referenceSchema()")
    + `\nexport function rawSchema(){ const db=new DatabaseSync(":memory:"); try { initializeMessageTables(db); initializeInbox(db); initializeArtifacts(db); initializeImageOperations(db); initializeImageLibrary(db); initializeThreadSnooze(db); initializeProjectTables(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Array<{ name: string; sql: string | null }>; } finally { db.close(); } }\n`;
  writeFileSync(join(V101, "server", "installation-database-snapshot.export.ts"), source);
  const specifier = "../../.v101-ref/server/installation-database-snapshot.export.ts";   // a variable: the type check never reads the 1.0.1 tree
  return await import(/* @vite-ignore */ specifier) as {
    inspectInstallationDatabase(db: DatabaseSync): unknown;
    referenceSchema(): Map<string, { type: string; table: string; sql: Set<string | null>; columns: string[][] }>;
    rawSchema(): Array<{ name: string; sql: string | null }>;
  };
}
