import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { removeTempDir } from './testing/cleanup.ts';
import { ensureGH18Operations } from './memory/schema.ts';
import { registeredSnapshotObjects } from './installation-database-snapshot.ts';

it('gh18_actual_1018_validator_opens_audit_database_with_marks_intact', async () => {
  const raw = readFileSync(new URL('./memory/testing/schema-1.0.18.ts.txt', import.meta.url), 'utf8');
  // Exact released/base module, before GH18; only its relative import locations
  // are adapted to this isolated temporary module. Its validator is untouched.
  expect(createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex')).toBe('23f5cc9c83ba009661c32c867b3503492f39d9ae');
  const original = new URL('./memory/schema.ts', import.meta.url);
  const relocated = raw.replace(/from (["'])(\.[^"']+)\1/g, (_all, quote, relative) => `from ${quote}${new URL(relative, original).href}${quote}`);
  const scratch = mkdtempSync(join(tmpdir(), 'gh18-released-validator-'));
  try {
    const source = join(scratch, 'schema-1018.mts'); writeFileSync(source, relocated);
    const old = await import(/* @vite-ignore */ pathToFileURL(source).href);
    const db = new DatabaseSync(join(scratch, 'memory.db'));
    try {
      old.migrateMemorySchema(db);
      expect(() => old.validateMemorySchema(db)).not.toThrow();
      ensureGH18Operations(db);
      db.exec("INSERT INTO memory_deny_session VALUES('thread','engine','protected',77)");
      expect(() => old.validateMemorySchema(db)).not.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM memory_deny_session').get()?.n).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='gh18_operations'").get()).toBeTruthy();
    } finally { db.close(); }
  } finally { removeTempDir(scratch); }
});
it('gh18_audit_objects_are_accepted_by_backup_inventory', () => {
  const objects = registeredSnapshotObjects();
  expect(objects.has('gh18_operations')).toBe(true);
  expect(objects.has('gh18_operations_pending')).toBe(true);
});
