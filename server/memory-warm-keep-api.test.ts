// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: warm-keep owns continuation decisions and this dispatch regression;
// recall-s1s2 owns recall admission/recovery (no fixture bypasses that boundary).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, onTestFailed } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';
import { beginIntegrityPass } from './memory/integrity-state.ts';

for (const engine of ['claude', 'acp'] as const) {
  for (const scenario of ['ordinary', 'restart', 'old-pending', 'verifying'] as const) {
    it(`${engine}: ten captured owner turns stay warm (${scenario})`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        if (scenario === 'restart') {
          await w.turn(bot, 'Before the app restart');
          await w.fixture.restart(); await w.login();
        }
        if (scenario === 'old-pending') w.write(db => {
          // An old, still unfinished marker, as on 1.0.18. Its cap predates this session.
          // Unreadable frontier deliberately keeps background cleanup from hiding the defect.
          db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(700001,'line',?,1,1,'mark','','active')")
            .run(JSON.stringify({ kind: 'line', threadId: 'unrelated-fixture-thread', lines: 1, cause: 'edit' }));
          db.exec("INSERT INTO memory_deny_pending VALUES('*',1,700001); INSERT INTO memory_revoke_frontier VALUES(700001,1,'{unreadable')");
        });
        const start = w.log().length;
        const sessionIds: string[] = [];
        let rpcAfterFirst = 0;
        for (let n = 0; n < 10; n++) {
          if (scenario === 'verifying') w.write(db => beginIntegrityPass(db));
          await w.turn(bot, `Owner turn ${n + 1}: the fixture garden gate is green.`);
          sessionIds.push(w.session(bot.threadId));
          if (n === 0) rpcAfterFirst = w.rpc().length;
        }
        expect(sessionIds.every(Boolean)).toBe(true);
        expect(new Set(sessionIds.slice(1)).size).toBe(1);
        expect(sessionIds[1]).toBe(sessionIds[0]);
        const log = w.log().slice(start);
        expect(log).not.toContain('memory continuation reset');
        expect(log).not.toContain('starting turn without recalled memory');
        if (engine === 'claude') {
          const timings = log.split('\n').filter(line => line.includes(`claude first-token thread=${bot.threadId} `));
          expect(timings).toHaveLength(10);
          for (const line of timings.slice(1)) expect(line).toMatch(/process=reused|resumed=true/);
        } else {
          const calls = w.rpc().slice(rpcAfterFirst);
          expect(calls.filter(row => row.method === 'session/new')).toHaveLength(0);
        }
        if (scenario === 'old-pending') expect(w.read(db => db.prepare('SELECT 1 FROM memory_deny_pending WHERE revoke_id=700001').get())).toBeTruthy();
      } finally { await w.fixture.close(); }
    }, 240_000);
  }
  for (const change of ['forget', 'edit', 'access', 'roster', 'deny'] as const) {
    it(`${engine}: a real ${change} resets a retained session`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        await w.turn(bot, 'The fixture garden gate is green.');
        const established = w.session(bot.threadId);
        expect(established).toBeTruthy();
        await w.turn(bot, 'The fixture shed is blue.');
        const before = w.session(bot.threadId), start = w.log().length;
        expect(before).toBe(established);
        const source = w.read(db => {
          const row = db.prepare("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!;
          return (JSON.parse(String(row.source_versions)) as Array<{ id: string }>)[0]?.id;
        });
        if (change === 'forget') {
          expect(source).toBeTruthy();
          await w.api('POST', '/api/memory/action', { action: 'forget', kind: 'source', id: source });
        } else if (change === 'edit') {
          const record = w.read(db => {
            const row = db.prepare("SELECT record_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!;
            const cited = (JSON.parse(String(row.record_versions)) as Array<{ id: string; version: number }>)[0];
            return cited && db.prepare('SELECT id,version FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1').get(cited.id);
          });
          expect(record).toBeTruthy();
          await w.api('POST', '/api/memory/action', { action: 'correct', ...record, text: 'The fixture garden gate is red.' });
        } else if (change === 'access') {
          await w.api('POST', '/api/memory/action', { action: 'configure', excludedThreadIds: [bot.threadId] });
        } else if (change === 'roster') {
          await w.api('PATCH', `/api/bots/${bot.id}`, { section: 'Fixture changed team' });
        } else {
          w.write(db => {
            db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,700002)').run(bot.threadId, 'verification', before);
            db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
          });
        }
        await w.turn(bot, 'Continue after the owner change.');
        expect(w.session(bot.threadId)).not.toBe(before);
        expect(w.log().slice(start)).toContain('memory continuation reset');
        expect(w.log().slice(start).split('\n').filter(line => line.includes(`memory continuation reset thread=${bot.threadId} `))).toHaveLength(1);
      } finally { await w.fixture.close(); }
    }, 180_000);
  }
}

async function world(engine: 'claude' | 'acp') {
  const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const fixture: VerificationServer = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    await import(${url('server/testing/fake-engine-env-preload.mjs')});
    // Deterministic idle host: normal capture must not wait on unrelated CI-machine load.
    await import(${url('server/testing/idle-load-preload.mjs')});
    process.env.MURAGE_TURN_TRACE='1';
    const fs=await import('node:fs'),path=await import('node:path');
    const {fileURLToPath}=await import('node:url');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
    if (${JSON.stringify(engine)}==='acp') config.instances.verification={driver:'grokAgent',config:{cli:fileURLToPath(${url('server/testing/fake-acp-cli.ts')})},environment:{
      FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',
      FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'warm-rpc.jsonl')}};
    fs.writeFileSync(file,JSON.stringify(config));
  ` });
  onTestFailed(() => console.error(readFileSync(fixture.info.logPath, 'utf8').slice(-12_000)));
  let headers: Record<string, string> = {};
  const login = async () => {
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  };
  await login();
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const read = <T>(fn: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'), { readOnly: true }); try { return fn(db); } finally { db.close(); } };
  const write = (fn: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db')); try { db.exec('PRAGMA busy_timeout=10000'); fn(db); } finally { db.close(); } };
  const log = () => readFileSync(fixture.info.logPath, 'utf8');
  const session = (thread: string) => read(db => String(db.prepare("SELECT native_session FROM memory_disclosures WHERE thread_id=? AND state='delivered' AND native_session IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(thread)?.native_session ?? ''));
  const bot = async () => {
    const { bot } = await api('POST', '/api/bots', { name: 'Warm fixture' });
    await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false });
    return bot as { id: string; threadId: string };
  };
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    const replies = async () => (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages.filter((m: any) => m.role === 'bot' && m.kind === 'text' && m.text).length;
    const before = await replies(), logStart = log().length;
    const captured = read(db => Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(bot.threadId)!.n));
    await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    await expect.poll(replies, { timeout: 45_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15_000 }).not.toBe(true);
    expect(log().slice(logStart)).not.toContain('starting turn without recalled memory');
    expect(read(db => Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(bot.threadId)!.n))).toBeGreaterThan(captured);
    await expect.poll(() => read(db => Number(db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(bot.threadId)!.n)), { timeout: 30_000 }).toBe(0);
  };
  const rpc = (): any[] => { const file = join(fixture.info.dataDir, 'warm-rpc.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
  return { fixture, login, api, read, write, log, session, bot, turn, rpc };
}
