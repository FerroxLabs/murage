import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { WebDocuments } from './web-documents.ts';
import { WebDocumentBudget } from './web-document-budget.ts';
import { BrowserExtensionExecutor } from './browser-extension-executor.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
it('per-bot and global caps span stores, and disposal immediately returns capacity', () => {
  const budget = new WebDocumentBudget(':memory:', 40, 24);
  const a = new WebDocuments(100, Date.now, 'a', budget), b = new WebDocuments(100, Date.now, 'a', budget), c = new WebDocuments(100, Date.now, 'c', budget);
  try {
    a.save('a/thread1', '12345678', 'https://a.test');
    expect(() => b.save('a/thread2', '12345', 'https://a.test')).toThrow('full');
    c.save('c/thread1', '1234567890', 'https://c.test');
    expect(() => b.save('a/thread2', '123', 'https://a.test')).toThrow('full');
    a.dispose();
    expect(b.save('a/thread2', '12345678', 'https://a.test').text).toBe('12345678');
  } finally { a.dispose(); b.dispose(); c.dispose(); budget.close(); }
});
it('a new store sweeps expired siblings even without timer delivery', () => {
  let now = 0;
  const budget = new WebDocumentBudget(':memory:', 20, 20);
  const a = new WebDocuments(100, () => now, 'a', budget);
  a.save('a/t', '1234567890', 'https://a.test'); now = 3_600_001;
  const b = new WebDocuments(100, () => now, 'b', budget);
  try { expect(b.save('b/t', '1234567890', 'https://b.test').eof).toBe(true); expect((a as any).entries.size).toBe(0); }
  finally { a.dispose(); b.dispose(); budget.close(); }
});
it('independent reader processes share the same aggregate ceiling', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-budget-test-')), file = join(root, 'budget.sqlite');
  const budget = new WebDocumentBudget(file, 20, 20);
  try {
    budget.reserve('parent', 'a', 16);
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { WebDocumentBudget } from ${JSON.stringify(new URL('./web-document-budget.ts', import.meta.url).href)}; const b = new WebDocumentBudget(${JSON.stringify(file)},20,20); try { b.reserve('child','b',8); process.exitCode=9; } catch(e) { if (!e.message.includes('full')) throw e; } finally { b.close(); }`], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  } finally { budget.release('parent'); budget.close(); removeTempDirSync(root); }
});
it('Chrome invalidates only the saved origin and clears on close', async () => {
  const executor = new BrowserExtensionExecutor({ documentOwner: 'fixture-bot', authorize: () => true, access: async () => true, admit: async () => true, transport: {} as any });
  const documents = (executor as any).readDocuments as WebDocuments;
  const a = documents.save('browser', 'A tail', 'https://a.test/page'), b = documents.save('browser', 'B tail', 'https://b.test/page');
  executor.invalidateReadOrigin('https://a.test');
  expect(() => documents.read('browser', { handle: a.handle })).toThrow('missing');
  expect(documents.read('browser', { handle: b.handle }).text).toBe('B tail');
  await executor.close();
  expect(() => documents.read('browser', { handle: b.handle })).toThrow('missing');
});
it('startup sweeps reservations from exited readers', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-budget-startup-')), file = join(root, 'budget.sqlite');
  try {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import { WebDocumentBudget } from ${JSON.stringify(new URL('./web-document-budget.ts', import.meta.url).href)}; const b = new WebDocumentBudget(${JSON.stringify(file)},20,20); b.reserve('exited','bot',20); b.close();`], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    const budget = new WebDocumentBudget(file, 20, 20);
    try { expect(() => budget.reserve('new', 'bot', 20)).not.toThrow(); }
    finally { budget.release('new'); budget.close(); }
  } finally { removeTempDirSync(root); }
});
