import { removeTempDirSync } from "./testing/cleanup.ts";
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const child = vi.hoisted(() => ({ code: 0, stdout: 'present\n', stderr: '', calls: [] as { file: string; args: string[] }[] }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (file: string, args: string[], options: object, callback: any) => {
    child.calls.push({ file, args });
    // Exercise the real execFile callback/error contract with an isolated child.
    // Only the Windows tool is replaced; neither deps.policy nor deps.run is used.
    if (child.code === -1) return actual.execFile('/missing-s4-policy-tool', args, options, callback);
    return actual.execFile(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(child.stdout)}); process.stderr.write(${JSON.stringify(child.stderr)}); process.exit(${child.code});`], options, callback);
  } };
});
import { createWindowChromeResolver } from './browser-window-chrome.ts';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chrome-policy-')); child.calls = []; });
afterEach(() => removeTempDirSync(root));
it.each([
  [0, 'present\n', '', 'org_managed'],
  [2, 'absent\n', '', 'ok'],
  [3, '', 'Zugriff verweigert', 'unverified'],
  [1, '', 'ERROR: The system was unable to find the specified registry key or value.', 'unverified'],
  [2, '', 'tool failed', 'unverified'],
  [2, 'absent\n', 'unexpected diagnostic', 'unverified'],
  [0, '', '', 'unverified'],
  [127, '', 'outil introuvable', 'unverified'],
  [-1, '', '', 'unverified'],
])('real subprocess policy exit %s / %s / %s yields %s', async (code, stdout, stderr, result) => {
  Object.assign(child, { code, stdout, stderr });
  const executable = join(root, 'chrome.exe'); writeFileSync(executable, 'MZfixture');
  const authenticode = vi.fn(async () => ({ status: 'Valid', subject: 'O=Google LLC', organization: 'Google LLC', thumbprint: 'ab'.repeat(32) }));
  const resolver = createWindowChromeResolver({ platform: 'win32', dataDir: join(root, 'data'),
    validated: { darwin: { installedVersions: [], cft: null }, linux: { installedVersions: [], cft: null }, win32: { installedVersions: ['157.0.8103.38'], cft: null } },
    deps: { candidates: () => [{ root, executable }], readVersion: () => '157.0.8103.38', authenticode } });
  const answer = await resolver.resolve({ mode: 'prepare' });
  if (result === 'ok') expect(answer).toHaveProperty('ok');
  else expect(answer).toHaveProperty('cause', result);
  expect(child.calls).toHaveLength(1);
  expect(child.calls[0].file).toMatch(/System32.*WindowsPowerShell.*powershell.exe$/);
  const script = child.calls[0].args.at(-1)!;
  expect(script).toContain('Registry64'); expect(script).toContain('OpenSubKey'); expect(script).toContain('$null -eq $key');
  if (result !== 'ok') expect(authenticode).not.toHaveBeenCalled();
});
