// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S2 tests use a deliberately small C4 stub: S1 owns the deletion proof.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import * as schema from './memory/schema.ts';
import { routeAdmits, routeClass, cloudRouteDecision } from './route-policy.ts';
import type { CursorClear } from './memory/keepall-unwedge.ts';
import { denyLookup } from './memory/deny-read.ts';

// The base has no handler. RED is an absent-route assertion, never a module resolution failure.
const ownerPath = './memory/gh18-fresh-start-owner.ts';
const module: any = await import(ownerPath).catch(() => ({}));
const absent = { request: async () => ({ status: 404, body: { error: 'no such route' } }), recover: () => {}, barrier: async () => {} };
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
function fixture() {
  const db = new DatabaseSync(':memory:'); closes.push(() => db.close());
  db.exec(`CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, installation_id TEXT, policy_revision INTEGER, deletion_epoch INTEGER, data_revision INTEGER);
    INSERT INTO memory_meta VALUES(1,'install',0,0,0);
    CREATE TABLE memory_deny_session(thread_id TEXT,driver_instance TEXT,native_session TEXT,revoke_id INTEGER);
    CREATE TABLE memory_revoke_audience(revoke_id INTEGER);
    INSERT INTO memory_revoke_audience VALUES(1);
    INSERT INTO memory_deny_session VALUES('thread','engine','old',1),('thread','engine','protected',2);`);
  (schema as any).ensureGH18Operations?.(db);
  let bot: any = { id: 'bot', name: 'Fixture', tasks: [{ threadId: 'thread', busy: false, resumeCursors: { engine: 'old' }, resumeIncarnations: { engine: 1 } }] };
  let now = 1000, failFlush = false, crashBeforeClear = false, allowed = true;
  let disk = JSON.stringify(bot), deletes = 0, flushes = 0;
  const live = new Set<string>();
  const policy = {
    planFreshStart: () => ({ botId: bot.id, sessionRows: db.prepare("SELECT thread_id AS threadId,driver_instance AS driverInstance,native_session AS nativeSession FROM memory_deny_session WHERE revoke_id=1").all(), cursorClears: Object.entries(bot.tasks[0].resumeCursors).filter(([,cursor]) => cursor != null).map(([instanceId,cursor]) => ({ botId: bot.id, threadId: 'thread', instanceId, cursor, incarnation: 1 })), retainedBlocks: 1, retainedCapped: false, blocked: null }),
    applyFreshStartRows: () => { deletes++; return Number(db.prepare('DELETE FROM memory_deny_session WHERE revoke_id=1').run().changes); },
  };
  const deps: any = { db: () => db, bot: (id: string) => id === bot.id ? bot : undefined, now: () => now,
    policy, schemaCompatible: () => true, storeRevision: () => 0, botBusy: () => bot.busy === true, liveThreads: () => live, ownerDirectThread: () => true, pendingDeletion: () => false,
    clearCursors: (clears: CursorClear[]) => { if (crashBeforeClear) throw new Error('crash after commit'); for (const c of clears) if (bot.tasks[0].resumeCursors[c.instanceId] === c.cursor && bot.tasks[0].resumeIncarnations[c.instanceId] === c.incarnation) delete bot.tasks[0].resumeCursors[c.instanceId]; },
    flush: () => { flushes++; if (failFlush) throw new Error('disk full'); disk = JSON.stringify(bot); },
  };
  const caller = () => allowed ? { owner: 'owner', session: 'session' } : null;
  let service = module.createFreshStartOwner?.(deps) ?? absent;
  const request = (action: string, body?: unknown, auth = caller) => service.request({ botId: 'bot', action, body, authenticate: auth });
  return { db, deps, request, caller, get service() { return service; }, get bot() { return bot; }, get disk() { return JSON.parse(disk); }, live,
    expire: () => { now += 121000; }, failFlush: () => { failFlush = true; }, healFlush: () => { failFlush = false; }, crash: () => { crashBeforeClear = true; }, revoke: () => { allowed = false; },
    restart: () => { bot = JSON.parse(disk); failFlush = false; crashBeforeClear = false; service = module.createFreshStartOwner?.(deps) ?? absent; },
    counts: () => ({ marks: db.prepare('SELECT * FROM memory_deny_session').all(), audits: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='gh18_operations'").get()?.n ? db.prepare('SELECT * FROM gh18_operations').all() : [], deletes, flushes, cursor: bot.tasks[0].resumeCursors.engine }),
  };
}
async function preview(f: ReturnType<typeof fixture>) {
  const result = await f.request('preview', {}); expect(result.status).toBe(200); expect(result.body.state).toBe('ready');
  return { previewToken: result.body.previewToken, confirm: true, idempotencyKey: 'idempotency-key-0001' };
}
async function done(f: ReturnType<typeof fixture>) {
  const body = await preview(f); const result = await f.request('confirm', body);
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: 'done', clearedBlocks: 1, freshSessions: 1, visibilityChanged: false });
  expect(f.counts().audits).toHaveLength(1); expect(f.counts().marks).toHaveLength(1); expect(f.counts().cursor).toBeUndefined();
  return { body, result };
}

it.each(['ask', 'allow', 'no-limits'])('gh18_owner_confirm_required_in_every_approval_mode (%s)', async mode => {
  const f = fixture(); f.bot.autoApprove = mode !== 'ask'; f.bot.noLimits = mode === 'no-limits'; const body = await preview(f);
  for (const bad of [{ ...body, confirm: false }, { previewToken: body.previewToken, idempotencyKey: body.idempotencyKey }, { ...body, owner: 'owner' }]) expect((await f.request('confirm', bad)).status).toBe(400);
  expect(f.counts().marks).toHaveLength(2); expect(f.counts().audits).toHaveLength(0);
});
it('gh18_internal_phone_and_nonowner_denied', async () => {
  const f = fixture();
  expect((await f.request('preview', {}, () => null)).status).toBe(403);
  const path = '/api/memory/bots/bot/fresh-start/confirm';
  for (const caller of [{desktop:false,companion:true,door:false,bot:false},{desktop:false,companion:false,door:false,bot:true},{desktop:false,companion:false,door:false,bot:false}]) expect(routeAdmits(routeClass('POST',path),caller)).toBe(false);
  expect(cloudRouteDecision('POST', path, 'owner-desktop', {})).toBe('step-up required');
  expect(cloudRouteDecision('POST', path, 'owner-desktop', {}, true)).toBe('allow');
  expect(cloudRouteDecision('POST', path, 'service', {}, true)).toBe('deny');
  expect(f.counts().audits).toHaveLength(0);
});
it('gh18_stale_preview_409', async () => {
  const f = fixture(); const body = await preview(f); f.bot.name = 'Renamed';
  expect(await f.request('confirm', body)).toMatchObject({status:409}); expect(f.counts().marks).toHaveLength(2); expect(f.counts().audits).toHaveLength(0);
});
it('gh18_busy_bot_blocks', async () => {
  const f = fixture(); const body = await preview(f); f.live.add('thread');
  const result = await f.request('confirm', body); expect(result).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',clearedBlocks:0,freshSessions:0}});
  expect(f.counts().marks).toHaveLength(2); expect(f.counts().cursor).toBe('old'); expect(f.counts().audits).toHaveLength(1);
  f.live.clear(); expect(await f.request('confirm', body)).toEqual(result); expect(f.counts().deletes).toBe(0);
});
it('gh18_audit_failure_rolls_back', async () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON gh18_operations BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  const body = await preview(f);
  expect((await f.request('confirm', body)).status).toBe(503); expect(f.counts().marks).toHaveLength(2); expect(f.counts().cursor).toBe('old'); expect(f.counts().audits).toHaveLength(0);
});
for (const condition of ['restart','token_expiry','token_consumed','snapshot_change']) it(`gh18_same_key_after_${condition}_returns_stored`, async () => {
  const f = fixture(); const {body,result} = await done(f);
  if (condition === 'restart') f.restart();
  if (condition === 'token_expiry') f.expire();
  if (condition === 'snapshot_change') { f.bot.name = 'Changed'; f.db.exec('UPDATE memory_meta SET data_revision=1'); f.live.add('thread'); }
  const before = f.counts(); expect(await f.request('confirm', body)).toEqual(result); expect(f.counts()).toEqual(before);
});
it('gh18_same_key_different_digest_409', async () => {
  const f = fixture(); const {body} = await done(f); const before = f.counts();
  expect(await f.request('confirm', {...body, previewToken: 'different'})).toMatchObject({status:409,body:{error:'idempotency-conflict'}}); expect(f.counts()).toEqual(before);
});
for (const phase of ['after_commit','before_flush','flush_failure']) it(`gh18_crash_${phase}_reapplies_cursors`, async () => {
  const f = fixture(); const body = await preview(f); if (phase === 'after_commit') f.crash(); else f.failFlush();
  expect((await f.request('confirm', body)).status).toBe(phase === 'after_commit' ? 503 : 202); expect(f.counts().audits).toHaveLength(1); expect(f.counts().audits[0].cursors_applied).toBe(0); expect(f.counts().marks).toHaveLength(1);
  f.restart(); await f.service.recover();
  expect(f.counts().cursor).toBeUndefined(); expect(f.counts().audits[0].cursors_applied).toBe(1);
  expect((await f.request('confirm', body)).body.state).toBe('done'); expect(f.counts().deletes).toBe(1);
});
it('gh18_opaque_cursor_survives_audit_roundtrip', async () => {
  const f=fixture(); f.bot.tasks[0].resumeCursors.engine={session:'opaque'};
  await done(f);
});
it('gh18_flush_failure_same_process_retry_finishes_without_second_delete', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush();
  expect((await f.request('confirm',body)).status).toBe(202);
  expect(f.counts().audits[0].cursors_applied).toBe(0); f.healFlush();
  expect((await f.request('confirm',body)).body.state).toBe('done');
  expect(f.counts().audits[0].cursors_applied).toBe(1); expect(f.counts().deletes).toBe(1);
});
// Ruling r2: pending cursor persistence is a durable, nonterminal outcome.
it('gh18_flush_failure_leaves_flag_zero_and_reports_applying', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush();
  const result=await f.request('confirm',body);
  expect(result).toMatchObject({status:202,body:{state:'applying',reason:'cursor-save-pending',clearedBlocks:1,freshSessions:1,visibilityChanged:false}});
  expect(result.body.operationId).toBeTruthy();
  const row=f.counts().audits[0]; expect(row.cursors_applied).toBe(0);
  expect(JSON.parse(String(row.outcome_json))).toEqual(result.body);
  expect(f.counts().cursor).toBeUndefined(); expect(f.disk.tasks[0].resumeCursors.engine).toBe('old');
  expect(await f.request(`operations/${result.body.operationId}`)).toEqual({status:200,body:result.body});
});
it('gh18_flush_failure_then_same_key_completes', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush();
  const pending=await f.request('confirm',body); f.expire(); f.healFlush();
  const complete=await f.request('confirm',body);
  expect(pending.status).toBe(202); expect(complete).toMatchObject({status:200,body:{state:'done',reason:null,operationId:pending.body.operationId,freshSessions:1}});
  expect(f.counts().audits).toHaveLength(1); expect(f.counts().deletes).toBe(1);
  expect(JSON.parse(String(f.counts().audits[0].outcome_json))).toEqual(complete.body);
});
it('gh18_flag_write_failure_then_status_read_completes', async () => {
  const f=fixture();
  f.db.exec("CREATE TRIGGER fail_flag BEFORE UPDATE ON gh18_operations WHEN NEW.cursors_applied=1 BEGIN SELECT RAISE(ABORT,'flag unavailable'); END");
  const body=await preview(f); const pending=await f.request('confirm',body);
  expect(pending).toMatchObject({status:202,body:{state:'applying',reason:'cursor-save-pending'}});
  expect(f.counts().audits[0].cursors_applied).toBe(0); expect(f.disk.tasks[0].resumeCursors.engine).toBeUndefined();
  f.db.exec('DROP TRIGGER fail_flag');
  expect(await f.request(`operations/${pending.body.operationId}`)).toMatchObject({status:200,body:{state:'done',freshSessions:1}});
  expect(f.counts().audits[0].cursors_applied).toBe(1); expect(f.counts().deletes).toBe(1);
});
it('gh18_reconcile_never_repeats_p1_delete', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush(); const pending=await f.request('confirm',body);
  f.db.exec("INSERT INTO memory_deny_session VALUES('thread','engine','later-roster-flip',1)");
  const before=f.counts().marks; f.restart(); f.service.recover();
  expect(f.counts().deletes).toBe(1); expect(f.counts().marks).toEqual(before);
  expect((await f.request(`operations/${pending.body.operationId}`)).body.state).toBe('done');
});
it('gh18_reconcile_skips_cursor_moved_by_later_turn', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush(); const pending=await f.request('confirm',body);
  f.restart(); f.bot.tasks[0].resumeCursors.engine='new'; f.bot.tasks[0].resumeIncarnations.engine=2;
  expect(await f.request(`operations/${pending.body.operationId}`)).toMatchObject({status:200,body:{state:'done',freshSessions:1}});
  expect(f.counts().cursor).toBe('new'); expect(f.disk.tasks[0].resumeCursors.engine).toBe('new');
});
it('gh18_reconcile_matches_cursor_by_json_not_identity', async () => {
  const f=fixture(); const cursor={session:'opaque',nested:{id:3}}; f.bot.tasks[0].resumeCursors.engine=cursor;
  f.deps.flush(); const body=await preview(f); f.failFlush(); const pending=await f.request('confirm',body);
  const recorded=JSON.parse(String(f.counts().audits[0].cursor_clears_json))[0];
  expect(recorded.cursorJson).toBe(JSON.stringify(cursor)); expect(recorded).not.toHaveProperty('cursor');
  f.restart(); expect(f.counts().cursor).toEqual(cursor); expect(f.counts().cursor).not.toBe(cursor);
  f.service.recover(); expect(f.counts().cursor).toBeUndefined();
  expect((await f.request(`operations/${pending.body.operationId}`)).body.freshSessions).toBe(1);
});
it('gh18_startup_reconcile_runs_before_listen', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush(); await f.request('confirm',body);
  f.restart(); f.service.recover();
  // No await: the next startup task sees cleared in-memory AND durable cursors.
  expect(f.counts().cursor).toBeUndefined(); expect(f.disk.tasks[0].resumeCursors.engine).toBeUndefined();
  expect(f.counts().audits[0].cursors_applied).toBe(1);
});
it('gh18_startup_flush_failure_keeps_applying_and_continues_other_operations', async () => {
  const f=fixture(); const body=await preview(f); f.failFlush(); const pending=await f.request('confirm',body);
  f.bot.tasks[0].resumeCursors.engine='old';
  const second={...await preview(f),idempotencyKey:'second-pending-operation'};
  await f.request('confirm',second);
  f.restart(); f.failFlush(); const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    f.service.recover();
    expect(f.counts().cursor).toBeUndefined(); expect(f.counts().audits[0].cursors_applied).toBe(0);
    expect(warn).toHaveBeenCalledWith(`[memory] gh18 fresh-start reconcile: cursor save pending op=${pending.body.operationId}`);
    expect(warn).toHaveBeenCalledTimes(2); expect(f.counts().audits).toHaveLength(2);
    expect(f.counts().audits.every(row=>row.cursors_applied===0)).toBe(true);
  } finally { warn.mockRestore(); }
});
it('gh18_busy_then_idle_same_key_returns_stored_blocked', async () => {
  const f=fixture(); const body=await preview(f); f.live.add('thread');
  const blocked=await f.request('confirm',body); f.live.clear(); f.expire();
  expect(await f.request('confirm',body)).toEqual(blocked);
  expect(blocked).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy'}});
  expect(blocked.body.operationId).toBeTruthy(); expect(f.counts().audits).toHaveLength(1);
  expect(f.counts().deletes).toBe(0); expect(f.counts().cursor).toBe('old');
});
it('gh18_busy_then_idle_new_key_runs', async () => {
  const f=fixture(); const body=await preview(f); f.live.add('thread');
  const blocked=await f.request('confirm',body); f.live.clear();
  const next={...await preview(f),idempotencyKey:'idempotency-key-0002'};
  expect(await f.request('confirm',next)).toMatchObject({status:200,body:{state:'done'}});
  expect(f.counts().audits).toHaveLength(2); expect(f.counts().deletes).toBe(1);
  expect(await f.request('confirm',body)).toEqual(blocked);
});

it('gh18_stored_outcome_unknown_content_fails_closed', async () => {
  const f=fixture(); const {result}=await done(f);
  f.db.prepare('UPDATE gh18_operations SET outcome_json=?').run(JSON.stringify({...result.body,text:'never return stored content'}));
  const response=await f.request(`operations/${result.body.operationId}`);
  expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain('never return stored content');
});
it('gh18_status_reconciles_pending_and_never_clears_a_new_cursor', async () => {
  const f = fixture(); const body = await preview(f); f.crash(); await f.request('confirm',body);
  f.restart(); f.bot.tasks[0].resumeCursors.engine = 'new';
  const id = f.counts().audits[0].operation_id;
  expect((await f.request(`operations/${id}`)).body.state).toBe('done'); expect(f.counts().cursor).toBe('new');
  f.revoke(); expect((await f.request(`operations/${id}`)).status).toBe(403);
});
it('gh18_preview_never_writes_and_tokens_are_session_bound', async () => {
  const f = fixture(); const before = f.db.prepare('SELECT total_changes() AS n').get(); const body = await preview(f);
  expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect((await f.request('confirm',body,() => ({owner:'owner',session:'other'}))).status).toBe(409);
});
it('gh18_confirm_holds_bot_admission_through_flush', async () => {
  const f = fixture(); let release!: () => void;
  f.deps.flush = vi.fn(() => { expect(f.service.pending('bot')).toBe(true); });
  const body = await preview(f);
  f.deps.writerGate = () => new Promise<void>(resolve => { release = resolve; });
  const confirm = f.request('confirm',body); await Promise.resolve();
  let admitted = false; const turn = f.service.barrier('bot').then(() => { admitted = true; });
  await Promise.resolve(); expect(admitted).toBe(false); release(); await confirm; await turn; expect(admitted).toBe(true);
});

it('gh18_incompatible_downgrade_keeps_production_action_disabled', async () => {
  const f = fixture(); f.deps.schemaCompatible = () => false;
  f.db.exec('DROP TABLE gh18_operations');
  const preview = await f.request('preview',{});
  expect(preview).toMatchObject({status:200,body:{state:'blocked',reason:'unsupported-schema'}});
  expect((await f.request('confirm',{previewToken:preview.body.previewToken,confirm:true,idempotencyKey:'schema-block-key-0001'})).status).toBe(503);
  expect(f.counts().marks).toHaveLength(2); expect(f.counts().cursor).toBe('old'); expect(f.counts().audits).toHaveLength(0);
  expect(schema.GH18_SCHEMA_DOWNGRADE_COMPATIBLE).toBe(true); // Actual frozen-validator gate below admits production; the injected incompatible case still refuses.
});

it('gh18_downgrade_1018_opens_db_marks_intact', () => {
  // 1.0.18 rcSTAGE4 (47af6a1da2fdf4280cdc27b47304fe3f3415ea63) and the pinned base
  // share schema.ts blob 23f5cc9c83ba009661c32c867b3503492f39d9ae and its strict allowlist.
  // This mandatory gate caught the original memory_* table-name conflict.
  // Keep its unknown-memory-object assertion; the app-metadata namespace must
  // also pass the actual released validator in memory-gh18-compatibility.test.ts.
  const db = new DatabaseSync(':memory:'); closes.push(() => db.close()); schema.migrateMemorySchema(db);
  const oldObjects = db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_%' OR tbl_name LIKE 'memory_%'").all().map(r => r.name);
  expect(typeof (schema as any).ensureGH18Operations).toBe('function'); (schema as any).ensureGH18Operations(db);
  db.exec("INSERT INTO memory_deny_session VALUES('thread','engine','protected',77)");
  const extras = db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_%' OR tbl_name LIKE 'memory_%'").all().map(r => r.name).filter(name => !oldObjects.includes(name));
  expect(extras, '1.0.18 validateMemorySchema rejects every unrecognized memory object').toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM memory_deny_session').get()?.n).toBe(1);
});

// Real HTTP boundary and startup/store/engine path, confined to the verification launcher's synthetic profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchVerificationServer } from '../scripts/control-murage.ts';
it.each(['gh18_crash_before_flush_reapplies_on_start','gh18_next_turn_opens_new_session_with_authorized_replay_only'])('%s', async scenario => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs'); const path=await import('node:path');
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),'server/drivers/builtIn.ts')).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),'server/testing/fake-late-terminal-driver.ts')).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'); const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.gh18={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_DUMP_FRAME:'1',FAKE_LATE_DUMP_CONTEXT:'1',FAKE_LATE_DUMP:path.join(process.env.MURAGE_DATA_DIR,'gh18-dump')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  try {
    let headers: Record<string,string> = {};
    const login = async () => { const {secret} = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any; headers={'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret}; };
    const api = async (method:string,path:string,body?:unknown) => { const response = await fetch(`${fixture.info.url}${path}`,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)}); return {status:response.status,body:await response.json() as any}; };
    await login();
    // The fixture's first fake-engine event must not race the fresh database's
    // eager index workers (an observed SQLITE_BUSY lost its reply before GH18 ran).
    // Wait for the worker completion signals, not an arbitrary startup delay.
    await expect.poll(() => {
      const log=readFileSync(fixture.info.logPath,'utf8');
      return [schema.IDENTITY_CANON_INDEX,schema.IDENTITY_PARTITION_INDEX,schema.WAITING_REVIEW_INDEX,schema.TOMBSTONE_FORGETS_INDEX]
        .every(name=>log.includes(`index build done name=${name} `));
    },{timeout:60000}).toBe(true);
    const {body:{bot}} = await api('POST','/api/bots',{name:'GH18 synthetic',modelSelection:{instanceId:'gh18',model:'late-1'}});
    await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
    for (const extra of [{ 'x-murage-surface': 'desktop' }, { ...headers, origin: 'https://not-murage.invalid' }]) {
      const denied = await fetch(`${fixture.info.url}/api/memory/bots/${bot.id}/fresh-start/preview`, {method:'POST',headers:extra,body:'{}'});
      expect([401,403,404]).toContain(denied.status);
    }
    // Absence of the route is the base RED, before any new-schema fixture setup.
    expect((await api('POST',`/api/memory/bots/${bot.id}/fresh-start/preview`,{})).status).toBe(200);
    const turn = async (text:string) => {
      expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text})).status).toBe(202);
      await expect.poll(async () => (await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).body.messages.some((m:any)=>m.role==='bot' && m.text==='Hello from late'),{timeout:30000}).toBe(true);
      await expect.poll(async () => (await api('GET','/api/bots?messages=0')).body.bots.find((b:any) => b.id===bot.id)?.busy === true,{timeout:30000}).toBe(false);
    };
    await turn('GH18_AUTHORIZED_REPLAY');
    await expect.poll(() => existsSync(join(fixture.info.dataDir,'bots.json')) && Boolean(JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8')).find((b:any)=>b.id===bot.id)?.tasks.find((t:any)=>t.threadId===bot.threadId)?.resumeCursors.gh18),{timeout:10000}).toBe(true);
    // Use the C4 stub for this slice's commit. Leave its cursor application pending, then exercise real startup recovery.
    const bots = JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8'));
    const saved = bots.find((b:any) => b.id === bot.id); const task = saved.tasks.find((t:any) => t.threadId === bot.threadId);
    expect(task.resumeCursors.gh18).toBeTruthy();
    const db = new DatabaseSync(join(fixture.info.dataDir,'messages.db'));
    db.exec('PRAGMA busy_timeout=10000'); // The live fixture's checkpoint/marker can hold the writer briefly.
    try {
      const clear = {botId:bot.id,instanceId:'gh18',threadId:bot.threadId,cursor:task.resumeCursors.gh18,incarnation:task.resumeIncarnations?.gh18};
      const service = module.createFreshStartOwner({db:()=>db,bot:()=>saved,schemaCompatible:()=>true,storeRevision:()=>0,botBusy:()=>false,liveThreads:()=>new Set(),ownerDirectThread:()=>true,pendingDeletion:()=>false,
        policy:{planFreshStart:()=>({botId:bot.id,sessionRows:[],cursorClears:[clear],retainedBlocks:0,retainedCapped:false,blocked:null}),applyFreshStartRows:()=>0},
        clearCursors:(clears:CursorClear[])=>{if(scenario==='gh18_next_turn_opens_new_session_with_authorized_replay_only') throw new Error('fixture crash after commit'); for(const c of clears) delete saved.tasks.find((t:any)=>t.threadId===c.threadId).resumeCursors[c.instanceId];},flush:()=>{throw new Error('fixture crash before flush');},
      });
      const authenticate = () => ({owner:'local-owner',session:'fixture'});
      const p = await service.request({botId:bot.id,action:'preview',body:{},authenticate});
      expect((await service.request({botId:bot.id,action:'confirm',body:{previewToken:p.body.previewToken,confirm:true,idempotencyKey:'real-startup-key-0001'},authenticate})).status).toBe(scenario==='gh18_crash_before_flush_reapplies_on_start'?202:503);
      const pending=db.prepare('SELECT cursors_applied,outcome_json FROM gh18_operations').get()!;
      expect(pending.cursors_applied).toBe(0); expect(JSON.parse(String(pending.outcome_json)).state).toBe('applying');
      expect(JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8')).find((b:any)=>b.id===bot.id).tasks.find((t:any)=>t.threadId===bot.threadId).resumeCursors.gh18).toBeTruthy();
      // A generated line is withdrawn; authorized user replay remains available.
      const line = db.prepare("SELECT l.lsn,l.message_id FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no JOIN messages m ON m.thread_id=t.thread_id AND m.id=l.message_id WHERE t.thread_id=? AND m.role='bot' AND m.kind='text' AND m.text='Hello from late' LIMIT 1").get(bot.threadId);
      expect(line).toBeTruthy();
      db.prepare("INSERT INTO memory_deny_point(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,901,?,'test')").run(bot.threadId,line!.lsn,line!.lsn);
      db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
      expect(denyLookup(db,{threadId:bot.threadId,lines:[{messageId:String(line!.message_id),author:'generated'}]},{audience:null}).get(String(line!.message_id))).toMatchObject({state:'withheld'});
    } finally { db.close(); }
    await fixture.restart(); await login();
    const recovered=new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
    try {
      const audits=recovered.prepare('SELECT * FROM gh18_operations').all();
      expect(audits).toHaveLength(1); expect(audits[0].cursors_applied).toBe(1);
      expect(JSON.parse(String(audits[0].outcome_json))).toMatchObject({state:'done',freshSessions:1});
    } finally { recovered.close(); }
    await expect.poll(() => { const db = new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true}); try { return db.prepare('SELECT cursors_applied FROM gh18_operations').get()?.cursors_applied; } finally {db.close();} },{timeout:30000}).toBe(1);
    const after = JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8')).find((b:any)=>b.id===bot.id);
    expect(after.tasks.find((t:any)=>t.threadId===bot.threadId).resumeCursors.gh18).toBeUndefined();
    await turn('GH18_NEW_QUESTION');
    const dumps = readFileSync(join(fixture.info.dataDir,'gh18-dump'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const latest = dumps.filter(row=>row.threadId === bot.threadId && row.prompt).at(-1);
    expect(JSON.stringify(latest)).toContain('GH18_AUTHORIZED_REPLAY');
    expect(JSON.stringify(latest)).not.toContain('Hello from late');
    expect(dumps.filter(row=>row.threadId===bot.threadId && !row.prompt).at(-1).resumed).toBe(false);
    // Integrated production route uses the statically bundled real P1 policy,
    // with no synthetic policy or schema-compatibility override.
    const path = `/api/memory/bots/${bot.id}/fresh-start`;
    // The engine's busy=false is not a derived-memory completion signal. Model
    // the owner's normal interaction hold, then observe existing leases drain:
    // no background claim may race this preview's strict database snapshot.
    expect(await api('POST',`/api/bots/${bot.id}/typing`,{})).toMatchObject({status:200,body:{held:true}});
    await expect.poll(()=>{
      const db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
      try{return Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='leased'").get()?.n);}
      finally{db.close();}
    },{timeout:30000}).toBe(0);
    expect(await api('POST',`/api/bots/${bot.id}/typing`,{})).toMatchObject({status:200,body:{held:true}});
    const p = await api('POST',`${path}/preview`,{});
    expect(p).toMatchObject({status:200,body:{state:'ready',freshSessions:1}});
    const body = { previewToken:p.body.previewToken,confirm:true,idempotencyKey:'production-route-key-0001' };
    const confirmed = await api('POST',`${path}/confirm`,body);
    expect(confirmed).toMatchObject({status:200,body:{state:'done',freshSessions:1,visibilityChanged:false}});
    expect(await api('POST',`${path}/confirm`,body)).toEqual(confirmed);
    expect(await api('GET',`${path}/operations/${confirmed.body.operationId}`)).toEqual(confirmed);
    const finalDb = new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
    let audits;
    try {
      expect(finalDb.prepare('SELECT count(*) AS n FROM memory_deny_point WHERE revoke_id=901').get()?.n).toBe(1);
      audits=finalDb.prepare('SELECT operation_id,cursors_applied,state,outcome_json FROM gh18_operations').all();
      expect(audits).toHaveLength(2);
    } finally { finalDb.close(); }
    if(process.env.SC_ISSUES_EVIDENCE){
      mkdirSync(process.env.SC_ISSUES_EVIDENCE,{recursive:true});
      const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`);
      writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,`${scenario}.json`),JSON.stringify({fixture:fixture.info,scenario,preview:p,confirmed,messages,audits,enginePayloads:dumps},null,2));
      writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,`${scenario}.log`),readFileSync(fixture.info.logPath));
    }


  } catch(error) {
    if(process.env.SC_ISSUES_EVIDENCE)writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,`${scenario}-failure.log`),readFileSync(fixture.info.logPath));
    throw error;
  } finally { await fixture.close(); }
},120000);


it('gh18_any_bot_turn_blocks_idle_task_cursors', async () => {
  const f=fixture();
  f.bot.busy=true;
  expect(await f.request('preview',{})).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',freshSessions:0}});
  f.bot.busy=false; const body=await preview(f); f.bot.busy=true;
  expect(await f.request('confirm',body)).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',clearedBlocks:0,freshSessions:0}});
  expect(f.counts().marks).toHaveLength(2); expect(f.counts().cursor).toBe('old'); expect(f.counts().deletes).toBe(0);
});
it('gh18_room_admission_blocks_before_bot_busy_flag', async () => {
  const f=fixture(); const body=await preview(f);
  f.live.add('room-thread-outside-bot-tasks'); f.deps.botBusy=()=>true;
  expect(await f.request('confirm',body)).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',clearedBlocks:0,freshSessions:0}});
  expect(f.counts().marks).toHaveLength(2); expect(f.counts().cursor).toBe('old'); expect(f.counts().deletes).toBe(0);
});
it('gh18_activity_snapshot_is_collected_once_per_classification', async () => {
  const f=fixture();
  f.bot.tasks.push(...Array.from({length:400},(_,i)=>({threadId:`idle-${i}`,busy:false,resumeCursors:{}})));
  const activity=vi.fn(()=>f.live); f.deps.liveThreads=activity;
  const body=await preview(f); expect(activity).toHaveBeenCalledTimes(1);
  activity.mockClear();
  expect((await f.request('confirm',body)).body.state).toBe('done'); expect(activity).toHaveBeenCalledTimes(1);
});


it('gh18_live_room_turn_keeps_idle_direct_session_and_blocks_owner_action', async () => {
  const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
    const fs=await import('node:fs'); const path=await import('node:path');
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),'server/drivers/builtIn.ts')).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(),'server/testing/fake-late-terminal-driver.ts')).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const gate=path.join(process.env.MURAGE_DATA_DIR,'gh18-room-gate'); fs.writeFileSync(gate,'first direct turn may finish');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.roomProof={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_SESSION:'1',FAKE_LATE_SESSION_GATE:gate}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  `});
  const gate=join(fixture.info.dataDir,'gh18-room-gate');
  try {
    const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as any;
    const headers={'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret};
    const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(fixture.info.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
    await expect.poll(()=>[schema.IDENTITY_CANON_INDEX,schema.IDENTITY_PARTITION_INDEX,schema.WAITING_REVIEW_INDEX,schema.TOMBSTONE_FORGETS_INDEX].every(name=>readFileSync(fixture.info.logPath,'utf8').includes(`index build done name=${name} `)),{timeout:60000}).toBe(true);
    const made=await api('POST','/api/bots',{name:'GH18 room proof',modelSelection:{instanceId:'roomProof',model:'late-1'}});
    expect(made.status).toBe(201); const bot=made.body.bot;
    expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false})).status).toBe(200);
    expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Create the direct session before room work'})).status).toBe(202);
    const saved=()=>JSON.parse(readFileSync(join(fixture.info.dataDir,'bots.json'),'utf8')).find((b:any)=>b.id===bot.id);
    await expect.poll(()=>{try{return saved()?.tasks.find((t:any)=>t.threadId===bot.threadId)?.resumeCursors.roomProof;}catch{return null;}},{timeout:30000}).toEqual(expect.any(String));
    await expect.poll(async()=>(await api('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:30000}).toBe(false);
    const cursor=saved().tasks.find((t:any)=>t.threadId===bot.threadId).resumeCursors.roomProof;
    const endpoint=`/api/memory/bots/${bot.id}/fresh-start`;
    expect((await api('POST',endpoint+'/preview',{})).body.state).toBe('ready');
    unlinkSync(gate);
    const room=await api('POST','/api/groups',{name:'GH18 live room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}});
    expect(room.status).toBe(201);
    expect((await api('POST',`/api/groups/${room.body.group.id}/messages`,{text:'Hold the real room turn at engine submission'})).status).toBe(202);
    await expect.poll(()=>existsSync(gate+'.waiting'),{timeout:30000}).toBe(true);
    const state=(await api('GET','/api/bots?messages=0')).body,live=state.bots.find((b:any)=>b.id===bot.id);
    expect(live.busy).toBe(true); expect(live.tasks.every((t:any)=>!t.busy)).toBe(true);
    expect(live.tasks.some((t:any)=>t.threadId===room.body.group.threadId)).toBe(false);
    const preview=await api('POST',endpoint+'/preview',{});
    expect(preview).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',staleBlocks:0,freshSessions:0}});
    const confirm=await api('POST',endpoint+'/confirm',{previewToken:preview.body.previewToken,confirm:true,idempotencyKey:'gh18-room-busy-key-0001'});
    expect(confirm).toMatchObject({status:200,body:{state:'blocked',reason:'bot-busy',clearedBlocks:0,freshSessions:0}});
    expect(saved().tasks.find((t:any)=>t.threadId===bot.threadId).resumeCursors.roomProof).toBe(cursor);
    if(process.env.SC_ISSUES_EVIDENCE)writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,'gh18-room-fixture.json'),JSON.stringify({fixture:fixture.info,room:room.body.group,live,preview,confirm,cursorPreserved:true},null,2));
  } finally {writeFileSync(gate,'release the owned room fixture');await fixture.close();}
},120000);
