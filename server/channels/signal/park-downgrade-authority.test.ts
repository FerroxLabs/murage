import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { readRoutineRuns } from '../../routine-runs-journal.ts';
import { pathsFor } from './park-control.ts';
import { ParkFs } from './park-fs.ts';
import { preserveSignalForDowngrade, SignalDowngradeError } from './park-downgrade.ts';

const readFault = vi.hoisted(() => ({ file: '', secondReads: 0 }));
vi.mock('node:fs', async importOriginal => {
 const real = await importOriginal<typeof import('node:fs')>();
 return { ...real, readFileSync: ((...args: Parameters<typeof real.readFileSync>) => {
  if (args[0] === readFault.file) { readFault.secondReads++; throw new Error('second journal read failed'); }
  return Reflect.apply(real.readFileSync, real, args);
 }) as typeof real.readFileSync };
});

const roots: string[] = [];
const fence = { lease: () => 'fixture-lease', discover: () => true, host: () => 'fixture', boot: () => 'boot', uptime: () => 1 };
afterEach(() => { readFault.file = ''; readFault.secondReads = 0; vi.restoreAllMocks(); roots.splice(0).forEach(root => removeTempDirSync(root)); });
function put(file: string, value: unknown) {
 fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function fixture(journal: string) {
 const root = fs.mkdtempSync(join(tmpdir(), 'park-strict-journal-')); roots.push(root);
 const p = pathsFor(root), freshId = randomUUID();
 put(join(root, 'install-id.json'), { installId: randomUUID() });
 put(join(p.signal, 'auth/key'), 'FAKE-LIVE-CREDENTIAL');
 put(join(p.channel, 'connection.json'), { version: 1, connectionId: freshId, generation: 1, enabled: false, paused: false, revoking: false, binding: null, account: null });
 put(p.control, { version: 1, seq: 1, decisions: {}, child: null, replacements: [{ id: randomUUID(), phase: 'ready', oldBundles: [], connectionIds: ['old'], runIds: ['old-run'], freshId, live: null }] });
 const db = new DatabaseSync(join(root, 'messages.db'));
 try { db.exec('CREATE TABLE memory_scope_bindings (subject_type TEXT, intent TEXT)'); } finally { db.close(); }
 fs.chmodSync(join(root, 'messages.db'), 0o600);
 const file = join(root, 'events/routine-runs/old.jsonl'); put(file, journal);
 return { root, p, file, freshId };
}
const run = (status = 'cancelled', id = 'old-run') => ({ id, routineId: 'old', status, channelOrigin: { platform: 'signal', connectionId: 'old' }, eventBudget: { closed: status === 'cancelled' } });
function refused(f: ReturnType<typeof fixture>, reason: string) {
 const auth = join(f.p.signal, 'auth/key'), connection = join(f.p.channel, 'connection.json');
 const before = [auth, connection].map(file => ({ bytes: fs.readFileSync(file), ino: fs.statSync(file).ino }));
 const mutations: string[] = []; let caught: unknown;
 try { preserveSignalForDowngrade(f.root, { fence, after: op => { if (['rename', 'write', 'mkdir', 'temp', 'metadata-rename'].includes(op)) mutations.push(op); } }); } catch (error) { caught = error; }
 expect(caught, 'must refuse before credential movement').toBeInstanceOf(SignalDowngradeError);
 expect(caught).toMatchObject({ code: 'SIGNAL_PRESERVATION_REQUIRED', stage: 'read-only', reason });
 expect(mutations).toEqual([]);
 for (const [i, file] of [auth, connection].entries()) { expect(fs.readFileSync(file)).toEqual(before[i]!.bytes); expect(fs.statSync(file).ino).toBe(before[i]!.ino); }
}

test('R3 RED second read fails after successful checked read: queued work still refuses', () => {
 const f = fixture(JSON.stringify(run('queued')) + '\n');
 const read = ParkFs.prototype.read; let checkedReads = 0;
 vi.spyOn(ParkFs.prototype, 'read').mockImplementation(function(this: ParkFs, file, ...args) {
  if (file === f.file && ++checkedReads > 1) throw new Error('second checked journal read failed');
  return read.call(this, file, ...args);
 });
 readFault.file = f.file;
 refused(f, 'conflict');
 expect(checkedReads).toBe(1); expect(readFault.secondReads, 'only the checked bytes may be consumed').toBe(0);
});
test('R3 RED journal beyond spread and run-count limits refuses instead of silently skipping', () => {
 const lines: string[] = [];
 for (let i = 0; i < 200_001; i++) lines.push(JSON.stringify(run('cancelled', `run-${i}`)));
 refused(fixture(lines.join('\n') + '\n'), 'bound');
}, 30_000);
test('R3 RED corrupt journal line refuses and preserves credentials', () => {
 refused(fixture(JSON.stringify(run()) + '\n{torn\n'), 'unsafe');
});
for (const operation of ['read', 'list'] as const) test(`R3 journal ${operation} failure refuses without credential movement`, () => {
 const f = fixture(JSON.stringify(run()) + '\n'), original = ParkFs.prototype[operation];
 vi.spyOn(ParkFs.prototype, operation).mockImplementation(function(this: ParkFs, path: string, cap?: number) {
  if (path === (operation === 'read' ? f.file : dirname(f.file))) throw new Error('journal IO failed');
  return Reflect.apply(original, this, [path, cap]);
 } as typeof original);
 refused(f, 'unsafe');
});
test('R3 RUN normal committed journal parks; tombstones, state runs and legacy overlay retain their meaning', () => {
 const f = fixture([
  JSON.stringify(run('queued', 'deleted')), JSON.stringify({ $del: 'deleted' }),
  JSON.stringify({ ...run('queued', 'uncommitted'), $c: 2 }),
  JSON.stringify({ $routine: { id: 'old' }, $gen: 'fixture', $runs: [run()] }),
 ].join('\n') + '\n');
 put(join(f.root, 'routines.json'), { runsCommit: 1, runs: [run()] });
 expect(preserveSignalForDowngrade(f.root, { fence })).toHaveProperty('signalKept');
 expect(fs.existsSync(f.p.signal)).toBe(false); expect(fs.existsSync(f.p.channel)).toBe(false);
 expect(fs.readFileSync(join(f.p.bundles, `${f.freshId}.g1/signal/auth/key`), 'utf8')).toBe('FAKE-LIVE-CREDENTIAL');
});
test('R3 RUN journal above call-stack spread limit but within count limit parks correctly', () => {
 const lines: string[] = [];
 for (let i = 0; i < 150_000; i++) lines.push(JSON.stringify(run('cancelled', `run-${i}`)));
 const f = fixture(lines.join('\n') + '\n');
 expect(preserveSignalForDowngrade(f.root, { fence })).toHaveProperty('signalKept');
 expect(fs.existsSync(f.p.signal)).toBe(false); expect(fs.existsSync(f.p.channel)).toBe(false);
}, 30_000);
test('R3 existing lenient reader continues to skip corrupt lines for other callers', () => {
 const f = fixture(JSON.stringify(run()) + '\n{torn\n');
 expect(readRoutineRuns(f.root)).toEqual([run()]);
});
