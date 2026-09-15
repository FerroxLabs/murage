// Task-only offline data generator. Never imported by the packaged application.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeMessageTables } from '../../../server/message-tables.ts';
import { initializeImageOperations } from '../../../server/image-operations-schema.ts';
import { migrateMemorySchema } from '../../../server/memory/schema.ts';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !root.endsWith('real-main-qualification')) throw Error('Explicit fresh qualification root required');
mkdirSync(root); // Exclusive: never adopt a prior invocation.
for (const name of ['data', 'user-data', 'home', 'temp', 'exports', 'keys', 'evidence']) mkdirSync(join(root, name));
const data = join(root, 'data');
const json = (name: string, value: unknown) => writeFileSync(join(data, name), JSON.stringify(value) + '\n', { flag: 'wx' });
json('config.json', { profile: { name: 'Synthetic Windows backup' }, instances: { fixture: { driver: 'fuigoAgent', enabled: true, config: { apiKey: 'FAKE-B20-PRIVATE-CANARY' } } } });
json('bots.json', [{ id: 'bot', threadId: 'thread', name: 'Synthetic', autoApprove: true, resumeCursors: { fixture: 'synthetic' } }]);
json('groups.json', []);
json('startup-background.json', { keepRunning: true, startAtLogin: true });
mkdirSync(join(data, 'workspaces'));
writeFileSync(join(data, 'workspaces', 'report.md'), 'B20 synthetic saved output\n', { flag: 'wx' });
const db = new DatabaseSync(join(data, 'messages.db'));
try {
  initializeMessageTables(db); initializeImageOperations(db); migrateMemorySchema(db, 'active');
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('thread', 'receipt', 1, 'bot', 'goal.run', null,
    JSON.stringify({ id: 'receipt', at: 1, role: 'bot', kind: 'goal.run', goalRun: { status: 'completed', detail: 'B20 synthetic receipt' } }));
  db.exec("INSERT INTO thread_state VALUES('thread','receipt')");
  db.prepare('INSERT INTO memory_tombstones(id,target_type,target_id,epoch,reason,created_at) VALUES(?,?,?,?,?,?)')
    .run('b20-tombstone', 'source', 'synthetic-deleted-source', 1, 'synthetic deletion', 1);
  db.exec('UPDATE memory_meta SET deletion_epoch=1 WHERE id=1');
} finally { db.close(); }
const files: Record<string, { sha256: string; dev: string; ino: string }> = {};
function inventory(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else { const stat = statSync(file, { bigint: true }); files[relative(data, file).replaceAll('\\', '/')] = {
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), dev: String(stat.dev), ino: String(stat.ino),
    }; }
  }
}
inventory(data);
writeFileSync(join(root, 'evidence', 'source-files.json'), JSON.stringify(files, null, 2) + '\n', { flag: 'wx' });
