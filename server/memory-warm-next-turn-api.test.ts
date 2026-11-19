// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture admission and next-turn fixture owner: warm-capture.
// Continuation owner: warm-keep. Recall admission/recovery owner: live recall lane.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, onTestFailed } from 'vitest';
import type { VerificationServer } from '../scripts/control-murage.ts';
import { launchMemoryVerificationServer } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';

// Negative witnesses ensure a valid earlier session cannot mask a later context loss.
const persona = 'Keep the fixture garden notebook.';
const wireText = (value: any): string => typeof value === 'string' ? value : value && typeof value === 'object' ? Object.values(value).map(wireText).join('\n') : '';
function assertAcpContext(calls: any[], text: string, prior: string[], held: string[] = []) {
  const index = calls.findLastIndex(row => row.method === 'session/prompt');
  const prompt = calls[index]?.params;
  expect(wireText(prompt)).toContain(text);
  // Only the setup actually governing this prompt may supply integrations.
  const setup = calls.slice(0, index).findLast(row => ['session/new', 'session/load'].includes(row.method));
  expect(setup?.params?.mcpServers?.some((server: any) => server.name === 'agents')).toBe(true);
  if (setup?.method === 'session/load') expect(setup.params.sessionId).toBe(prompt?.sessionId);
  expect(wireText(prompt)).toContain(persona);
  for (const line of prior) expect([...held, wireText(prompt)].join('\n'), 'authorized prior transcript reaches this vendor session').toContain(line);
}
function assertClaudeContext(dump: any, text: string, prior: string[], held: string[] = []) {
  expect(dump.systemPrompt).toContain(persona);
  expect(dump.mcpConfig?.mcpServers?.agents).toBeTruthy();
  expect(wireText(dump.prompt)).toContain(text);
  for (const line of prior) expect([...held, wireText(dump.prompt)].join('\n'), 'authorized prior transcript reaches this vendor session').toContain(line);
}
for (const missing of ['persona', 'agents', 'history'] as const) {
  it(`ACP context witness rejects current ${missing} loss despite valid older calls`, () => {
    const calls = [
      {method:'session/new',params:{mcpServers:[{name:'agents'}]}},
      {method:'session/prompt',params:{sessionId:'old',prompt:[{text:persona+' earlier owner earlier reply'}]}},
      {method:'session/new',params:{mcpServers:missing==='agents'?[]:[{name:'agents'}]}},
      {method:'session/prompt',params:{sessionId:'new',prompt:[{text:(missing==='persona'?'':persona)+(missing==='history'?'':' earlier owner earlier reply')+' current owner'}]}}
    ];
    expect(() => assertAcpContext(calls, 'current owner', ['earlier owner','earlier reply'])).toThrow();
  });
}
it('Claude context witness rejects a current prompt missing prior transcript', () => {
  expect(() => assertClaudeContext({systemPrompt:persona,mcpConfig:{mcpServers:{agents:{}}},prompt:'current owner'},'current owner',['earlier owner','earlier reply'])).toThrow();
});

it('a real foreground turn still refuses capture publication when its BG byte pool is reserved', async () => {
  const w = await world('claude');
  try {
    const bot = await w.bot();
    await w.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_hold_authority__ admission control' });
    await expect.poll(() => existsSync(w.fixture.fixtureDumpPath), { timeout: 45_000 }).toBe(true);
    expect((await w.api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy).toBe(true);
    writeFileSync(join(w.fixture.info.dataDir, 'capture-admission-probe'), 'request');
    const resultFile = join(w.fixture.info.dataDir, 'capture-admission-result');
    await expect.poll(() => existsSync(resultFile), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({ active: true, reserved: true, refused: true, nativeRefused: true, unchanged: true });
  } finally { await w.fixture.close(); }
}, 90_000);

it('owed capture completes after foreground credit expires with no further owner activity', async () => {
  const w = await world('claude');
  try {
    const bot = await w.bot();
    await w.turn(bot, 'The fixture garden gate is green.');
    const replyAt = performance.now(), jobs = w.openJobs(bot.threadId);
    expect(jobs.length).toBeGreaterThan(0);
    // Observe the real watchdog expiry. Do not manufacture foreground activity,
    // reset the ledger, force a job complete or enlarge any byte ceiling.
    await expect.poll(() => w.idle(), { timeout: 75_000, interval: 250 }).toBe(true);
    const released = performance.now(); w.release();
    console.log('CAPTURE_IDLE released after real foreground expiry');
    await expect.poll(() => w.read(db => jobs.every(id => db.prepare('SELECT status FROM memory_jobs WHERE id=?').get(id)?.status === 'complete')), { timeout: 150_000, interval: 250 }).toBe(true);
    console.log(`CAPTURE_IDLE completed_s=${((performance.now() - released) / 1000).toFixed(3)} bound_s=150 after_reply_s=${((performance.now() - replyAt) / 1000).toFixed(3)}`);
    await expect.poll(() => w.read(db => Number(db.prepare("SELECT count(*) n FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version JOIN memory_jobs j ON j.source_id=e.source_id AND j.source_revision=e.source_revision WHERE r.kind='checkpoint' AND r.state='active' AND j.id IN (" + jobs.map(() => '?').join(',') + ")").get(...jobs)!.n)), { timeout: 75_000, interval: 250 }).toBeGreaterThan(0);
    console.log(`CHECKPOINT_IDLE refreshed_s=${((performance.now() - released) / 1000).toFixed(3)} after_idle_bound_s=225`);
  } finally { await w.fixture.close(); }
}, 315_000);

// A real queued capture is held at the controller claim boundary. Foreground
// catch-up, session proof, native grants and publication all remain production code.
for (const engine of ['claude', 'acp'] as const) {
  for (const restart of [false, true]) {
    it(`${engine}: ten next owner turns arrive with capture pending (${restart ? 'restart' : 'ordinary'})`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        let beforeRestart: string | undefined, rpcBeforeRestart = 0;
        if (restart) {
          await w.turn(bot, 'Before restarting the fixture.');
          beforeRestart = w.session(bot.threadId); rpcBeforeRestart = w.rpc().length;
          expect(beforeRestart).toBeTruthy();
          await w.fixture.restart(); await w.login();
        }
        const start = w.log().length, ids: string[] = [];
        let rpcAfterFirst = 0, previousReplyJob: string | undefined;
        for (let n = 0; n < 10; n++) {
          const pending = n ? w.openJobs(bot.threadId) : [];
          if (n) {
            expect(pending, `turn ${n + 1} enters with the previous reply's capture owed`).toContain(previousReplyJob);
            expect(w.read(db => db.prepare('SELECT status FROM memory_jobs WHERE id=?').get(previousReplyJob!)?.status)).toMatch(/^(pending|leased)$/);
          }
          await w.turn(bot, `Owner turn ${n + 1}: the fixture garden gate is green.`);
          previousReplyJob = w.read(db => String(db.prepare("SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND s.message_id=(SELECT id FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND text!='' ORDER BY rowid DESC LIMIT 1)").get(bot.threadId, bot.threadId)?.id ?? ''));
          expect(previousReplyJob, 'the terminal reply has a real capture job').toBeTruthy();
          ids.push(w.session(bot.threadId));
          if (!n) rpcAfterFirst = w.rpc().length;
        }
        expect(ids.every(Boolean)).toBe(true);
        expect(new Set(ids).size).toBe(1);
        if (restart) expect(ids[0], 'the first post-restart turn resumes the pre-restart vendor session').toBe(beforeRestart);
        const log = w.log().slice(start);
        expect(log).not.toContain('memory continuation reset');
        expect(log).not.toContain('starting turn without recalled memory');
        if (engine === 'claude') {
          const timings = log.split('\n').filter(line => line.includes(`claude first-token thread=${bot.threadId} `));
          expect(timings).toHaveLength(10);
          for (const line of timings.slice(restart ? 0 : 1)) expect(line).toMatch(/process=reused|resumed=true/);
        } else {
          expect(w.rpc().slice(restart ? rpcBeforeRestart : rpcAfterFirst).filter(row => row.method === 'session/new')).toHaveLength(0);
        }
        console.log(`WARM_NEXT ${engine} restart=${restart} reused=${restart ? '10/10' : '9/9'} pending=9/9`);
      } finally { await w.fixture.close(); }
    }, 240_000);
  }
}

for (const engine of ['claude', 'acp'] as const) {
  for (const change of ['forget', 'edit', 'access', 'roster', 'deny'] as const) {
    it(`${engine}: a real ${change} resets a retained session`, async () => {
      const w = await world(engine);
      try {
        const bot = await w.bot();
        await w.capturedTurn(bot, 'The fixture garden gate is green.');
        const established = w.session(bot.threadId);
        expect(established).toBeTruthy();
        await w.capturedTurn(bot, 'The fixture shed is blue.');
        const before = w.session(bot.threadId), start = w.log().length;
        expect(before).toBe(established);
        const source = w.read(db => {
          const row = db.prepare("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY rowid DESC LIMIT 1").get(bot.threadId)!;
          return (JSON.parse(String(row.source_versions)) as Array<{ id: string }>)[0]?.id;
        });
        let requiredAfterChange: string[] | undefined;
        if (change === 'forget') {
          expect(source).toBeTruthy();
          const forgotten = w.read(db => String(db.prepare("SELECT json_extract(v.payload,'$.text') AS text FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?").get(source)?.text ?? ''));
          requiredAfterChange = ['The fixture garden gate is green.', 'The fixture shed is blue.'].filter(text => text !== forgotten);
          expect(requiredAfterChange.length, 'the independent owner statement remains required').toBeGreaterThan(0);
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
        // MAIN RULING SEAN 1114-ENGINE-STAYS-WARM: observe the next turn's reset at a real authority change.
        // Require the independent statement after a forget of the actually cited
        // source. Every other control keeps the full prior-owner oracle.
        await w.turn(bot, 'Continue after the owner change.', change !== 'access', requiredAfterChange);
        expect(w.session(bot.threadId)).not.toBe(before);
        expect(w.log().slice(start)).toContain('memory continuation reset');
        expect(w.log().slice(start).split('\n').filter(line => line.includes(`memory continuation reset thread=${bot.threadId} `))).toHaveLength(1);
      } finally { await w.fixture.close(); }
    // MAIN RULING 1115-WARM-MATRIX: two successful capture setups plus the immediate control.
    }, 600_000);
  }
}


async function world(engine: 'claude' | 'acp') {
  const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const fixture: VerificationServer = await launchMemoryVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
    await import(${url('server/testing/fake-engine-env-preload.mjs')});
    // Deterministic idle host: normal capture must not wait on unrelated CI-machine load.
    await import(${url('server/testing/idle-load-preload.mjs')});
    process.env.MURAGE_TURN_TRACE='1';
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      const loaded=next(url,context);
      if(url.endsWith('/server/memory/disclosures.ts')){
        const source=String(loaded.source),anchor='if (!row || revoked(LineageAllowance.tool(), row, access)) throw new Error("MEMORY_CONTEXT_REVOKED");';
        if(!source.includes(anchor))throw new Error('disclosure diagnostic boundary moved');
        return {...loaded,source:source.replace(anchor,'if (!row || revoked(LineageAllowance.tool(), row, access)) { console.warn("capture-disclosure-refusal",row?revokedReason(LineageAllowance.tool(),row,access):"missing-receipt"); throw new Error("MEMORY_CONTEXT_REVOKED"); }')};
      }
      if(url.endsWith('/server/memory/dispatch.ts')){
        const source=String(loaded.source),anchor='throw sessionCheckRefusal(why);';
        return {...loaded,source:source.replace(anchor,'{console.warn("capture-session-refusal",JSON.stringify(why));throw sessionCheckRefusal(why);} ')};
      }
      if(url.endsWith('/server/memory/terminal.ts')){
        // The live turn's terminal capture claims the same reply job: the gate holds it until the next ingress as well.
        const terminal=String(loaded.source),terminalClaim='claimMemoryJob(claim.generation, Date.now(), undefined, { jobId: String(job.id), busyMs: 0 })';
        if(!terminal.includes(terminalClaim))throw new Error('terminal capture claim fixture boundary moved');
        return {...loaded,source:'import {existsSync as terminalGateExists} from "node:fs";\\n'+terminal.replaceAll(terminalClaim,'(terminalGateExists(process.env.MURAGE_DATA_DIR+"/capture-held")?null:'+terminalClaim+')')};
      }
      if(!url.endsWith('/server/memory/worker-controller.ts'))return loaded;
      let source=String(loaded.source);
      const claim='claimMemoryJob(this.owner)';
      if(!source.includes(claim))throw new Error('capture claim fixture boundary moved');
      source='import {existsSync as captureGateExists} from "node:fs";\\n'+source.replaceAll(claim, '(captureGateExists(process.env.MURAGE_DATA_DIR+"/capture-held")?null:claimMemoryJob(this.owner))');
      return {...loaded,source};
    }});
    const {ioBudget}=await import(${url('server/io-budget.ts')});
    const {database:fixtureDatabase}=await import(${url('server/database.ts')});
    const fsIdle=await import('node:fs');
    fsIdle.writeFileSync(process.env.MURAGE_DATA_DIR+'/capture-held','held');
    let lastIdle;
    setInterval(()=>{
      const idle=Reflect.get(ioBudget,'isIdle')()&&!Reflect.get(ioBudget,'foregroundActivity');
      if(idle!==lastIdle){lastIdle=idle;fsIdle.writeFileSync(process.env.MURAGE_DATA_DIR+'/capture-idle',String(idle));}
      const request=process.env.MURAGE_DATA_DIR+'/capture-admission-probe';
      if(fsIdle.existsSync(request)&&Date.now()%60000<54000){
        fsIdle.unlinkSync(request);
        const before=ioBudget.admissionState(),room=ioBudget.backgroundRoom();
        const pool=ioBudget.admit('BG',room);
        const commit=ioBudget.withSource('memory-capture',()=>ioBudget.admit('BG',61440,61440));
        let nativeRefused=false;
        try{ioBudget.withSource('memory-capture',()=>fixtureDatabase().prepare('UPDATE memory_jobs SET retry_at=retry_at WHERE rowid=(SELECT min(rowid) FROM memory_jobs)').run());}
        catch(error){if(error?.message!=='BG_DEFERRED')throw error;nativeRefused=true;}
        if(commit)ioBudget.settle(commit,0);if(pool)ioBudget.settle(pool,0);
        const after=ioBudget.admissionState();
        fsIdle.writeFileSync(process.env.MURAGE_DATA_DIR+'/capture-admission-result',JSON.stringify({
          active:!idle,reserved:pool!==null,refused:commit===null,nativeRefused,
          unchanged:before.bg===after.bg&&before.debt===after.debt&&before.reserved===after.reserved}));
      }
    },250).unref();

    const fs=await import('node:fs'),path=await import('node:path');
    const {fileURLToPath}=await import('node:url');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
    if (${JSON.stringify(engine)}==='acp') config.instances.verification={driver:'grokAgent',config:{cli:fileURLToPath(${url('server/testing/fake-acp-cli.ts')})},environment:{
      FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',
      FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'warm-rpc.jsonl')}};
    config.instances.verification.environment={...config.instances.verification.environment,FAKE_CLAUDE_DUMP_EACH_TURN:'1'};
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
    await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, persona: 'Keep the fixture garden notebook.' });
    return bot as { id: string; threadId: string };
  };
  const deliveredContext = new Map<string, string[]>();
  const ownerHistory = new Map<string, string[]>();
  const turn = async (bot: { id: string; threadId: string }, text: string, captureExpected = true, requiredHistory?: string[]) => {
    const replies = async () => (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages.filter((m: any) => m.role === 'bot' && m.kind === 'text' && m.text).length;
    const before = await replies(), logStart = log().length;
    // These accepted owner inputs must survive in the retained vendor context
    // or in the authorized replay after a reset. The fixture's initial greeting
    // is not a provider reply and cannot stand in for prior owner history.
    const prior = ownerHistory.get(bot.threadId) ?? [];
    const accepted = await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    expect(accepted.message?.id, 'the owner send returns its exact message identity').toBeTruthy();
    await expect.poll(replies, { timeout: 45_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 15_000 }).not.toBe(true);
    expect(log().slice(logStart)).not.toContain('starting turn without recalled memory');
    const nativeSession = session(bot.threadId), held = deliveredContext.get(nativeSession) ?? [];
    const required = requiredHistory ?? prior;
    if (engine === 'claude') {
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, 'utf8'));
      assertClaudeContext(dump, text, required, held);
      held.push(wireText(dump.prompt));
    } else {
      const calls = rpc();
      assertAcpContext(calls, text, required, held);
      held.push(wireText(calls.filter(row => row.method === 'session/prompt').at(-1)?.params));
    }
    deliveredContext.set(nativeSession, held);
    ownerHistory.set(bot.threadId, [...prior, text]);
    // MAIN RULING 1115-WARM-MATRIX: require this send's source, independently
    // of old source rows being erased by the owner's forget.
    const source = () => read(db => Boolean(db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? AND message_id=? AND kind='text' AND speaker='owner'").get(bot.threadId, accepted.message.id)));
    if (captureExpected) await expect.poll(source, { timeout: 225_000, interval: 250 }).toBe(true);
    else expect(source(), 'withdrawn thread produces no source for this new message').toBe(false);
    expect(await replies()).toBe(before + 1);

  };
  const rpc = (): any[] => { const file = join(fixture.info.dataDir, 'warm-rpc.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; };
  const openJobs = (thread: string): string[] => read(db => db.prepare("SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status IN ('pending','partial','deferred','leased')").all(thread).map(row => String(row.id)));
  const idle = () => { const file = join(fixture.info.dataDir, 'capture-idle'); return existsSync(file) && readFileSync(file, 'utf8') === 'true'; };
  const release = () => { const file = join(fixture.info.dataDir, 'capture-held'); if (existsSync(file)) unlinkSync(file); };
  const capturedTurn = async (bot: { id: string; threadId: string }, text: string) => {
    release(); await turn(bot, text);
    await expect.poll(() => openJobs(bot.threadId).length, { timeout: 150_000, interval: 250 }).toBe(0);
    expect(read(db => Number(db.prepare("SELECT count(*) n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status='failed'").get(bot.threadId)!.n))).toBe(0);
  };
  return { fixture, login, api, read, write, log, session, bot, turn, rpc, openJobs, idle, release, capturedTurn };
}
