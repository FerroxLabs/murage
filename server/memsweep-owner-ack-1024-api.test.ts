// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSWEEP-1024 (ASTRA-MEMAUDIT 30), through the shipped HTTP door on a started server: POST /api/memory/action remember / correct.
// The owner's change and the index receipt that tells search about it are one step. The failure between them is a real one, not a
// mock: while the fault trigger exists the store refuses every index receipt write, exactly where the route writes it. After the
// owner's retry the memory is current AND owed to the index; the wording an edit replaced is owed to the index as replaced.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';

let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
function store<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
  try { db.exec('PRAGMA busy_timeout=10000'); return run(db); } finally { db.close(); }
}
const fault = (on: boolean) => store(db => db.exec(on
  ? "CREATE TRIGGER memsweep_receipt_fault BEFORE INSERT ON memory_projection_receipts BEGIN SELECT RAISE(ABORT,'fixture: the index receipt write failed'); END"
  : 'DROP TRIGGER memsweep_receipt_fault'));
/** The current version of a memory and whether the index was told about it. */
const current = (id: string) => store(db => {
  const row = db.prepare("SELECT version,text FROM memory_records WHERE id=? AND state='active' ORDER BY version DESC LIMIT 1").get(id) as { version: number; text: string } | undefined;
  if (!row) return { text: null, receipts: 0 };
  return { text: row.text, receipts: Number((db.prepare('SELECT count(*) AS n FROM memory_projection_receipts WHERE record_id=? AND record_version=?').get(id, row.version) as { n: number }).n) };
});
const remember = (actionId: string, text: string) => api('POST', '/api/memory/action', { action: 'remember', actionId, text });
const correct = (id: string, text: string) => api('POST', '/api/memory/action', { action: 'correct', id, version: 1, text });

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

it('W-ACK an owner remember or edit that failed at the index receipt is whole after the retry, and the replaced wording leaves the index', async () => {
  // setup (true on every sha): with no fault a remembered line is current and owed to the index
  const plain = await remember('memsweep-ack-plain', 'The fixture keeps amber crates.');
  expect(plain.status, `setup: remember works: ${JSON.stringify(plain.body)}`).toBe(200);
  expect(current(plain.body.record.id), 'setup: a remembered line has its index receipt').toMatchObject({ text: 'The fixture keeps amber crates.', receipts: 1 });
  const edited = await remember('memsweep-ack-edited', 'The fixture keeps ivory crates.');
  const swapped = await remember('memsweep-ack-swapped', 'The fixture keeps olive crates.');
  expect([edited.status, swapped.status], 'setup: two more lines remembered').toEqual([200, 200]);
  // the probe only records what the store is told: which receipts are handed back to the index as no longer current
  store(db => db.exec("CREATE TABLE memsweep_probe(id TEXT,version INTEGER); CREATE TRIGGER memsweep_archive_probe AFTER UPDATE OF lexical_status ON memory_projection_receipts WHEN NEW.lexical_status='pending-archive' BEGIN INSERT INTO memsweep_probe VALUES(NEW.record_id,NEW.record_version); END"));

  // REMEMBER: the receipt write fails once, the owner (the app) sends the same action again
  fault(true);
  const failedRemember = await remember('memsweep-ack-retry', 'The fixture keeps coral crates.');
  fault(false);
  expect(failedRemember.status, 'setup: the fault refused the remember').not.toBe(200);
  const retried = await remember('memsweep-ack-retry', 'The fixture keeps coral crates.');
  expect(retried.status, `setup: the retry is answered: ${JSON.stringify(retried.body)}`).toBe(200);
  expect.soft(current(retried.body.record.id), 'a remembered line is current AND owed to the index after the retry').toMatchObject({ text: 'The fixture keeps coral crates.', receipts: 1 });

  // EDIT: the receipt write fails once, the owner sends the same edit again
  fault(true);
  const failedEdit = await correct(edited.body.record.id, 'The fixture keeps ivory trunks.');
  fault(false);
  expect(failedEdit.status, 'setup: the fault refused the edit').not.toBe(200);
  const retriedEdit = await correct(edited.body.record.id, 'The fixture keeps ivory trunks.');
  expect.soft(retriedEdit.status, `the same edit sent again is accepted: ${JSON.stringify(retriedEdit.body)}`).toBe(200);
  expect.soft(current(edited.body.record.id), 'the edited wording is current AND owed to the index').toMatchObject({ text: 'The fixture keeps ivory trunks.', receipts: 1 });

  // an edit with no fault: the wording it replaced is handed back to the index as replaced
  const plainEdit = await correct(swapped.body.record.id, 'The fixture keeps olive trunks.');
  expect(plainEdit.status, `setup: a plain edit works: ${JSON.stringify(plainEdit.body)}`).toBe(200);
  const retired = store(db => db.prepare('SELECT id,version FROM memsweep_probe WHERE id=?').all(swapped.body.record.id));
  expect.soft(retired, 'the replaced wording (version 1) leaves the index').toEqual([{ id: swapped.body.record.id, version: 1 }]);
}, 240000);
