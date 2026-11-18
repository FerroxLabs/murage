// Native Windows check of the channel receipt store's privacy barrier (fprod4 High D, W-WIN-ACL). Real icacls, real folders, the production
// check (windowsDirectoryInheritCheck) and the production store (LedgerStore). Skipped everywhere but Windows: no other platform has these ACLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUserSid, parseDacl, windowsAclRestrict, windowsDirectoryInheritCheck } from '../../server/sentinel/win-acl.ts';
import { LEDGER_DB, LedgerStore } from '../../server/channels/delivery-ledger-store.ts';

const native = process.platform === 'win32';
const skip = native ? false : `needs native Windows ACLs (icacls); this is ${process.platform}`;
const icacls = (...args) => execFileSync(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, { encoding: 'utf8', windowsHide: true });
const roots = [];
const folder = () => { const root = mkdtempSync(join(tmpdir(), 'ledger-acl-')); roots.push(root); const dir = join(root, 'channels'); mkdirSync(dir); return dir; };
const dacl = (path) => {
  const out = join(tmpdir(), `ledger-acl-${process.pid}-${Math.random().toString(16).slice(2)}.txt`);
  try { icacls(path, '/save', out, '/q'); return parseDacl(readFileSync(out).toString('utf16le').replace(/^\uFEFF/, '')); }
  finally { rmSync(out, { force: true }); }
};
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

test('an owner-only inheritable folder passes, and the store, -wal and -shm it makes are owner-only', { skip }, async () => {
  const dir = folder(), sid = currentUserSid();
  assert.ok(sid, 'whoami answered the current user SID');
  assert.equal(windowsAclRestrict(dir), true);
  assert.equal(windowsDirectoryInheritCheck(dir), 'owner-only');
  const store = new LedgerStore(join(dir, 'chat.json'));
  try {
    const db = join(dir, LEDGER_DB);
    for (const file of [db, `${db}-wal`, `${db}-shm`]) {
      assert.ok(existsSync(file), `${file} exists while the store is open`);
      const parsed = dacl(file);
      assert.ok(parsed, `${file} DACL is readable`);
      // As production reads it (win-acl.ts ownerOnlyVerdict): SDDL writes a RID-500 owner as "LA", and LA is root-like for anyone.
      const owner = (account) => account === sid || (/^S-1-5-21-\d+-\d+-\d+-500$/.test(sid) && account === 'LA');
      assert.ok(parsed.allow.some(owner), `${file} grants the owner`);
      for (const allowed of parsed.allow) assert.ok(owner(allowed) || allowed === 'S-1-5-18' || allowed === 'S-1-5-32-544' || allowed === 'LA', `${file} grants only the owner and root-like accounts, not ${allowed}`);
    }
  } finally { await store.release(); }
});

test('a folder that also grants the Users group is refused and nothing is created', { skip }, () => {
  const dir = folder();
  assert.equal(windowsAclRestrict(dir), true);
  icacls(dir, '/grant', '*S-1-5-32-545:(OI)(CI)R');
  assert.equal(windowsDirectoryInheritCheck(dir), 'broad');
  assert.throws(() => new LedgerStore(join(dir, 'chat.json')), /not private|invalid/i);
  assert.equal(existsSync(join(dir, LEDGER_DB)), false);
});

test('an owner-only folder whose entries do not inherit is refused: its -wal and -shm would not receive them', { skip }, () => {
  const dir = folder(), sid = currentUserSid();
  assert.ok(sid);
  icacls(dir, '/inheritance:r', '/grant:r', `*${sid}:F`, '/grant:r', '*S-1-5-18:F');
  assert.equal(windowsDirectoryInheritCheck(dir), 'broad');
  assert.throws(() => new LedgerStore(join(dir, 'chat.json')), /not private|invalid/i);
  assert.equal(existsSync(join(dir, LEDGER_DB)), false);
});
