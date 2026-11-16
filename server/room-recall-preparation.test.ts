// SPDX-License-Identifier: AGPL-3.0-or-later
// Room preparation producer owner: recall-fix-a. Receipt consumer owner: recall-fix-a.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFailed } from 'vitest';
import { launchMemoryVerificationServer } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';

it('room adapter preparation validates its real receipt without recording delivery', async () => {
  const fixture = await launchMemoryVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'server/testing/fake-engine-env-preload.mjs')).href)});
    await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'server/testing/idle-load-preload.mjs')).href)});
    const fixtureFs=await import('node:fs'),fixturePath=await import('node:path');
    globalThis.fixtureRoomPreparation=row=>fixtureFs.writeFileSync(fixturePath.join(process.env.MURAGE_DATA_DIR,'room-preparation.json'),JSON.stringify(row));
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/server/index.ts'))return result;
      let source=String(result.source);
      const needle='submissionBoundary.beforePrepare(validateRoomSubmission);';
      if(source.split(needle).length!==2)throw new Error('room preparation hook moved');
      source=source.replace(needle,needle+\`if(memoryReceipt){globalThis.fixtureRoomPreparation(database().prepare('SELECT state FROM memory_disclosures WHERE bundle_id=?').get(memoryReceipt.bundle.bundleId));}\`);
      return {...result,source};
    }});
  ` });
  onTestFailed(() => console.error(readFileSync(fixture.info.logPath, 'utf8').split('\n').slice(-20).join('\n')));
  try {
    const secret = (await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string }).secret;
    const headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret };
    const api = async (path: string, body: unknown): Promise<any> => {
      const response = await fetch(fixture.info.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const { bot } = await api('/api/bots', { name: 'Preparation reader' });
    const configured = await fetch(fixture.info.url + `/api/bots/${bot.id}`, { method: 'PATCH', headers, body: JSON.stringify({ computer: 'off', browser: false, composio: false }) });
    expect(configured.ok).toBe(true);
    const { group } = await api('/api/groups', { name: 'Preparation room', memberIds: [bot.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } } });
    await api(`/api/groups/${group.id}/messages`, { text: 'Read the preparation fixture.' });
    const snapshot = join(fixture.info.dataDir, 'room-preparation.json');
    await expect.poll(() => existsSync(snapshot), { timeout: 30_000 }).toBe(true);
    expect(JSON.parse(readFileSync(snapshot, 'utf8'))).toEqual({ state: 'prepared' });
  } finally { await fixture.close(); }
}, 60_000);
