import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { privateParkTemp, parkProtocolOptions, parkFixtureWrite } from '../../testing/signal-park-fixture.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { identityStat, lstatIdentity, fstatIdentity } from './file-identity.ts';
import { ParkFs, emptyManifest } from './park-fs.ts';
import { installationBinding, parkSchema, sameRoot } from './park-control.ts';
import { journalPath, saveJournal } from './park.ts';
import { setAsideConnectors } from '../../connector-set-aside.ts';

const fake = vi.hoisted(() => ({ nativeIno: '', ino: 0n, dev: 0n, ignoreBigint:false }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const project = (stat: fs.Stats | fs.BigIntStats) => {
    if (fake.nativeIno) Object.assign(stat, { dev: typeof stat.dev === 'bigint' ? fake.dev : Number(fake.dev) });
    if (String(stat.ino) === fake.nativeIno) {
      Object.assign(stat, typeof stat.ino === 'bigint'
        ? { dev: fake.dev, ino: fake.ino }
        : { dev: Number(fake.dev), ino: Number(fake.ino) });
    }
    return stat;
  };
  return { ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => project(fake.ignoreBigint?actual.lstatSync(args[0]):actual.lstatSync(...args)!),
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => project(fake.ignoreBigint?actual.fstatSync(args[0]):actual.fstatSync(...args)),
  };
});

const roots: string[] = [];
afterEach(() => { fake.ignoreBigint=false;fake.nativeIno = ''; for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture(ino = 2n ** 60n + 1n, dev?: bigint) {
  const root = privateParkTemp(join(tmpdir(), 'park-identity-')); roots.push(root);
  parkFixtureWrite(join(root, 'install-id.json'), JSON.stringify({ installId: randomUUID() }), { mode: 0o600 });
  const native = fs.lstatSync(root, { bigint: true });
  Object.assign(fake, { nativeIno: String(native.ino), ino, dev: dev ?? native.dev });
  const io = new ParkFs(root, parkProtocolOptions);
  const journal = {
    version: 3 as const, runId: randomUUID(), bundleName: 'one.g1', seq: 0,
    state: 'parking' as const, next: null, ...installationBinding(io),
    connection: { connectionId: 'one', generation: 1, bindingDigest: null, revoking: false, restoring: false, problem: null },
    components: { auth: emptyManifest(), channel: emptyManifest() }, parkedBy: 'fixture', parkedAt: 1,
  };
  return { root, io, journal };
}

test('64-bit root inode saves, reloads, and compares without rounding', () => {
  const { root, io, journal } = fixture();
  saveJournal(io, journal);
  const raw = JSON.parse(fs.readFileSync(journalPath(io, journal.bundleName), 'utf8'));
  expect(raw.root.ino).toBe('1152921504606846977');
  expect(typeof raw.root.dev).toBe('string');
  const loaded = parkSchema.parse(raw);
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(true);
  fake.ino = 2n ** 60n + 2n;
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(false);
  expect(() => io.checked(root)).toThrow('changed');
});

test('64-bit device identity remains distinct above the safe number limit', () => {
  const { root, journal } = fixture(2n ** 60n + 1n, 2n ** 60n + 1n);
  expect(journal.root.dev).toBe('1152921504606846977');
  fake.dev = 2n ** 60n + 2n;
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), journal)).toBe(false);
});

for (const field of ['ino', 'dev'] as const) test(`signed Windows bigint ${field} normalizes on path and descriptor reads`, () => {
  const { root } = fixture();
  fake.nativeIno = '';
  const file = join(root, 'key');
  parkFixtureWrite(file, 'SYNTHETIC-KEY', { mode: 0o600 });
  const read = (path: string, options: { bigint: true }) => Object.assign(fs.lstatSync(path, options), { [field]: -1161084278931400327n });
  const first = lstatIdentity(file, read);
  expect(first[field]).toBe('17285659794778151289');
  expect(lstatIdentity(file, read)[field]).toBe(first[field]);
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    expect(fstatIdentity(fd, (fd, options) => Object.assign(fs.fstatSync(fd, options), { [field]: -1161084278931400327n }))[field]).toBe(first[field]);
  } finally { fs.closeSync(fd); }
  const neighbour = lstatIdentity(file, (path, options) => Object.assign(fs.lstatSync(path, options), { [field]: -1161365753908110983n }));
  expect(neighbour[field]).toBe('17285378319801440633');
  expect(neighbour[field]).not.toBe(first[field]);
});

for (const field of ['ino', 'dev'] as const) test(`positive-form journal matches signed Windows bigint ${field}`, () => {
  const { root, io, journal } = fixture(-1161084278931400327n, -1161084278931400327n);
  expect(journal.root).toMatchObject({ dev: '17285659794778151289', ino: '17285659794778151289' });
  saveJournal(io, journal);
  const raw = JSON.parse(fs.readFileSync(journalPath(io, journal.bundleName), 'utf8'));
  const loaded = parkSchema.parse(raw);
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(true);
  // A pre-existing journal written with the unsigned representation stays valid
  // whether the current reader returns signed or unsigned BigIntStats.
  fake.dev = 17285659794778151289n;
  fake.ino = 17285659794778151289n;
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(true);
  expect(() => io.checked(root)).not.toThrow();
  fake[field] = -1161365753908110983n;
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(false);
  expect(() => io.checked(root)).toThrow();
});

for (const field of ['ino', 'dev'] as const) test.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '1e3', '-1', ''])('stat rejects ambiguous ' + field + ' %s', value => {
  const { root } = fixture();
  expect(() => identityStat({ ...fs.lstatSync(root), [field]: value })).toThrow('unsafe file identity');
});

test('old journals with safe numeric dev and ino load as decimal strings', () => {
  const { root, io, journal } = fixture(123n);
  const raw = { ...journal, root: { ...journal.root, dev: Number(fake.dev), ino: 123 } };
  io.write(journalPath(io, journal.bundleName), raw);
  const loaded = parkSchema.parse(JSON.parse(fs.readFileSync(journalPath(io, journal.bundleName), 'utf8')));
  expect(loaded.root).toEqual({ ...journal.root, dev: String(fake.dev), ino: '123' });
  expect(sameRoot(new ParkFs(root, parkProtocolOptions), loaded)).toBe(true);
  saveJournal(io, loaded);
  expect(JSON.parse(fs.readFileSync(journalPath(io, journal.bundleName), 'utf8')).root).toEqual(loaded.root);
});

test('path and descriptor checks distinguish adjacent 64-bit file IDs', () => {
  const { root } = fixture();
  fake.nativeIno = '';
  const file = join(root, 'key');
  parkFixtureWrite(file, 'SYNTHETIC-KEY', { mode: 0o600 });
  Object.assign(fake, { nativeIno: String(fs.lstatSync(file, { bigint: true }).ino), ino: 2n ** 60n + 1n });
  const io = new ParkFs(root, parkProtocolOptions);
  expect(io.fingerprint(file).present).toBe(true);
  io.options.stat = (path, options) => {
    const stat = fs.lstatSync(path, options);
    if (path === file) stat.ino = 2n ** 60n + 2n;
    return stat;
  };
  expect(() => io.flushFile(file)).toThrow('changed');
  expect(() => io.fingerprint(file)).toThrow('changed');
});

test('connector journals save exact file IDs and resume safe numeric legacy IDs', () => {
  const { root } = fixture(123n);
  fake.nativeIno = '';
  const source = join(root, 'connector-health.json');
  parkFixtureWrite(source, 'SYNTHETIC-HEALTH', { mode: 0o600 });
  Object.assign(fake, { nativeIno: String(fs.lstatSync(source, { bigint: true }).ino), ino: 2n ** 60n + 1n });
  setAsideConnectors(root, parkProtocolOptions);
  const namespace = join(root, 'recovery-quarantine/connector-set-aside');
  const file = join(namespace, fs.readdirSync(namespace)[0]!, 'set-aside.json');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(journal.sources[0].ino).toBe('1152921504606846977');
  expect(() => setAsideConnectors(root, parkProtocolOptions)).not.toThrow();
  fake.ino = 123n;
  journal.sources[0].ino = 123;
  journal.sources[0].dev = Number(fake.dev);
  parkFixtureWrite(file, JSON.stringify(journal), { mode: 0o600 });
  expect(() => setAsideConnectors(root, parkProtocolOptions)).not.toThrow();
  fake.ino = 124n;
  expect(() => setAsideConnectors(root, parkProtocolOptions)).toThrow('changed');
});

test.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '1e3', '-1', ''])('journal rejects ambiguous identity %s', value => {
  const { journal } = fixture();
  expect(parkSchema.safeParse({ ...journal, root: { ...journal.root, ino: value } }).success).toBe(false);
});

// Exercise the merged native-security cache and parent filter with IDs that
// would alias if either path rounded through Number.
for (const id of [2n ** 60n + 1n, -1161084278931400327n]) for (const field of ['ino', 'dev'] as const) test(`Windows dirty-parent cache pins exact 64-bit ${field} ${id}`, () => {
  const { root } = fixture(id, id);
  const normalized = String(BigInt.asUintN(64, id));
  const sid = 'S-1-5-21-1-2-3-1001';
  const io = new ParkFs(root, {
    platform: 'win32', windowsSid: () => sid, sync: () => 'synced',
    windowsRun: (_exe, _args, options) => {
      const paths = JSON.parse(options.env.MURAGE_SIGNAL_ROOTS!) as string[];
      return paths.map(path => JSON.stringify({ path, attributes: fs.lstatSync(path).isDirectory() ? 16 : 0,
        sddl: `O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)` })).join('\n');
    },
  });
  expect(io.rootStat[field]).toBe(normalized);
  const cached = io['security'].get(io['pathKey'](root))!;
  expect(cached.stat[field]).toBe(normalized);
  expect(cached.key).toContain(`${normalized}:${normalized}`);
  io['dirtyParent'](root);
  const before = io.debug.childProcesses;
  io.barrier(root);
  expect(io.debug.childProcesses).toBe(before);
  expect(io.debug.publishParentReads).toBe(0);
  io['dirtyParent'](root);
  fake[field] += 1n;
  expect(() => io.barrier(root)).toThrow('changed');
  expect(io.debug.childProcesses).toBe(before);
});

for (const ino of [123n, 2n ** 60n + 1n]) test(`injected identity readers must honour bigint even for inode ${ino}`, () => {
  const { root } = fixture(ino);
  expect(() => lstatIdentity(root, path => fs.lstatSync(path))).toThrow('identity reader must honour bigint');
  expect(lstatIdentity(root, (path, options) => fs.lstatSync(path, options)).ino).toBe(String(ino));
  const fd = fs.openSync(root, fs.constants.O_RDONLY);
  try {
    expect(() => fstatIdentity(fd, fd => fs.fstatSync(fd))).toThrow('identity reader must honour bigint');
    expect(fstatIdentity(fd, (fd, options) => fs.fstatSync(fd, options)).ino).toBe(String(ino));
  } finally { fs.closeSync(fd); }
});

test('default readers recover exact native identities if an adapter drops bigint',()=>{
 const root=privateParkTemp(join(tmpdir(),'park-default-reader-'));roots.push(root);
 const native=fs.lstatSync(root,{bigint:true});fake.ignoreBigint=true;
 expect(lstatIdentity(root).ino).toBe(String(BigInt.asUintN(64,native.ino)));
 const fd=fs.openSync(root,fs.constants.O_RDONLY);
 try{expect(fstatIdentity(fd).ino).toBe(String(BigInt.asUintN(64,native.ino)));}finally{fs.closeSync(fd);}
});
