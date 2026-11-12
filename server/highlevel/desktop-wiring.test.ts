// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { highLevelHarness } from '../testing/fake-highlevel.ts';
import { createHighLevelRuntime } from './runtime.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../testing/cleanup.ts';
it('R2/R3 retired password routes and IPC have no executable wiring', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source.includes('createDesktopUserCompletion(')).toBe(false);
  expect(source.includes('installHighLevelNativeSessions(')).toBe(false);
  expect(source.includes('readPasswordBody(')).toBe(false);
  const main = readFileSync(new URL('../../electron/main.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
  expect(main.includes('highlevel-password:')).toBe(false); expect(preload.includes('highlevel-password:')).toBe(false);
});
it('R8 production runtime owns durable cross process user identity claims', async () => {
  const h = highLevelHarness(), dataDir = mkdtempSync(join(tmpdir(), 'hlpw3-runtime-'));
  let rt: ReturnType<typeof createHighLevelRuntime> | undefined;
  try {
    rt = createHighLevelRuntime({ dataDir, capabilities: h.capabilities, threadMarkState: () => 'marked', signals: h.signals, bot: () => h.bot, leases: h.leases, fetch: h.api.fetch });
    expect(typeof (rt as any).userCreateClaims?.acquire).toBe('function');
    const claim = (rt as any).userCreateClaims.acquire('company', 'fixture@fixture.test', 'action');
    expect(claim).toBeDefined(); claim.barrier();
    expect((rt as any).userCreateClaims.acquire('company', 'FIXTURE@fixture.test', 'other')).toBeUndefined();
    expect(typeof (rt as any).close).toBe('function');
  } finally { (rt as any)?.close?.(); h.stop(); await removeTempDir(dataDir); }
});
it('R3/R10 isolated production HTTP retires password routes without persisting submitted secrets', async () => {
  const { launchVerificationServer, runControlMurage } = await import('../../scripts/control-murage.ts');
  const { HighLevelLeakGuardV2 } = await import('../testing/highlevel-leak-guard-v2.ts');
  const { randomBytes } = await import('node:crypto');
  const { mkdirSync, writeFileSync, copyFileSync, existsSync, lstatSync, readdirSync } = await import('node:fs');
  const sentinel = `Aa4!${randomBytes(24).toString('base64url')}`, guard = new HighLevelLeakGuardV2([sentinel]);
  const session = await launchVerificationServer(process.env);
  const firstLogPath = session.info.logPath;
  const evidence = '.test-tmp/bld-hl-userscreate/retired-routes'; mkdirSync(evidence, { recursive: true });
  try {
    const doctor = await runControlMurage(['doctor', '--url', session.info.url], { env: { ...process.env, MURAGE_DATA_DIR: session.info.dataDir } }) as { ok: boolean };
    expect(doctor.ok).toBe(true);
    const proof = await fetch(`${session.info.url}/api/desktop-secret`).then(response => response.json()) as { secret: string };
    const results = [];
    for (const suffix of ['password-session', 'create-user']) {
      const response = await fetch(`${session.info.url}/api/highlevel/reviews/hla_00000000-0000-4000-8000-000000000001/${suffix}`, {
        method: 'POST', redirect: 'error', headers: { origin: session.info.url, 'content-type': 'application/json',
          'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret, 'x-murage-highlevel-session': 'd'.repeat(64) },
        body: JSON.stringify({ reviewDigest: 'a'.repeat(64), submissionNonce: 'b'.repeat(64), password: sentinel }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      guard.wrapSink('event_stream', (_value: unknown) => {})(body);
      results.push({ suffix, status: response.status, body });
    }
    // Keep the scanner's refusal of incomplete/empty evidence. Enumerate every
    // persisted file explicitly; an empty directory has no bytes to inspect.
    const scanPersisted = async () => {
      // SQLite may checkpoint or remove a WAL between enumeration and read.
      // Retry the complete collection only when a concurrent change is proven;
      // an unchanged unreadable, malformed or missing artifact still fails.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const files = [...new Set([firstLogPath, session.info.logPath])]; let emptyDirectories = 0, sockets = 0;
        const visit = (path: string) => {
          const stat = lstatSync(path); expect(stat.isSymbolicLink()).toBe(false);
          if (stat.isDirectory()) {
            const children = readdirSync(path); if (!children.length) emptyDirectories++;
            for (const child of children) visit(join(path, child));
          } else if (stat.isFile()) files.push(path);
          else { expect(stat.isSocket()).toBe(true); sockets++; }
        };
        visit(session.info.dataDir);
        expect(files.length).toBeGreaterThan(1);
        const stamp = (path: string) => { try { const stat = lstatSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return 'missing'; } };
        const before = files.map(stamp);
        let scan;
        try { scan = await guard.scanFiles(files); } catch (error) {
          const changed = files.some((file, index) => stamp(file) !== before[index]);
          if (!changed || attempt === 3) throw error;
          continue;
        }
        expect(scan.leaks).toBe(0);
        return { ...scan, emptyDirectories, sockets, collectionAttempts: attempt };
      }
      throw new Error('Leak evidence is incomplete.');
    };
    const scan = await scanPersisted();
    await session.stop(); const afterShutdown = await scanPersisted();
    await session.restart(); const afterRestart = await scanPersisted();
    copyFileSync(firstLogPath, join(evidence, 'first-server.log'));
    copyFileSync(session.info.logPath, join(evidence, 'server.log'));
    writeFileSync(join(evidence, 'verification.json'), JSON.stringify({ fixture: session.info, doctor, results, scan, afterShutdown, afterRestart }, null, 2));
  } finally { await session.close(); }
  expect(existsSync(session.info.dataDir)).toBe(false);
  expect((await guard.scanFiles([session.info.logPath])).leaks).toBe(0);
}, 60_000);
