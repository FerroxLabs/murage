// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (MAIN-RULING SQLITE-1022 item 1a "one shared helper, witness per site"; owner: q1022-sqlite-opus). One row per
// messages.db site that removes owner-visible text (SITES.md), driven through the site's real entry on the real handle: every row the
// site removes or rewrites in the probed table is written while the connection runs secure_delete=ON (1). The connection's default is FAST
// (W1a-FAST); W1a-SITE proves ON leaves no byte of the text on disk. Memory sites: memory/sqlite-secure-delete-sites-memory-1022.test.ts.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, deleteThread, readMessage, updateMessage } from "./message-db.ts";
import { forgetDelegationsForThreads, _resetPending } from "./delegations.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { initializeApprovals, pruneRecords } from "./decision/records.ts";
import { EmailStore, type SendRow } from "./email/email-store.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { probeSecureDelete } from "./testing/secure-delete-probe.ts";
import type { Message } from "./store.ts";

const secret = "ZQX-site-marker ".repeat(400);
const DAY = 86_400_000, clock = 1_800_000_000_000;
const sendRow = (sendId: string): SendRow => ({
  sendId, botId: "b1", generation: 1, threadId: "t-b1", inboxId: "ibx_1", kind: "send", replyMessageId: null, payloadHash: `h-${sendId}`,
  summary: { to: ["a@x.test"], cc: [], subject: "s", textLength: 1, attachments: [], replySource: null }, idemSuffix: 1, state: "sent", code: null, why: null,
  stopRequested: false, ownerSent: false, replaces: null, receipt: null, revision: 1, attempts: [], heldIds: [], approvalId: null, messageId: null,
  reconcileStep: 0, dueAt: null, createdAt: clock - 400 * DAY, updatedAt: clock - 400 * DAY, dispatchedAt: null, settledAt: clock - 200 * DAY, deliveryNote: null,
});
const text = (id: string, extra: Partial<Message> = {}) => ({ id, at: 1000, role: "user", kind: "text", text: `keep ${secret}`, ...extra }) as Message;

interface Site { name: string; table: string; on: "DELETE" | { update: string }; db?: () => DatabaseSync; arrange?: (db: DatabaseSync) => void; act: (db: DatabaseSync) => void; mode?: number }
const SITES: Site[] = [
  { name: "conversation delete (message-db.ts deleteThread)", table: "messages", on: "DELETE",
    arrange: () => appendMessage("T1", text("m1")), act: () => deleteThread("T1") },
  { name: "message patch that drops text (message-db.ts updateMessage, an owner edit)", table: "messages", on: { update: "text" },
    arrange: () => appendMessage("T2", text("m2")), act: () => updateMessage("T2", { ...readMessage("T2", "m2")!, text: "keep" }) },
  { name: "message patch that drops words held only in its JSON (message-db.ts updateMessage)", table: "messages", on: { update: "json" },
    arrange: () => appendMessage("T3", text("m3", { text: "keep", removedText: secret })),
    act: () => { const { removedText: _gone, ...rest } = readMessage("T3", "m3")! as Message & { removedText?: string }; updateMessage("T3", rest as Message); } },
  { name: "control: a reply that only grows stays FAST (message-db.ts updateMessage)", table: "messages", on: { update: "text" }, mode: 2,
    arrange: () => appendMessage("T4", text("m4")), act: () => updateMessage("T4", { ...readMessage("T4", "m4")!, text: `keep ${secret} more` }) },
  { name: "upgrade blanks an unsent email draft (decision/records.ts initializeApprovals)", table: "messages", on: { update: "json" },
    arrange: db => {
      db.exec("DROP TRIGGER IF EXISTS approval_card_insert; DROP TRIGGER IF EXISTS approval_card_presented; DROP TRIGGER IF EXISTS approval_card_update");
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("T5", "m5", 1000, "bot", "options", "send?",
        JSON.stringify({ id: "m5", at: 1000, role: "bot", kind: "options", text: "send?", card: { title: "Send", options: [], emailSend: { draft: { text: secret } } } }));
    },
    act: db => initializeApprovals(db) },
  { name: "deleted conversation's handoff results (delegations.ts forgetDelegationsForThreads)", table: "delegation_packs", on: "DELETE",
    arrange: db => db.prepare("INSERT INTO delegation_packs(id,delegation_id,source_thread_id,source_bot_id,target_bot_id,refs,cut_at,created_at) VALUES('pack','job','T6','sable','ember',?,1,1)").run(JSON.stringify([secret])),
    act: () => forgetDelegationsForThreads(["T6"]) },
  { name: "owner deletion record drops the conversation's hand-offs (owner-deletions.ts recordOwnerDeletion, bot and channel deletion)", table: "delegation_packs", on: "DELETE",
    arrange: db => db.prepare("INSERT INTO delegation_packs(id,delegation_id,source_thread_id,source_bot_id,target_bot_id,refs,cut_at,created_at) VALUES('pack8','job8','T8','sable','ember',?,1,1)").run(JSON.stringify([secret])),
    act: db => { recordOwnerDeletion(db, "T8"); } },
  { name: "approval retention deletes settled records (decision/records.ts pruneRecords, hourly in decision/implementation.ts)", table: "approval_records", on: "DELETE",
    arrange: db => {
      const columns = db.prepare("PRAGMA table_info(approval_records)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
      const row: Record<string, string | number> = { id: "r7", state: "answered", delivery: "none", why: "question", answer: secret, evidence: JSON.stringify({ action: { emailSend: { draft: { text: secret } } } }), created_at: 1, settled_at: 1 };
      for (const column of columns) if (column.notnull && column.dflt_value === null && !(column.name in row)) row[column.name] = /INT/i.test(column.type) ? 1 : `x-${column.name}`;
      db.prepare(`INSERT INTO approval_records(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    },
    act: db => { expect(pruneRecords(db, clock)).toBe(1); } },
];

let own: DatabaseSync | null = null;
beforeEach(async () => { closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(async () => { own?.close(); own = null; closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); });

for (const site of SITES) {
  it(`SITE ${site.name}`, { timeout: 30_000 }, () => {
    const db = site.db ? site.db() : database();
    site.arrange?.(db);
    expect(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete), "the connection's default is FAST").toBe(2);
    const probe = probeSecureDelete(db, site.table, site.on);
    try { site.act(db); } finally { probe.stop(); }
    expect(probe.modes.length, `${site.name}: reached its write`).toBeGreaterThan(0);
    expect(probe.modes, `${site.name}: ran at secure_delete ${site.mode ?? 1} (1 ON, 2 FAST)`).toEqual(probe.modes.map(() => site.mode ?? 1));
  });
}

it("SITE sent mail retention (email/email-store.ts pruneSettledSends)", () => {
  own = new DatabaseSync(":memory:");
  own.exec("PRAGMA secure_delete=FAST");
  const store = new EmailStore(own);
  store.insertSend(sendRow("s1"));
  store.putPayload("s1", [{ part: 0, name: null, contentType: "text/plain", size: secret.length, sha256: "0".repeat(64), data: new TextEncoder().encode(secret) }]);
  const probe = probeSecureDelete(own, "email_payloads");
  try { store.pruneSettledSends(clock); } finally { probe.stop(); }
  expect(probe.modes.length, "pruneSettledSends: reached its delete").toBeGreaterThan(0);
  expect(probe.modes, "pruneSettledSends: ran at secure_delete ON").toEqual(probe.modes.map(() => 1));
});
