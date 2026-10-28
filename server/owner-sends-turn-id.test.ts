// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §5 (steers) and P14: a steer the engine took keeps the provider turn it went into on its send row
// (`owner_sends.turn_id`, an additive column), so the line recovery writes after a failed append or a restart still names it;
// a late confirmation stamps the row and a late refusal leaves it unstamped. The column is appended like the six before it: an
// archive from an earlier 1.0.2 build (without it) still restores, and going back to 1.0.1 drops the whole table as before.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { APP_SCHEMA_102_ADDITIONS, downgradeApplicationSchemaTo101, DOWNGRADE_WORK_PENDING } from "./installation-app-schema-downgrade.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { initializeOwnerSends, recoveredSteerLine, sendStore, type SendRow } from "./send-store.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { reconcileLateSteer, type LateSteerDeps } from "./steer-late.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
const handles: DatabaseSync[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "turn-id-")); dirs.push(dir); return dir; };
const open = (file: string) => { const db = new DatabaseSync(file); handles.push(db); return db; };
beforeEach(() => sendStore.reset());
afterEach(() => {
  sendStore.reset();
  for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) removeTempDirSync(d);
});

describe("a delivered steer's turn on its send row", () => {
  it("P14: the steer was delivered, its line could not be written, Murage restarted: the recovered line carries dispatchedIn", () => {
    const file = join(scratch(), "messages.db");
    let db = open(file);
    sendStore.use(() => db);
    const accepted = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text: "and also this", sendId: "s1", fingerprint: sendFingerprint("and also this") });
    const seq = accepted.row.seq;
    sendStore.markDispatched(seq);
    sendStore.setTurnId(seq, "T1");
    // the append threw: the row keeps the words as unconfirmed
    sendStore.settle(seq, "unconfirmed");
    // restart
    db.close(); sendStore.reset();
    db = open(file); sendStore.use(() => db);
    const { unresolved } = sendStore.recover();
    expect(unresolved.map((row) => [row.seq, row.turnId])).toEqual([[seq, "T1"]]);
    const written: Array<Record<string, unknown>> = [];
    sendStore.completeUnresolved(unresolved, { landed: () => undefined, appendReceipt: (row: SendRow) => { written.push(recoveredSteerLine(row, "steer-x")); } });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ role: "user", text: "and also this", steered: true, dispatchedIn: "T1" });
  });

  it("a row with no turn (an uncertain steer) is recovered without a stamp", () => {
    const db = open(join(scratch(), "messages.db"));
    sendStore.use(() => db);
    const { row } = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text: "maybe", sendId: "s2", fingerprint: sendFingerprint("maybe") });
    expect(row.turnId).toBeNull();
    expect(recoveredSteerLine(row, "x")).not.toHaveProperty("dispatchedIn");
  });

  it("P14: a late confirmation stamps the row with the turn; a late refusal leaves it unstamped", () => {
    const patches: Array<Record<string, unknown>> = [];
    const deps: LateSteerDeps = {
      botExists: () => true, patchMessage: (_t, _m, patch) => { patches.push(patch); return null; },
      delivered: () => {}, passedByLater: () => false, requeue: () => {}, fail: () => {}, release: () => {}, drain: () => {},
    };
    reconcileLateSteer(deps, { botId: "b", threadId: "t", seq: 1, messageId: "m", turnId: "T1" }, "delivered");
    expect(patches.at(-1)).toEqual({ steerUnconfirmed: false, dispatchedIn: "T1" });
    reconcileLateSteer(deps, { botId: "b", threadId: "t", seq: 2, messageId: "m2" }, "rejected");
    expect(patches.at(-1)).not.toHaveProperty("dispatchedIn");
  });
});

describe("owner_sends.turn_id is additive", () => {
  it("a table from an earlier build gains the column; an archive written before it still restores", async () => {
    const root = scratch();
    const data = join(root, "installation");
    mkdirSync(data);
    const db = open(join(data, "messages.db"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    initializeMessageTables(db);
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "bot", "goal.run", null, JSON.stringify({ id: "m", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Receipt canary" } }));
    db.exec("INSERT INTO thread_state VALUES ('t','m')");
    initializeOwnerSends(db);
    // a 1.0.8 build: turn_id but none of the 1.0.9 via columns
    for (const column of ["attachments", "via_device", "queue_only", "via"]) db.exec(`ALTER TABLE owner_sends DROP COLUMN ${column}`);
    expect(await snapshotInstallationDatabase(data, join(root, "prior.db"))).toMatchObject({ status: "copied" });
    // an earlier 1.0.2 build: everything but turn_id (and the via columns)
    db.exec("ALTER TABLE owner_sends DROP COLUMN turn_id");
    expect(await snapshotInstallationDatabase(data, join(root, "older.db"))).toMatchObject({ status: "copied" });
    // the current build adds it on open, and that archive restores too
    initializeOwnerSends(db);
    const columns = (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map((column) => column.name);
    // turn_id comes back first, then the 1.0.9 via columns, all appended by ALTER in that order (an earlier archive keeps restoring)
    expect(columns.slice(-5)).toEqual(["turn_id", "via", "queue_only", "via_device", "attachments"]);
    expect(await snapshotInstallationDatabase(data, join(root, "current.db"))).toMatchObject({ status: "copied" });
  });

  it("going back to 1.0.1 drops the whole owner_sends table (turn_id with it) on the installation's own database, and refuses while a send waits", () => {
    // 1.0.1 never sees the column: owner_sends is a 1.0.2 table in the downgrade manifest (APP_SCHEMA_102_ADDITIONS), and preparation drops it whole.
    expect(APP_SCHEMA_102_ADDITIONS.tables).toContain("owner_sends");
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const db = database();
    const columns = (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("turn_id");
    db.prepare("INSERT INTO owner_sends (kind, owner_id, thread_id, send_id, queue_id, fingerprint, text, status, created_at, updated_at, turn_id) VALUES ('bot','b','t','s','q','f','waiting','queued',1,1,'T1')").run();
    expect(() => downgradeApplicationSchemaTo101(db, DATA_DIR)).toThrow(expect.objectContaining({ code: DOWNGRADE_WORK_PENDING }));
    expect(db.prepare("SELECT turn_id FROM owner_sends").get()).toEqual({ turn_id: "T1" });
    db.exec("UPDATE owner_sends SET status='delivered', text='', message_id='m'");
    downgradeApplicationSchemaTo101(db, DATA_DIR);
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='owner_sends'").get()).toBeUndefined();
    closeDatabase();
  });
});
