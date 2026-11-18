// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { commandRoles, writeSlots } from './roles.ts';
const write = (words: Array<string | undefined>, dialect?: 'pwsh') => writeSlots(commandRoles(words, dialect)).map(s => s.value);
describe('shared operand roles', () => {
  it.each(['--expression=x', '--expr=x', '--file=./s', '-ex'])('sed script supplied by %s', option => {
    expect(write(['sed', '-i', option, '/etc/x'])).toEqual(['/etc/x']);
  });
  it('sed script, read file source, no in-place, BSD union and perl clusters', () => {
    expect(commandRoles(['sed', '-i', 's/x/y/', './n']).slots.find(s => s.value === 's/x/y/')?.role).toBe('script');
    expect(write(['sed', '-n', '--expression=p', '/etc/x'])).toEqual([]);
    expect(write(['sed', '-i', '', 's/x/y/', '/etc/x'])).toContain('/etc/x');
    expect(write(['perl', '-pi', '-e', 's/x/y/', '/etc/x'])).toEqual(['/etc/x']);
    expect(write(['perl', '-i.bak', '-pe', 's/x/y/', '/etc/x'])).toEqual(['/etc/x']);
    expect(write(['perl', '-i', './script', './n'])).toEqual(['./n']);
  });
  it('explicit cp destination leaves all sources read; mv and hard links write sources', () => {
    expect(write(['cp', '-t', './out', '/etc/hosts'])).toEqual(['./out']);
    expect(write(['cp', '--target-directory=/etc', './x'])).toEqual(['/etc']);
    expect(write(['install', '-m', '600', '/etc/x', './n'])).toEqual(['./n']);
    expect(write(['mv', '/etc/x', './n'])).toContain('/etc/x');
    expect(write(['ln', '/etc/x', './n'])).toContain('/etc/x');
    expect(write(['ln', '-s', '/etc/x', './n'])).toEqual(['./n']);
  });
  it('wrappers keep real valued-option and command locations', () => {
    const r = commandRoles(['sudo', '-u', 'root', 'env', '-C', '/etc', 'tee', 'config']);
    expect(r.program).toBe('tee'); expect(r.wrappers).toEqual(['sudo', 'env']);
    expect(r.cwd).toEqual({ value: '/etc' });
    expect(writeSlots(r)).toEqual([{ arg: 7, offset: 0, value: 'config', role: 'write' }]);
    expect(write(['time', '-o', '/etc/log', 'timeout', '-s', 'TERM', '10', 'touch', './x'])).toEqual(['/etc/log', './x']);
    expect(write(['flock', '/etc/lock', 'tee', './n'])).toEqual(['/etc/lock', './n']);
    expect(write(['xargs', '-a', '/etc/input', '-I', '{}', 'touch', './n'])).toEqual(['./n']);
  });
  it('shell payloads, eval and env split-string are nested code, never path slots', () => {
    for (const words of [['bash', '-lc', 'touch /etc/x'], ['eval', 'touch', '/etc/x'], ['env', '-S', 'touch /etc/x']]) {
      const r = commandRoles(words); expect(r.nested?.[0]?.text).toBe('touch /etc/x'); expect(writeSlots(r)).toEqual([]);
    }
  });
  it('unknown words and unknown options union possible destinations', () => {
    expect(write(['cp', '/etc/x', undefined])).toContain('/etc/x');
    expect(write(['touch', '--opaque', '/etc/x'])).toContain('/etc/x');
    expect(write(['unknown', '/etc/x'])).toEqual([]);
  });
  it.each(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'touch', 'mkdir', 'truncate', 'tee'])('%s writes all operands', name => {
    expect(write([name, './x', '/etc/y'])).toEqual(['./x', '/etc/y']);
  });
  it('reference, modes, content, code and read options are not write operands', () => {
    expect(write(['touch', '-r', '/etc/ref', './x'])).toEqual(['./x']);
    expect(write(['chmod', '600', './x'])).toEqual(['./x']);
    expect(write(['chown', '--reference=/etc/x', './n'])).toEqual(['./n']);
    expect(write(['dd', 'if=/etc/in', 'of=./out'])).toEqual(['./out']);
    expect(write(['rsync', '-e', 'ssh', '/etc/src', './out'])).toEqual(['./out']);
    expect(write(['rsync', '--remove-source-files', '/etc/src', './out'])).toContain('/etc/src');
  });
  it('generic outputs, find, sort, make, compressors and ditto', () => {
    expect(write(['mystery', '-o/etc/x'])).toEqual(['/etc/x']);
    expect(write(['find', '.', '-fprint', '/etc/x'])).toEqual(['/etc/x']);
    expect(write(['sort', '-T/etc/tmp', './in'])).toContain('/etc/tmp');
    expect(write(['make', '-C/etc', 'install'])).toContain('/etc');
    expect(write(['gunzip', '/etc/x.gz'])).toEqual(['/etc/x.gz']);
    expect(write(['gzip', '-c', '/etc/x'])).toEqual([]);
    expect(write(['ditto', '/etc/src', './out'])).toEqual(['./out']);
  });
  it('PowerShell aliases, content values, copy sources and joined New-Item name', () => {
    expect(write(['Set-Content', '-LiteralP:/etc/x', '-Value', '/etc/data'], 'pwsh')).toEqual(['/etc/x']);
    expect(write(['sc', './n', '/etc/data'])).toEqual(['./n']);
    expect(write(['Copy-Item', '/etc/src', './out'])).toEqual(['./out']);
    expect(write(['Copy-Item', '-Path', '/etc/src', '-Destination', './out'])).toEqual(['./out']);
    expect(write(['New-Item', '-Path', '/etc', '-Name', 'x'])).toEqual(['/etc/x']);
  });
  it('Ruby require/encoding options and AWK include values are not input files', () => {
    expect(write(['ruby', '-i', '-r', '/etc/library', '-e', 'puts 1', './n'])).toEqual(['./n']);
    expect(write(['gawk', '-i', 'inplace', '{print}', '/etc/x'])).toEqual(['/etc/x']);
    expect(write(['gawk', '-i', 'extension', '1', '/etc/cron.d/pwn'])).toEqual([]);
    expect(write(['gawk', '--include=inplace', '--source={print}', '/etc/x'])).toEqual(['/etc/x']);
  });
  it('sed extended-regex flags do not supply a script', () => {
    expect(commandRoles(['sed', '-i', '-E', 's/x/y/', './n']).slots.find(s => s.value === 's/x/y/')?.role).toBe('script');
    expect(write(['sed', '-i', '-E', 's/x/y/', './n'])).toEqual(['./n']);
  });
  it('reference and rsync file-list options keep their read role', () => {
    for (const words of [['touch', '-r', '/etc/ref', './n'], ['chmod', '--reference=/etc/ref', './n'], ['rsync', '--files-from=/etc/ref', './src', './out']]) {
      expect(commandRoles(words).slots.find(s => s.value === '/etc/ref')?.role).toBe('read');
    }
  });
  it('archive table is projected with original word indices and modes', () => {
    const r = commandRoles(['sudo', '-u', 'root', 'tar', '-xf./a', '-C/etc']);
    expect(r.archive?.modes).toContain('extract');
    expect(writeSlots(r).map(s => [s.arg, s.offset, s.value])).toContainEqual([5, 2, '/etc']);
    expect(write(['tar', '-tf./a', '-C/etc'])).toEqual([]);
  });
});
