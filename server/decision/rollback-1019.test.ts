import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { closeDatabase } from '../database.ts';
import { settleTestHandles } from '../test-handle-registry.ts';
import { downgradeInstallationMemorySchema } from '../installation-memory-downgrade.ts';
import { APPROVAL_OBJECTS, initializeApprovals } from './records.ts';
import { fixture, d, card, baseCard } from './fixture.ts';

const legacy = { id: 'legacy118', at: 1, role: 'bot', kind: 'options', card: { requestId: 'r118', title: 'Allow?', options: ['Allow', 'Deny'] } };
function approve118(db: DatabaseSync) {
  db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t',legacy.id,1,'bot','options',JSON.stringify(legacy));
  db.prepare("UPDATE messages SET json=json_set(json,'$.card.answered','Allow') WHERE id=?").run(legacy.id);
  expect(JSON.parse(String(db.prepare('SELECT json FROM messages WHERE id=?').get(legacy.id)!.json)).card.answered).toBe('Allow');
}
it('D1 a 1.0.18 connection can insert and answer cards with inherited 1.0.19 triggers', async () => {
  const f = fixture();
  // 1.0.19 still rejects raw unregistered cards on its own connection.
  expect(() => approve118(f.db)).toThrow('card-without-approval');
  closeDatabase(); await settleTestHandles(DATA_DIR);
  const older = new DatabaseSync(join(DATA_DIR, 'messages.db'));
  try { approve118(older); } finally { older.close(); }
});
it.each([13,10] as const)('D1 production downgrade --to %s removes every approval object and allows 1.0.18 cards', async to => {
  const f = fixture(); const ref = card(d.decide(f.open('r', {command:'rm -rf ~'}),baseCard));
  await d.presentApproval(ref,{title:'Pending',subtitle:'Fixture'});
  closeDatabase(); await settleTestHandles(DATA_DIR);
  downgradeInstallationMemorySchema(DATA_DIR,to);
  const older = new DatabaseSync(join(DATA_DIR,'messages.db'));
  try {
    for (const name of Object.values(APPROVAL_OBJECTS).flat()) expect(older.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(name),name).toBeUndefined();
    expect(older.prepare('PRAGMA table_info(owner_sends)').all().map(column=>column.name)).not.toContain('via_proof');
    const pending = older.prepare("SELECT json FROM messages WHERE kind='options'").all().map(row=>JSON.parse(String(row.json))).find(row=>row.card.approvalId===ref.approvalId);
    expect(pending.card.answered).toBe('Cancelled (version change)');
    expect(pending.card.orphaned).toBe(true);
    approve118(older);
  } finally { older.close(); }
},120000);
it('D1 reinstalling the approval guards is idempotent', () => { const f=fixture(); const version=f.db.prepare('PRAGMA schema_version').get(); initializeApprovals(f.db); initializeApprovals(f.db); expect(f.db.prepare('PRAGMA schema_version').get()).toEqual(version); expect(()=>approve118(f.db)).toThrow('card-without-approval'); });
