// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../../scripts/control-murage.ts';

it.each(['peer', 'bot-access', 'room-share', 'phone', 'routine', 'email', 'browser', 'unreadable', 'recover'])(
  'listens and reports a recovery failure without changing the damaged %s queue', async kind => {
    const file = kind === 'unreadable' || kind === 'recover' ? 'peer' : kind;
    const original = kind === 'recover' ? '{"version":1,"entries":[]}' : '{private-fixture';
    const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const folder = join(process.env.MURAGE_DATA_DIR, 'decision-queues');
      mkdirSync(folder, {recursive:true});
      const file = join(folder, ${JSON.stringify(file + '.json')});
      ${kind === 'unreadable' ? 'mkdirSync(file); writeFileSync(join(file, "kept"), "private-fixture");' : `writeFileSync(file, ${JSON.stringify(original)});`}
      ${kind === 'recover' ? `
        const {registerHooks} = await import('node:module');
        registerHooks({load(url, context, next) {
          const loaded = next(url, context);
          if (!url.endsWith('/server/decision/implementation.ts')) return loaded;
          const anchor = 'export async function recover():Promise<void>{';
          const source = String(loaded.source);
          if (!source.includes(anchor)) throw Error('recovery fault anchor missing');
          return {...loaded, source:source.replace(anchor, anchor+"throw new Error('queue-recovery-source-missing');")};
        }});
      ` : ''}
    ` }).catch(error => {
      const path = String(error.message).split('see ')[1];
      if (path) throw new Error(readFileSync(path.trim(), 'utf8').slice(-6000), {cause:error});
      throw error;
    });
    try {
      const response = await fetch(fixture.info.url + '/api/health');
      expect(response.status).toBe(200);
      const health = await response.json() as { decisionRecoveryFailed: unknown };
      expect(health.decisionRecoveryFailed).toMatchObject({ code: kind === 'recover' ? 'queue-recovery-source-missing' : 'decision-recovery-failed', at: expect.any(Number) });
      const path = join(fixture.info.dataDir, 'decision-queues', file + '.json');
      expect(readFileSync(kind === 'unreadable' ? join(path, 'kept') : path, 'utf8')).toBe(kind === 'unreadable' ? 'private-fixture' : original);
      expect(readFileSync(fixture.info.logPath, 'utf8')).not.toContain('private-fixture');
    } finally { await fixture.close(); }
  });

// The start's `finally` clears the recovery-only generation map. Real start, real index.ts: a seed is put in the map just before the recovery
// step, and a probe line (written after the `finally`, before the sweep high-water mark) reports what is left in it and in the context map.
it('the real start leaves no recovery-time generation context behind once recovery has finished', async () => {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    const { registerHooks } = await import('node:module');
    registerHooks({load(url, context, next) {
      const loaded = next(url, context);
      if (!url.endsWith('/server/index.ts')) return loaded;
      const source = String(loaded.source);
      const before = 'await recover();';
      const after = 'const cardSweepHigh = messagesHighWater();';
      if (source.split(before).length !== 2 || source.split(after).length !== 2) throw Error('boot probe anchor missing');
      return {...loaded, source: source
        .replace(before, "decisionRecoveryByGeneration.set('probe-generation', {generation:'probe-generation'}); decisionRecoveryContexts.set('probe-thread', {generation:'probe-generation', threadId:'probe-thread'}); " + before)
        .replace(after, "appendFileSync(join(DATA_DIR, 'recovery-probe.json'), JSON.stringify({byGeneration: decisionRecoveryByGeneration.size, contexts: decisionRecoveryContexts.size, open: decisionRecoveryOpen})); " + after)};
    }});
  ` }).catch(error => {
    const path = String(error.message).split('see ')[1];
    if (path) throw new Error(readFileSync(path.trim(), 'utf8').slice(-6000), {cause:error});
    throw error;
  });
  try {
    expect((await fetch(fixture.info.url + '/api/health')).status).toBe(200);
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, 'recovery-probe.json'), 'utf8'))).toEqual({ byGeneration: 0, contexts: 0, open: false });
  } finally { await fixture.close(); }
});
