import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2]);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const original = join(root, 'data'), userData = join(root, 'user-data');
for (const [name, expected] of Object.entries(json(join(root, 'evidence', 'source-files.json')))) {
  const file = join(original, name), stat = statSync(file, { bigint: true });
  assert.equal(hash(file), expected.sha256, `Original bytes changed: ${name}`);
  assert.equal(String(stat.dev), expected.dev); assert.equal(String(stat.ino), expected.ino);
}
const selectors = readdirSync(userData).filter(name => /^installation-selection-[a-f0-9]{64}\.json$/.test(name));
assert.equal(selectors.length, 1);
const selectorFile = join(userData, selectors[0]), selector = json(selectorFile);
assert.equal(selector.requestedRoot.toLowerCase(), original.toLowerCase());
assert.equal(selector.originalRoot.toLowerCase(), original.toLowerCase());
assert.match(selector.id, /^[a-f0-9-]{36}$/);
const container = join(userData, 'recovered-installations', selector.id), restored = join(container, 'data');
assert.equal(readFileSync(join(container, 'selection-record.json'), 'utf8'), readFileSync(selectorFile, 'utf8'));
const review = json(join(restored, 'restore-review.json'));
assert.equal(review.status, 'review-required');
const receipt = json(join(container, `.data.restore-${review.transactionId}.receipt.json`));
assert.equal(receipt.phase, 'candidate-installed'); assert.equal(receipt.hadOriginal, false);
const expectedArchiveHash = hash(join(root, 'exports', 'backup.age'));
const inspected = json(join(root, 'evidence', 'inspect-ui.json'));
assert.equal(inspected.snapshotId, selector.snapshotId); assert.equal(inspected.archiveSha256, expectedArchiveHash);
for (const record of [selector, review, receipt]) {
  assert.equal(record.archiveSha256, expectedArchiveHash);
  assert.equal(record.snapshotId, selector.snapshotId);
}
assert.equal(selector.transactionId, review.transactionId); assert.equal(receipt.id, review.transactionId);
const connections = json(join(restored, 'restored-connections.json'));
assert.equal(connections.version, 1); assert.match(connections.id, /^[a-f0-9-]{36}$/);
const config = json(join(restored, 'config.json'));
assert.equal(config.engineDiscovery, 'explicit');
for (const instance of Object.values(config.instances)) assert.equal(instance.enabled, false);
assert(!JSON.stringify(config).includes('FAKE-B20-PRIVATE-CANARY'));
for (const bot of json(join(restored, 'bots.json'))) {
  assert.equal(bot.autoApprove, false); assert.deepEqual(bot.resumeCursors, {});
}
assert.equal(readFileSync(join(restored, 'workspaces', 'report.md'), 'utf8'), 'B20 synthetic saved output\n');
const db = new DatabaseSync(join(restored, 'messages.db'), { readOnly: true });
try {
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE id='receipt'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE id='b20-tombstone'").get().n, 1);
  assert.equal(db.prepare('SELECT mode FROM memory_meta WHERE id=1').get().mode, 'paused');
} finally { db.close(); }
writeFileSync(join(root, 'evidence', 'data-verification.json'), JSON.stringify({ ok: true, restored, snapshotId: selector.snapshotId, archiveSha256: expectedArchiveHash, originalFilesUnchanged: true, paused: true, transcriptReceipt: true, tombstone: true }) + '\n', { flag: 'wx' });
