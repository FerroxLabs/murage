// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: warm-keep owns continuation decisions and the original matrix;
// recall-s1s2d owns recovery; afix-warm-capture-b applies MAIN's sequencing ruling.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, onTestFailed } from 'vitest';
import type { VerificationServer } from '../scripts/control-murage.ts';
import { launchMemoryVerificationServer as launchVerificationServer } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';
import { beginIntegrityPass } from './memory/integrity-state.ts';
import type { Message } from './store.ts';
import { isMurageVoice } from './murage-voice.ts';

for (const engine of ['claude', 'acp'] as const) {
  it(`${engine}: capture setup completes owner and reply jobs`, async () => {
    const w = await world(engine);
    try {
      await w.turn(await w.bot(), 'The fixture garden gate is green.', true);
    } finally { await w.fixture.close(); }
  }, 180_000);
  for (const scenario of ['ordinary', 'restart', 'old-pending', 'verifying', 'readiness-recovery', 'checking-recovery'] as const) {
    // Both matrices: the captured one drains capture between turns; the overlapping one (MAIN RULING 1115-WARM-MATRIX)
    // holds capture so every immediate ingress enters with the previous reply capture owed.
    const overlaps = ['ordinary', 'restart', 'readiness-recovery', 'checking-recovery'].includes(scenario);
    for (const capturedSetup of overlaps ? [true, false] : [true]) {
    it(`${engine}: ten ${capturedSetup ? 'captured' : 'overlapping'} owner turns stay warm (${scenario})`, async () => {
      const immediate = !capturedSetup;
      const w = await world(engine, scenario === 'readiness-recovery' ? 'readiness' : scenario === 'checking-recovery' ? 'checking' : 'none', immediate);
      try {
        const bot = await w.bot();
        if (scenario === 'restart') {
          if (capturedSetup) await w.turn(bot, 'Before the app restart', true);
          else {
            await w.acceptedTurn(bot, 'Before the app restart');
            expect(w.pendingReply(bot.threadId)).toBeTruthy();
          }
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
          // MAIN RULING 1115-WARM-MATRIX: old-pending/verifying drain; all other warm rows overlap.
          if (immediate && (n || scenario === 'restart')) expect(w.pendingReply(bot.threadId), `turn ${n + 1} enters with the previous reply capture owed`).toBeTruthy();
          if (immediate) await w.acceptedTurn(bot, `Owner turn ${n + 1}: the fixture garden gate is green.`);
          else await w.turn(bot, `Owner turn ${n + 1}: the fixture garden gate is green.`, true);
          if (immediate) expect(w.pendingReply(bot.threadId), 'MAIN RULING 1115-WARM-MATRIX: terminal reply capture remains owed until the next ingress').toBeTruthy();
          sessionIds.push(w.session(bot.threadId));
          if (n === 0) rpcAfterFirst = w.rpc().length;
        }
        expect(sessionIds.every(Boolean)).toBe(true);
        // MAIN RULING 1115-RECALL-DESIGN-GROK: forced held/checking turns replace recalled sessions; every subsequent full turn stays warm.
        const forced=scenario==='readiness-recovery'||scenario==='checking-recovery';
        for(let n=1;n<10;n++) {
          if(forced&&[2,5,8].includes(n))expect(sessionIds[n]).not.toBe(sessionIds[n-1]);
          else expect(sessionIds[n]).toBe(sessionIds[n-1]);
        }
        const log = w.log().slice(start);
        // MAIN RULING 1115-RECALL-DESIGN-GROK: the three forced unavailable turns each make exactly one replacement.
        if(forced)expect(log.split('\n').filter(line=>line.includes('memory continuation reset'))).toHaveLength(3);
        else expect(log).not.toContain('memory continuation reset');
        if (scenario === 'readiness-recovery' || scenario === 'checking-recovery') expect(log.match(/fixture forced recall (readiness|checking)/g)).toHaveLength(3);
        expect(log).not.toContain('starting turn without recalled memory');
        if (engine === 'claude') {
          const timings = log.split('\n').filter(line => line.includes(`claude first-token thread=${bot.threadId} `));
          expect(timings).toHaveLength(10);
          // MAIN RULING 1115-RECALL-DESIGN-GROK: only forced held/checking turns start a replacement process.
          for (let n=1;n<timings.length;n++) if(!forced||![2,5,8].includes(n))expect(timings[n]).toMatch(/process=reused|resumed=true/);
        } else {
          const calls = w.rpc().slice(rpcAfterFirst);
          // MAIN RULING 1115-RECALL-DESIGN-GROK.
          expect(calls.filter(row => row.method === 'session/new')).toHaveLength(forced?3:0);
        }
        if (scenario === 'old-pending') expect(w.read(db => db.prepare('SELECT 1 FROM memory_deny_pending WHERE revoke_id=700001').get())).toBeTruthy();
        if (capturedSetup) await w.capture(bot);
      } finally { await w.fixture.close(); }
    }, capturedSetup ? 240_000 : 2_400_000);
    }
  }
  for (const change of ['forget', 'edit', 'access', 'roster', 'deny'] as const) {
    it(`${engine}: a real ${change} resets a retained session`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        let withdrawnThread = bot.threadId;
        if (change === 'access') {
          // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: withdraw actual
          // shown access while this conversation's original capture checks stay
          // meaningful. Excluding the current chat also forbids its new captures.
          const { task } = await w.api('POST', `/api/bots/${bot.id}/tasks`, { title: 'Fixture earlier conversation' });
          withdrawnThread = task.threadId;
          await w.acceptedTurn({ ...bot, threadId: withdrawnThread }, 'The fixture garden gate is green.');
          const earlier = w.read(db => db.prepare("SELECT s.id,s.scope_id,s.revision,json_extract(v.payload,'$.text') AS text FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.thread_id=? AND s.speaker='owner' AND s.kind='text' ORDER BY s.rowid LIMIT 1").get(withdrawnThread));
          expect(earlier).toBeTruthy();
          w.write(db => {
            db.prepare("INSERT INTO memory_records VALUES('fixture-access-record',1,?,'constraint','The fixture garden gate is green.','owner-statement','active',1,1,NULL,NULL,1)").run(String(earlier!.scope_id));
            db.prepare("INSERT INTO memory_evidence VALUES('fixture-access-record',1,?,?,0,?)").run(String(earlier!.id), Number(earlier!.revision), Buffer.byteLength(String(earlier!.text)));
          });
        }
        await w.turn(bot, 'The fixture garden gate is green.', true);
        const established = w.session(bot.threadId);
        expect(established).toBeTruthy();
        await w.turn(bot, 'The fixture shed is blue.', true);
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
          expect(w.read(db => JSON.parse(String(db.prepare("SELECT record_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!.record_versions)))).toContainEqual({ id: 'fixture-access-record', version: 1 });
          await w.api('POST', '/api/memory/action', { action: 'configure', excludedThreadIds: [withdrawnThread] });
        } else if (change === 'roster') {
          await w.api('PATCH', `/api/bots/${bot.id}`, { section: 'Fixture changed team' });
        } else {
          w.write(db => {
            db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,700002)').run(bot.threadId, 'verification', before);
            db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
          });
        }
        // MAIN RULING 1115-WARM-MATRIX: establish successful capture above, then send immediately after the real change.
        await w.acceptedTurn(bot, 'Continue after the owner change.');
        expect(w.session(bot.threadId)).not.toBe(before);
        expect(w.log().slice(start)).toContain('memory continuation reset');
        expect(w.log().slice(start).split('\n').filter(line => line.includes(`memory continuation reset thread=${bot.threadId} `))).toHaveLength(1);
      } finally { await w.fixture.close(); }
    }, 600_000);
  }
}

// MAIN RULING 1115-WARM-MATRIX: retain the additional recovery/privacy witnesses,
// with a real previous-reply capture job pending at every immediate ingress.
for (const engine of ['claude', 'acp'] as const) {
  for (const force of ['readiness', 'checking'] as const) {
    it(`${engine}: forced ${force} keeps ten accepted owner turns warm without capture drain`, async () => {
      const w = await world(engine, force, true);
      try {
        const bot = await w.bot(), start = w.log().length, sessions: string[] = [];
        let rpcAfterFirst = 0;
        for (let n = 1; n <= 10; n++) {
          if (n > 1) expect(w.pendingReply(bot.threadId), `turn ${n} enters with capture owed`).toBeTruthy();
          await w.acceptedTurn(bot, `Owner turn ${n}: the fixture garden gate is green.`);
          sessions.push(w.session(bot.threadId));
          if (n === 1) rpcAfterFirst = w.rpc().length;
        }
        expect(sessions.every(Boolean)).toBe(true);
        // MAIN RULING 1115-RECALL-DESIGN-GROK: each forced held/checking turn replaces recall, then full turns keep the replacement.
        for(let n=1;n<10;n++) {
          if([2,5,8].includes(n))expect(sessions[n]).not.toBe(sessions[n-1]);else expect(sessions[n]).toBe(sessions[n-1]);
        }
        const log = w.log().slice(start);
        expect(log.match(/fixture forced recall (readiness|checking)/g)).toHaveLength(3);
        // MAIN RULING 1115-RECALL-DESIGN-GROK.
        expect(log.split('\n').filter(line=>line.includes('memory continuation reset'))).toHaveLength(3);
        expect(log).not.toContain('starting turn without recalled memory');
        if (engine === 'claude') {
          const timings = log.split('\n').filter(line => line.includes(`claude first-token thread=${bot.threadId} `));
          expect(timings).toHaveLength(10);
          // MAIN RULING 1115-RECALL-DESIGN-GROK.
          for(let n=1;n<timings.length;n++)if(![2,5,8].includes(n))expect(timings[n]).toMatch(/process=reused|resumed=true/);
        // MAIN RULING 1115-RECALL-DESIGN-GROK.
        } else expect(w.rpc().slice(rpcAfterFirst).filter(row => row.method === 'session/new')).toHaveLength(3);
      } finally { await w.fixture.close(); }
    }, 240_000);
  }
  for (const change of ['forget', 'edit', 'access', 'roster', 'deny'] as const) {
    it(`${engine}: a real ${change} replaces the session with captured evidence`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        await w.acceptedTurn(bot, 'The fixture garden gate is green.');
        const established = w.session(bot.threadId);
        expect(established).toBeTruthy();
        // Actual owner message capture, not a completed-job stand-in. A fixed
        // active record makes extraction independent of the background worker.
        // It stays unpinned so a later real change tests session recovery rather
        // than the separate mandatory-pin refusal contract.
        const source = w.read(db => db.prepare("SELECT s.id,s.scope_id,s.revision,json_extract(v.payload,'$.text') AS text FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.thread_id=? AND s.speaker='owner' AND s.kind='text' ORDER BY s.rowid LIMIT 1").get(bot.threadId));
        expect(source).toBeTruthy();
        const section = change === 'roster' ? (await w.api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id).section?.trim() ?? '' : '';
        const scope = change === 'roster'
          ? w.read(db => db.prepare("SELECT id FROM memory_scopes WHERE kind='team' AND owner_key=?").get(section)!.id)
          : source!.scope_id;
        w.write(db => {
          db.prepare("INSERT INTO memory_records VALUES('fixture-warm-record',1,?,'constraint','The fixture garden gate is green.','owner-statement','active',0,1,NULL,NULL,1)").run(String(scope));
          db.prepare("INSERT INTO memory_evidence VALUES('fixture-warm-record',1,?,?,0,?)").run(String(source!.id), Number(source!.revision), Buffer.byteLength(String(source!.text)));
        });
        // Wait only for projection of this explicit fixture record; capture jobs
        // and their original matrix deadline are untouched. No verdict is seeded.
        await expect.poll(() => w.read(db => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE record_id='fixture-warm-record' AND state='active'").get()!.n)), { timeout: 15_000 }).toBeGreaterThan(0);
        await w.acceptedTurn(bot, 'The fixture garden gate is green. Use the garden gate constraint.');
        const before = w.session(bot.threadId);
        expect(before).toBe(established);
        const delivered = w.read(db => db.prepare("SELECT record_versions,source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!);
        expect(JSON.parse(String(delivered.record_versions))).toContainEqual({ id: 'fixture-warm-record', version: 1 });
        expect(JSON.parse(String(delivered.source_versions))).toContainEqual({ id: String(source!.id), revision: Number(source!.revision) });
        const start = w.log().length;
        if (change === 'forget') await w.api('POST', '/api/memory/action', { action: 'forget', kind: 'source', id: String(source!.id) });
        else if (change === 'edit') await w.api('POST', '/api/memory/action', { action: 'correct', id: 'fixture-warm-record', version: 1, text: 'The fixture garden gate is red.' });
        else if (change === 'access') await w.api('POST', '/api/memory/action', { action: 'configure', excludedThreadIds: [bot.threadId] });
        else if (change === 'roster') await w.api('PATCH', `/api/bots/${bot.id}`, { section: 'Fixture changed team' });
        else w.write(db => {
          db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,700002)').run(bot.threadId, 'verification', before);
          db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
        });
        await w.acceptedTurn(bot, 'Continue after the owner change.', change === 'access' ? 'excluded' : 'expected');
        expect(w.session(bot.threadId)).not.toBe(before);
        expect(w.log().slice(start).split('\n').filter(line => line.includes(`memory continuation reset thread=${bot.threadId} `))).toHaveLength(1);
        const after = w.read(db => db.prepare("SELECT record_versions,source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!);
        if (change !== 'deny') expect(JSON.parse(String(after.record_versions))).not.toContainEqual({ id: 'fixture-warm-record', version: 1 });
        if (change === 'forget' || change === 'access') expect(JSON.parse(String(after.source_versions))).not.toContainEqual({ id: String(source!.id), revision: Number(source!.revision) });
      } finally { await w.fixture.close(); }
    }, 180_000);
  }
}

// MAIN RULING 1115-WARM-MATRIX: superseded revisions are not owed; a failed
// or cancelled current revision must never satisfy a capture-wait row.
for (const status of ['failed', 'cancelled'] as const) {
  it(`claude: matrix capture gate refuses a current ${status} job`, async () => {
    const w = await world('claude', 'none', true);
    try {
      const bot = await w.bot();
      await w.acceptedTurn(bot, 'The fixture garden gate is green.');
      w.write(db => db.prepare("UPDATE memory_jobs SET status=? WHERE id IN (SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND j.stage='capture')").run(status, bot.threadId));
      await expect(w.waitCapture(bot.threadId, 1000)).rejects.toThrow();
    } finally { await w.fixture.close(); }
  }, 90_000);
}

async function world(engine: 'claude' | 'acp', forceRecovery: 'none' | 'readiness' | 'checking' = 'none', holdCapture = false) {
  const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const fixture: VerificationServer = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      const result=next(url,context);let source=String(result.source);
      if (${JSON.stringify(holdCapture)} && url.endsWith('/server/memory/worker-controller.ts')) {
        const needle='claimMemoryJob(this.owner)';
        if(!source.includes(needle))throw new Error('capture claim boundary moved');
        source=source.replaceAll(needle,'null');
      }
      // The live turn's terminal capture claims the same reply job; hold it too so the capture stays owed until the next ingress.
      if (${JSON.stringify(holdCapture)} && url.endsWith('/server/memory/terminal.ts')) {
        const needle='claimMemoryJob(claim.generation, Date.now(), undefined, { jobId: String(job.id), busyMs: 0 })';
        if(!source.includes(needle))throw new Error('terminal capture claim boundary moved');
        source=source.replaceAll(needle,'null');
      }
      // MAIN RULING 1115-RECALL-R6 (GrokBuild)
      // Persist a real unavailable-view condition throughout this message's
      // recovery probes; the next owner message releases the fixture fault.
      if (${JSON.stringify(forceRecovery !== 'none')} && url.endsWith('/server/index.ts')) {
        const needle='let earlyBundle: EarlyBundle<';
        source=source.replace(needle,\`if (globalThis.fixtureRecoveryMessage!==userMessage.id) {
          globalThis.fixtureRecoveryMessage=userMessage.id;
          globalThis.fixtureRecallHeld=/Owner turn (3|6|9):/.test(text);
          if(globalThis.fixtureRecallHeld)console.warn('fixture forced recall ${forceRecovery}');
        }\`+needle);
      }
      if (${JSON.stringify(forceRecovery !== 'none')} && url.endsWith('/server/memory/recall-view.ts')) {
        source=source.replace('export function assertRecallView(db: DatabaseSync, view: RecallViewHandle, binding?: RecallViewBinding): number {',
          'export function assertRecallView(db: DatabaseSync, view: RecallViewHandle, binding?: RecallViewBinding): number { if(globalThis.fixtureRecallHeld)db.prepare("DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?").run(view.viewId,view.generation);');
      }
      return {...result,source};
    }});
    await import(${url('server/testing/fake-engine-env-preload.mjs')});
    // Deterministic idle host: normal capture must not wait on unrelated CI-machine load.
    await import(${url('server/testing/idle-load-preload.mjs')});
    process.env.MURAGE_TURN_TRACE='1';
    const fs=await import('node:fs'),path=await import('node:path');
    const {fileURLToPath}=await import('node:url');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
    if (${JSON.stringify(engine)}==='acp') config.instances.verification={driver:'grokAgent',config:{cli:fileURLToPath(${url('server/testing/fake-acp-cli.ts')})},environment:{
      FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',
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
  // MAIN RULING 1115-RECALL-DESIGN-GROK: observe the actual current session even on a held turn, which writes no frame receipt.
  const session = (thread: string) => read(db => String(db.prepare("SELECT native_session FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1").get(thread)?.native_session ?? ''));
  const bot = async () => {
    const { bot } = await api('POST', '/api/bots', { name: 'Warm fixture' });
    await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false });
    return bot as { id: string; threadId: string };
  };
  // Capture is setup for revocation controls, not an admission barrier between ordinary turns.
  const capture = async (bot: { threadId: string }) => {
    await expect.poll(() => read(db => Number(db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(bot.threadId)!.n)), { timeout: 30_000 }).toBe(0);
    // Derive the expected sources from the conversation, so absent jobs cannot pass.
    const messages: Message[] = (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    const expected = messages.filter(m => !isMurageVoice(m) && m.kind === 'text' && (
      m.role === 'user' && !m.queued || m.role === 'bot' && (m.turnTerminal || !m.turnId)
    ));
    expect(expected.some(m => m.role === 'user')).toBe(true);
    expect(expected.some(m => m.role === 'bot')).toBe(true);
    // Historical working revisions may be cancelled; each expected current capture must succeed.
    expect(read(db => expected.map(m => db.prepare(
      "SELECT j.status FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' WHERE s.id=? AND s.thread_id=?"
    ).get(`message:${bot.threadId}:${m.id}`, bot.threadId)?.status))).toEqual(expected.map(() => 'complete'));
  };
  // MAIN RULING 1114-RECALL-S1-TYPED-AVAILABILITY: drive warm-keep's original owner send/capture sequence; recall readiness can remain held.
  const acceptedTurn = async (bot: { id: string; threadId: string }, text: string, capture: 'expected' | 'excluded' = 'expected') => {
    // As in the real memory fixtures, begin outside the five-second admission closing guard.
    const remaining = 60_000 - Date.now() % 60_000;
    if (remaining <= 10_000) await new Promise(resolve => setTimeout(resolve, remaining + 1));
    const replies = async () => (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages.filter((m: any) => m.role === 'bot' && m.kind === 'text' && m.text).length;
    const before = await replies(), logStart = log().length;
    const accepted = await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    expect(accepted.message?.id, 'the owner send returns its exact message identity').toBeTruthy();
    await expect.poll(replies, { timeout: 45_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15_000 }).not.toBe(true);
    expect(log().slice(logStart)).not.toContain('starting turn without recalled memory');
    // MAIN RULING 1115-WARM-MATRIX: a forget may erase old rows, so a total
    // count is not a capture witness. Require this accepted owner's actual source.
    const source = () => read(db => Boolean(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? AND message_id=? AND kind='text' AND speaker='owner'").get(bot.threadId, accepted.message.id)));
    if (capture === 'excluded') expect(source()).toBe(false);
    else await expect.poll(source, { timeout: 225_000, interval: 250 }).toBe(true);
  };
  const pendingReply = (thread: string) => read(db => db.prepare("SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND s.message_id=(SELECT id FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND text!='' ORDER BY rowid DESC LIMIT 1) AND j.status IN ('pending','leased')").get(thread, thread)?.id);
  const waitCapture = async (thread: string, timeout = 225_000) => {
    // MAIN RULING 1115-WARM-MATRIX: require every actual current-revision capture
    // to succeed. A settled turn supersedes its born-cancelled working revision.
    await expect.poll(() => read(db => db.prepare("SELECT j.status FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND j.stage='capture'").all(thread).map(row => String(row.status))), { timeout, interval: 250 }).toSatisfy((statuses: string[]) => statuses.length > 0 && statuses.every(status => status === 'complete'));
  };
  const turn = async (bot: { id: string; threadId: string }, text: string, capturedSetup = true) => {
    await acceptedTurn(bot, text);
    if (capturedSetup) await capture(bot);
  };
  const rpc = (): any[] => { const file = join(fixture.info.dataDir, 'warm-rpc.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
  return { fixture, login, api, read, write, log, session, bot, turn, acceptedTurn, capture, rpc, pendingReply, waitCapture };
}
