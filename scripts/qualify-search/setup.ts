// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, vi } from 'vitest';
// Bootstrap before importing ANY server module: some server testing utilities
// import config.ts transitively. No inherited runtime setting survives.
const { scrubAmbientMurageEnv } = await import('../../server/testing/murage-env.mjs');
const ambient = scrubAmbientMurageEnv();
const root = mkdtempSync(join(process.env.MURAGE_QUAL_STORAGE ?? tmpdir(), 'fts-qual-scratch-'));
const homeRoot = mkdtempSync(join(tmpdir(), 'fts-qual-home-'));
process.env.HOME = homeRoot; process.env.USERPROFILE = homeRoot;
process.env.MURAGE_DATA_DIR = join(root,'data');
process.env.MURAGE_QUAL_FIXTURE_ROOT = root;
mkdirSync(process.env.HOME,{recursive:true});mkdirSync(process.env.MURAGE_DATA_DIR,{recursive:true});
process.env.MURAGE_TEST_ENV_SCRUBBED = '1';
process.env.MURAGE_ENGINE_EXCLUSION_PATH = resolve('server/testing/engine-exclusion-stub.cjs');
(globalThis as Record<symbol,unknown>)[Symbol.for('murage.hostPower.testUnwrapped')] = true;
const {installSafeWipeGuard} = await import('../../server/testing/safe-wipe.mjs');
installSafeWipeGuard({protect:[ambient.MURAGE_DATA_DIR,ambient.MURAGE_COMPANION_DIR].filter((value):value is string=>typeof value==='string')});
afterAll(async()=>{
  const {settleTestHandles}=await import('../../server/test-handle-registry.ts');
  await settleTestHandles();
  const {removeTempDir}=await import('../../server/testing/cleanup.ts');
  await removeTempDir(root); await removeTempDir(homeRoot);
});

// Vitest mock replaces only the Worker constructor's eval source with the same
// source plus the observer. Child workers remain real Node workers.
vi.mock('node:worker_threads', async importOriginal => {
  const real = await importOriginal<typeof import('node:worker_threads')>();
  const { telemetry } = await import('./telemetry.ts');
  const { fixtureSource } = await import('./segments.ts');
  class ObservedWorker extends real.Worker {
    constructor(file: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const observed=typeof file==='string'&&options?.eval&&file.includes('messages_fts');
      super(observed ? file+telemetry+fixtureSource() : file, options);
      if(observed){const g=globalThis as Record<symbol,unknown>;const key=Symbol.for('murage.qual.workers');const workers=(g[key]??=[]) as import('node:worker_threads').Worker[];workers.push(this);}
    }
  }
  return { ...real, Worker: ObservedWorker };
});
