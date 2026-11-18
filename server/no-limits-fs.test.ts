// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionsForResolution, effectiveCwd, inspectNativeEffects, noLimitsDisk, protectedIdentityRegistry, resolveNoLimitsPath, type NativeEffect, type NoLimitsDisk } from './no-limits-fs.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'nl-fs-'));
  roots.push(cwd);
  const home = join(cwd, 'home'); mkdirSync(home);
  return { cwd, home };
}
const write = (path: string, op: NativeEffect['op'] = 'write'): NativeEffect => ({ operandId: 'selected-write', path, op, followFinal: !['delete', 'create-name', 'rename'].includes(op) });

describe('C2 owner disk resolution S08 and H12', () => {
  it('resolves components before .. and retains protected dangling targets', () => {
    const ctx = fixture();
    mkdirSync(join(ctx.cwd, 'data')); mkdirSync(join(ctx.cwd, 'data', 'sub'));
    symlinkSync('./data/sub', join(ctx.cwd, 'e'));
    expect(resolveNoLimitsPath('e/../new', ctx)).toMatchObject({ kind: 'known', physical: `${ctx.cwd}/data/new`, exists: false });
    symlinkSync('/etc/nl-never-created', join(ctx.cwd, 'h'));
    const result = inspectNativeEffects([write('h')], ctx);
    expect(result.verdict).toBe('hold');
    expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'direct-path', physical: '/etc/nl-never-created', resolution: expect.objectContaining({ exists: false }) }));
    expect(resolveNoLimitsPath('absent', ctx)).toMatchObject({ kind: 'known', exists: false, physical: `${ctx.cwd}/absent` });
  });
  it('keeps final entry semantics for unlink/replacement; parents still resolve', () => {
    const ctx = fixture(); symlinkSync('/etc/hosts', join(ctx.cwd, 'h')); symlinkSync('/etc', join(ctx.cwd, 'd'));
    for (const op of ['delete', 'create-name', 'rename'] as const) expect(inspectNativeEffects([write('h', op)], ctx).verdict).toBe('run');
    expect(inspectNativeEffects([write('d/new', 'delete')], ctx).verdict).toBe('hold');
    expect(resolveNoLimitsPath('h/', { ...ctx, followFinal: false })).toMatchObject({ kind: 'known', physical: '/etc/hosts' });
  });
  it('40 hops exhaust structurally with no invented physical path; ordinary twin runs', () => {
    const ctx = fixture();
    for (let i = 0; i < 41; i++) symlinkSync(`h${i + 1}`, join(ctx.cwd, `h${i}`));
    const result = inspectNativeEffects([write('h0')], ctx);
    expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'resolution-exhausted', protectedClass: 'resolution-exhausted', resolution: expect.objectContaining({ kind: 'exhausted', hops: 40 }) }));
    expect(result.decisions.every(decision => decision.physical === undefined)).toBe(true);
    expect(inspectNativeEffects([write('plain')], ctx).verdict).toBe('run');
    unlinkSync(join(ctx.cwd, 'h1')); symlinkSync('h0', join(ctx.cwd, 'h1'));
    expect(resolveNoLimitsPath('h0', ctx).kind).toBe('exhausted');
  });
  it('ordinary stream names bypass disk probes exactly, while other /dev paths hold', () => {
    const fail = () => { throw new Error('stream probe'); };
    const disk: NoLimitsDisk = { lstat: fail, stat: fail, readlink: fail, readdir: fail };
    for (const path of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/fd/1']) {
      const resolution = resolveNoLimitsPath(path, { disk });
      expect(resolution).toMatchObject({ kind: 'known', physical: path });
      expect(decisionsForResolution(write(path), resolution, {}, [])).toEqual([]);
    }
    expect(inspectNativeEffects([write('/dev/mem')], { disk }).verdict).toBe('hold');
    expect(inspectNativeEffects([write('/dev/stdout-extra')], { disk }).verdict).toBe('hold');
  });
  it('stream aliases stay exact after ordered link resolution, never before it', () => {
    const ctx = fixture();
    symlinkSync('/dev/stdout', join(ctx.cwd, 'stream')); symlinkSync('/dev/fd/1', join(ctx.cwd, 'fdstream'));
    symlinkSync('/dev/fd', join(ctx.cwd, 'fdparent'));
    const probes: string[] = [];
    const disk: NoLimitsDisk = { ...noLimitsDisk, lstat: path => { probes.push(path); return noLimitsDisk.lstat(path); } };
    for (const path of ['stream', 'fdstream', 'fdparent/1']) expect(inspectNativeEffects([write(path)], { ...ctx, disk }).verdict).toBe('run');
    expect(probes.some(path => path.startsWith('/proc'))).toBe(false);
    symlinkSync('/etc/a/b/c/d', join(ctx.cwd, 'e'));
    const fake = (path: string) => ({ dev: 1n, ino: 2n, nlink: 1n, isDirectory: () => path !== '/etc/a/dev/stdout', isFile: () => path === '/etc/a/dev/stdout', isSymbolicLink: () => false });
    const aliasDisk: NoLimitsDisk = { ...noLimitsDisk, lstat: path => path.startsWith('/etc/a') ? fake(path) : noLimitsDisk.lstat(path) };
    const raw = `${ctx.cwd}/e/../../../dev/stdout`;
    const result = inspectNativeEffects([write(raw)], { ...ctx, disk: aliasDisk });
    expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'direct-path', physical: '/etc/a/dev/stdout' }));
  });
  it('protected hard-link source is retained even when the destination is ordinary', () => {
    const ctx = fixture(); writeFileSync(join(ctx.home, '.zshrc'), 'fixture');
    const effect: NativeEffect = { operandId: 'link', op: 'link', path: './plain', source: `${ctx.home}/.zshrc`, linkKind: 'hard', followFinal: false };
    const result = inspectNativeEffects([effect], ctx);
    expect(result.verdict).toBe('hold');
    expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'hard-link-source', lexical: `${ctx.cwd}/plain`, sourcePhysical: `${ctx.home}/.zshrc` }));
    writeFileSync(join(ctx.cwd, 'source'), 'ordinary');
    expect(inspectNativeEffects([{ ...effect, source: './source' }], ctx).verdict).toBe('run');
  });
  it('mandatory named-file inode match holds write/edit; unlink and ordinary pairs run', () => {
    const ctx = fixture();
    writeFileSync(join(ctx.home, '.zshrc'), 'fixture'); linkSync(join(ctx.home, '.zshrc'), join(ctx.cwd, 'alias'));
    writeFileSync(join(ctx.cwd, 'ordinary'), 'ordinary'); linkSync(join(ctx.cwd, 'ordinary'), join(ctx.cwd, 'pair'));
    for (const op of ['write', 'edit'] as const) {
      const result = inspectNativeEffects([write('alias', op)], ctx);
      expect(result.decisions).toContainEqual(expect.objectContaining({ reason: 'protected-inode', namedProtectedPath: `${ctx.home}/.zshrc`, identity: expect.objectContaining({ nlink: 2 }) }));
      expect(inspectNativeEffects([write('pair', op)], ctx).verdict).toBe('run');
    }
    expect(inspectNativeEffects([write('alias', 'delete')], ctx).verdict).toBe('run');
  });
  it('refreshes registry on every inspection, including release after a new protected name', () => {
    const ctx = fixture(); writeFileSync(join(ctx.cwd, 'ordinary'), 'ordinary'); linkSync(join(ctx.cwd, 'ordinary'), join(ctx.cwd, 'pair'));
    expect(inspectNativeEffects([write('pair')], ctx).verdict).toBe('run');
    linkSync(join(ctx.cwd, 'ordinary'), join(ctx.home, '.zshrc'));
    expect(inspectNativeEffects([write('pair')], ctx).decisions.some(decision => decision.reason === 'protected-inode')).toBe(true);
  });
  it('includes exact protected runtime names without protecting ordinary runtime values', () => {
    const ctx = fixture(); writeFileSync(join(ctx.cwd, 'plain'), 'fixture'); linkSync(join(ctx.cwd, 'plain'), join(ctx.cwd, 'pair'));
    const disk: NoLimitsDisk = { ...noLimitsDisk, stat: path => {
      if (path === '/etc/runtime-known') return noLimitsDisk.stat(join(ctx.cwd, 'plain'));
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } };
    expect(inspectNativeEffects([write('pair')], { ...ctx, disk, runtimePaths: { OUT: '/etc/runtime-known' } }).decisions).toContainEqual(expect.objectContaining({ reason: 'protected-inode', namedProtectedPath: '/etc/runtime-known' }));
    expect(inspectNativeEffects([write('pair')], { ...ctx, disk, runtimePaths: { OUT: join(ctx.cwd, 'plain') } }).verdict).toBe('run');
  });
  it('uses lossless dev AND ino and no arbitrary registry cutoff', () => {
    const calls: string[] = [];
    let dev = '9007199254740995';
    const stat = () => ({ dev, ino: '9007199254740999', nlink: 2, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
    const disk: NoLimitsDisk = { lstat: path => path === '/tmp' ? { ...stat(), isDirectory: () => true, isFile: () => false } : stat(), stat: path => { calls.push(path); return stat(); }, readlink: () => '', readdir: () => [] };
    const runtimePaths = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`gate${i}`, `/tmp/registry/${i}`]));
    const ctx = { cwd: '/tmp', home: '/tmp/home', disk, namedProtectedPaths: Object.values(runtimePaths) };
    const registry = protectedIdentityRegistry(ctx);
    expect(calls).toContain('/tmp/registry/129');
    const resolution = resolveNoLimitsPath('/tmp/plain', ctx);
    expect(resolution).toMatchObject({ identity: { dev, ino: '9007199254740999', nlink: 2 } });
    expect(decisionsForResolution(write('/tmp/plain'), resolution, ctx, registry).some(decision => decision.reason === 'protected-inode')).toBe(true);
    dev = '9007199254740997';
    const differentDevice = resolveNoLimitsPath('/tmp/plain', ctx);
    expect(decisionsForResolution(write('/tmp/plain'), differentDevice, ctx, registry)).toEqual([]);
  });
  it('retains strict owner classes and freezes structured evidence', () => {
    const result = inspectNativeEffects([write('/libexec')], { remote: true });
    expect(result.decisions[0]).toMatchObject({ reason: 'direct-path', protectedClass: 'system' });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.decisions[0])).toBe(true); expect(Object.isFrozen(result.effects[0]!.resolution)).toBe(true);
  });
  it('remote payloads perform no local filesystem probes', () => {
    let probes = 0;
    const fail = () => { probes++; throw new Error('host disk'); };
    const disk: NoLimitsDisk = { lstat: fail, stat: fail, readlink: fail, readdir: fail };
    expect(inspectNativeEffects([write('/tmp/plain')], { disk, remote: true }).verdict).toBe('run');
    expect(inspectNativeEffects([write('/etc/hosts')], { disk, remote: true }).verdict).toBe('hold');
    expect(probes).toBe(0);
  });
  it('uses shared effective cwd including explicitly invalid and empty cwd fallback', () => {
    expect(effectiveCwd({ commandCwdInvalid: true, commandCwd: '/etc', workFolder: '/tmp/work' })).toBe('');
    expect(effectiveCwd({ commandCwd: '', exactCommand: { cwd: '/tmp/exact' }, workFolder: '/tmp/work' })).toBe('/tmp/exact');
    expect(effectiveCwd({ workFolder: '/tmp/work' })).toBe('/tmp/work');
    expect(inspectNativeEffects([write('/tmp/out')], { remote: true, runtimePaths: { OUT: '/tmp/out' } }).verdict).toBe('run');
    expect(inspectNativeEffects([write('notes')], { cwdInvalid: true }).verdict).toBe('run');
    expect(resolveNoLimitsPath('notes', { cwdInvalid: true })).toMatchObject({ kind: 'unknown', cause: 'invalid-cwd' });
  });
  it('supports injected Windows drive and UNC disk paths without a platform hold', () => {
    const nodes = new Map([
      ['c:/work', 'dir'], ['c:/windows', 'dir'], ['c:/windows/system32', 'dir'],
      ['c:/work/e', 'link'], ['//server/share/dir', 'dir'],
    ]);
    const stat = (path: string) => {
      const kind = nodes.get(path.toLowerCase());
      if (!kind) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { dev: 1n, ino: 2n, nlink: 1n, isDirectory: () => kind === 'dir', isFile: () => false, isSymbolicLink: () => kind === 'link' };
    };
    const disk: NoLimitsDisk = { stat, lstat: stat, readlink: () => 'C:\\Windows\\System32', readdir: () => [] };
    const ctx = { cwd: 'C:\\work', disk, windows: true };
    expect(resolveNoLimitsPath('e\\..\\new', ctx)).toMatchObject({ kind: 'known', physical: 'C:/Windows/new' });
    expect(inspectNativeEffects([write('e\\..\\new')], ctx).verdict).toBe('hold');
    expect(inspectNativeEffects([write('plain')], ctx).verdict).toBe('run');
    expect(resolveNoLimitsPath('\\\\server\\share\\dir\\new', { disk, windows: true })).toMatchObject({ kind: 'known', physical: '//server/share/dir/new' });
  });
  it('unavailable inode data never invents a match; missing-before-parent is unknown', () => {
    const ctx = fixture();
    expect(resolveNoLimitsPath('missing/../notes', ctx)).toMatchObject({ kind: 'unknown', cause: 'missing-before-parent' });
    const disk = { ...noLimitsDisk, stat: () => { throw new Error('unavailable'); } };
    expect(inspectNativeEffects([write('ordinary')], { ...ctx, disk }).verdict).toBe('run');
  });
});
