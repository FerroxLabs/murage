// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.23 q1023-bump14: GH18 fresh start on a store at this build's memory schema (14), through the real route on a booted server and the
// real planner (gh18-fresh-start.ts planFreshStart, loaded by index.ts). Up to 413760e90e the planner admitted schema 13 only, so every
// preview of a v14 store answered blocked/unsupported-schema and the owner could never start fresh.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import { MEMORY_SCHEMA_VERSION } from './memory/schema.ts';

it('gh18_v14_store_preview_is_not_blocked_by_schema: an idle bot on a freshly migrated store previews nothing-to-do, not unsupported-schema', async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs'); const path=await import('node:path');
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'server/drivers/builtIn.ts')).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'server/testing/fake-late-terminal-driver.ts')).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'); const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.gh18={driver:'fakeLateTerminal',environment:{}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  try {
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret };
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    // the store the server opened is at this build's schema (no hardcoded number: the constant the migration writes)
    const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true });
    try { expect(db.prepare('SELECT schema_version FROM memory_meta WHERE id=1').get()).toEqual({ schema_version: MEMORY_SCHEMA_VERSION }); }
    finally { db.close(); }
    const { body: { bot } } = await api('POST', '/api/bots', { name: 'GH18 v14', modelSelection: { instanceId: 'gh18', model: 'late-1' } });
    const preview = await api('POST', `/api/memory/bots/${bot.id}/fresh-start/preview`, {});
    expect(preview.status).toBe(200);
    expect({ state: preview.body.state, reason: preview.body.reason }).toEqual({ state: 'nothing-to-do', reason: 'no-change' });
  } finally { await fixture.close(); }
}, 180_000);
