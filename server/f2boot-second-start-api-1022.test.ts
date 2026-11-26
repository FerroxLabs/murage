// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-f2boot-fable (where the quarantine version stamps are kept, memory/revoke-marker.ts writeQuarantineStamp). Owner of the other
// side (the start-time retry rule and the job quarantine itself): q1022-revokehealth-opus. Owner of the schema check: memory/schema.ts.
// F2BOOT (1.0.22 re-cut 7a0f134ff9): the start at listen made a table the schema does not list (memory_revoke_quarantine), so the NEXT
// start of the same data folder was refused by validateMemorySchema and ended before listen. Through the real server: a data folder is
// started three times with a quarantined forget in it; every start reaches listen, the start stamps the job with the running version in a
// memory_scope_bindings row, no memory object outside the schema is left behind, and a start of the same version never retries the job.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { runningAppVersion } from "./memory/app-version.ts";

let fixture: VerificationServer;
beforeAll(async () => { fixture = await launchVerificationServer(process.env); }, 60000);
afterAll(async () => { await fixture?.close(); });
const owedIds = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const body = await (await fetch(`${fixture.info.url}/api/deletions/owed`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } })).json() as { notices: Array<{ id: string }> };
  return body.notices.map(notice => notice.id);
};
const read = <T>(run: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db")); try { db.exec("PRAGMA busy_timeout=5000"); return run(db); } finally { db.close(); } };
const stampOf = (id: number) => read(db => db.prepare("SELECT json_extract(intent,'$.version') AS version FROM memory_scope_bindings WHERE id=?").get(`memory-revoke-quarantine:${id}`)?.version ?? null);
const stateOf = (id: number) => read(db => db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.state ?? null);
/** A restart that says how it ended: "listening", or the first words of why the server did not come up. */
const startAgain = () => fixture.restart().then(() => "listening", (error: unknown) => String((error as Error)?.message ?? error).split(";")[0]);

/** Where this build's listen-time pass left the job's version stamp once it has run: "bindings" (a memory_scope_bindings row), "table" (the
 * unlisted table of the first cut), or "none" after 20 s. Never throws: the assertions below judge it. */
const stampedWhere = async () => {
  for (const end = Date.now() + 20_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) {
    if (stampOf(990002) !== null) return "bindings";
    if (read(db => db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_revoke_quarantine'").get())) return "table";
  }
  return "none";
};

it("W-SECOND-START a data folder with a quarantined forget starts again and again: every start listens, the stamp is a bindings row", async () => {
  expect(runningAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  // a forget quarantined with no stamp (as when the version could not be read): the next start's listen pass stamps it with the running version
  read(db => db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(990002,'line','{}',1,1,'mark','','quarantined')").run());
  const second = await startAgain();
  // the second start's listen pass has run (it saw the job), wherever this build keeps the stamp
  const where = second === "listening" ? await stampedWhere() : "not started";
  const third = second === "listening" ? await startAgain() : "not tried";
  // base 7a0f134ff9: the start after a listen pass is "verification server exited before it was ready" (MEMORY_SCHEMA_UNSUPPORTED at the store's open)
  expect([second, third]).toEqual(["listening", "listening"]);
  // the stamp is a row of a table every build knows, written by the second start, and nothing outside the schema was made
  expect([where, stampOf(990002)]).toEqual(["bindings", runningAppVersion()]);
  expect(read(db => db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_revoke_quarantine%'").all())).toEqual([]);
  // the same version never retries the job, and the owner is still told
  expect(stateOf(990002)).toBe("quarantined");
  await expect.poll(owedIds, { timeout: 15000 }).toContain("revoke:quarantined");
}, 180000);
