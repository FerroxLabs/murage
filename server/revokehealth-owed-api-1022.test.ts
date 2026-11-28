// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (the revoke-health notices on GET /api/deletions/owed, index.ts). Consumer owner: the desktop deletions banner.
// 1.0.22 MUST-FIX item 1 through the real server: a quarantined revoke job (revoke-marker.ts quarantineFailingJobs, witnessed on the runner in
// memory/revokehealth-1022.test.ts W-QUARANTINE) is told to the owner on the owed list, in fixed words, next to the deletion notices.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { runningAppVersion } from "./memory/app-version.ts";
import { writeQuarantineStamp } from "./memory/revoke-marker.ts";

let fixture: VerificationServer, headers: Record<string, string>;
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });
const settle = async (check: (ids: string[]) => boolean) => { const end = Date.now() + 5_000; while (Date.now() < end && !check((await owed()).notices.map(item => item.id))) await new Promise(resolve => setTimeout(resolve, 100)); };
const owed = async () => (await (await fetch(`${fixture.info.url}/api/deletions/owed`, { headers })).json()) as { notices: Array<{ id: string; text: string; tryAgain: boolean }> };

it("W-OWED-ROUTE the booted server's GET /api/deletions/owed carries the quarantined-forget notice, and drops it once the job is gone", async () => {
  expect((await owed()).notices.map(notice => notice.id)).not.toContain("revoke:quarantined");
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(990001,'line','{}',1,1,'mark','','quarantined')").run();
    // stamped by the running version, as quarantineFailingJobs does: the start-time retry (revoke-marker.ts retryQuarantinedOnNewVersion,
    // run when the runner's listen wake lands, which may be after this insert) leaves a same-version job quarantined
    // 1.0.22 f2boot: the stamp is a memory_scope_bindings row (revoke-marker.ts writeQuarantineStamp), never a table of its own
    writeQuarantineStamp(db, 990001, runningAppVersion());
    // the row is written from outside the server's connection: the route is read until it shows (or 5 s pass)
    await settle(ids => ids.includes("revoke:quarantined"));
    const notice = (await owed()).notices.find(item => item.id === "revoke:quarantined");
    // base 68ed0def17: the route lists deletion notices only
    expect(notice).toMatchObject({ id: "revoke:quarantined", tryAgain: false });
    expect(notice!.text).toBe("Murage couldn't finish forgetting one item. It stays hidden from your bots, and nothing comes back.");
    db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=990001").run();
    await settle(ids => !ids.includes("revoke:quarantined"));
    expect((await owed()).notices.map(item => item.id)).not.toContain("revoke:quarantined");
  } finally { db.close(); }
}, 60000);
