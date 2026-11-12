import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DownloadRegistry } from './download-registry.ts';
import { cwdOutsideMark } from './outside-wire.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
it('Susan cwd: a clone below 500 ordinary folders does not mark until instructions or real reads', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'botcreate-cwd-')); dirs.push(cwd); const clone = join(cwd, 'repo'); mkdirSync(clone);
  for (let i = 0; i < 500; i++) mkdirSync(join(cwd, 'ordinary-' + i));
  const registry = new DownloadRegistry(); registry.add([{ path: clone, kind: 'repo', since: 1 }, { path: join(cwd, 'generated'), kind: 'window', since: 1, until: 2 }]);
  expect(cwdOutsideMark(cwd, registry, undefined, 'fuigoAgent')).toBeNull();
  expect(cwdOutsideMark(clone, registry, undefined, 'fuigoAgent')).toBe('cloned folder');
  writeFileSync(join(clone, 'AGENTS.md'), 'instructions');
  expect(cwdOutsideMark(cwd, registry, undefined, 'fuigoAgent')).toBe('cloned folder');
});
it('an outside .mcp.json in the working folder marks at startup', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'botcreate-mcp-')); dirs.push(cwd); const file = join(cwd, '.mcp.json'); writeFileSync(file, '{}');
  const registry = new DownloadRegistry(); registry.add([{ path: file, kind: 'file', since: 1 }]);
  expect(cwdOutsideMark(cwd, registry, undefined, 'codex')).toBe('cloned folder');
});
it('a missing cwd is not clean even when the registry is empty', () => { expect(cwdOutsideMark(undefined, new DownloadRegistry())).toBe('folder not checked'); });
