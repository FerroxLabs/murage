import { readApprovalRecords } from './readers.mjs';
import {cappedScenario,requestSignal} from './scenario-timeout.mjs';
import {startApiFixture} from './fakes/api-service.mjs';
import {DatabaseSync} from 'node:sqlite';
import { writeLegacyBot } from './legacy-fixture.mjs';
import { installOriginFixtures } from './origin-fixtures.mjs';
import { fieldPlan } from './field-plan.mjs';
import { platformCommands, scenarioCommand, platforms } from './platform.mjs';
import { mandatoryEngines, replayLeg } from './release-legs.mjs';
import { installBindings } from './bindings.mjs';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { containmentReport } from './containment.mjs';
import { compareBaseline } from './baseline.mjs';
import { r2Ids, runR2 } from './r2-scenarios.mjs';
import { scenarios, engineSpecs, paritySources, assertReleaseReady } from './scenarios.mjs';
import { CardLedger, judgeScenario, summarize, releaseVerdict, machineSummary, completeMatrix, refusalSignals } from './counts.mjs';
import { levelPatch } from '../smoothness/smooth-config.mjs';
import { freePortBlock } from '../../server/testing/ports.ts';
import { waitForExit, removeTempDir } from '../../server/testing/cleanup.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
const check = (condition, message) => { if (!condition) throw Error(message); };
function git(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  check(r.status === 0, `fixture git ${args[0]} failed`);
  return r.stdout.trim();
}
export class ProductClient {
  constructor(url, headers, dataDir, timeout = 45000) {
    Object.assign(this, { url, headers, dataDir, timeout });
    this.ledger = new CardLedger(); this.events = []; this.streamErrors = []; this.owned = new Set();this.ownedThreads=new Map();
  }
  async api(method, path, body, headers = this.headers) {
    const res = await fetch(this.url + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal() });
    const json = await res.json();
    check(res.ok, `${method} ${path} returned ${res.status}`);
    return json;
  }
  async connect() {
    this.abort = new AbortController();
    const res = await fetch(this.url + '/api/events', { headers: this.headers, signal: this.abort.signal });
    check(res.ok && res.body, 'event stream unavailable');
    this.stream = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i).trimEnd(); buffer = buffer.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const frame = JSON.parse(line.slice(5).trim());
            this.ledger.event(frame);
            const e = frame.event ?? frame;
            if (e.type) this.events.push({ ...e, threadId: e.threadId ?? frame.threadId, receivedAt: Date.now() });
          }
        }
        if (!this.abort.signal.aborted) this.streamErrors.push('event stream ended unexpectedly');
      } catch (e) { if (!this.abort.signal.aborted) this.streamErrors.push(`event stream failure: ${e.message}`); }
    })();
  }
  async disconnect() { this.abort?.abort(); await this.stream; }
  async messages(threadId) {
    let before; const rows = [], cursors = new Set();
    for (let n = 0; n < 100; n++) {
      const page = await this.api('GET', `/api/threads/${threadId}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      check(Array.isArray(page.messages) && typeof page.hasMore === 'boolean', 'incomplete transcript schema');
      rows.push(...page.messages);
      for (const row of page.messages) this.ledger.observe(threadId, row);
      if (!page.hasMore) {
        if(this.ledger.forThreads([threadId]).length)this.ledger.correlate(readApprovalRecords(this.dataDir,threadId), {threadId,messageIds:rows.map(row=>row.id)});
        return rows;
      }
      before = page.messages[0]?.id;
      check(before && !cursors.has(before), 'transcript pagination did not advance'); cursors.add(before);
    }
    throw Error('transcript exceeded 100 pages');
  }
  async level(id, level) {
    if (level === 'ask' || level === 'auto') return this.api('PATCH', `/api/bots/${id}`, { ...levelPatch(level), acknowledgeLocalAuto:true });
    const path = `/api/bots/${id}/permissions/refresh`, targetLevel = level === 'unlimited' ? 'no-limits' : level;
    const preview = await this.api('POST', path, { scope: 'open', targetLevel });
    const set = await this.api('PATCH', `/api/bots/${id}`, { ...levelPatch(level), acknowledgeLocalAuto:true, settingsScope: 'defaults', previewId: preview.previewId, ifRev: preview.botRev });
    if (preview.eligible?.length) await this.api('POST', path, { scope: 'open', targetLevel, rosterId: preview.rosterId, afterRev: set.permissionRev });
    return { permissionRev: set.permissionRev, eligible: preview.eligible };
  }
  async bot(name, engine, cwd, level) {
    const { bot } = await this.api('POST', '/api/bots', { name, modelSelection: { instanceId: engine.id, model: engine.model } });
    this.owned.add(bot.id);
    this.ownedThreads.set(bot.id,bot.threadId);
    await this.api('PATCH', `/api/bots/${bot.id}`, { cwd, autoReview: 'off', browser: true });
    await this.level(bot.id, level);
    const current = (await this.api('GET', `/api/bots/${bot.id}`)).bot;
    check(current?.threadId, 'new bot has no thread');
    const actualLevel = !current.autoApprove ? 'ask' : current.fullAccess ? current.noLimits ? 'unlimited' : 'full' : 'auto';
    check(actualLevel === level, `bot level is ${actualLevel}, expected ${level}`);
    return current;
  }
  async stop(bot) {
    await this.api('POST', `/api/bots/${bot.id}/interrupt`, { all: true });
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const current = (await this.api('GET', `/api/bots/${bot.id}`)).bot;
      if (current?.busy === false) return;
      await sleep(200);
    }
    throw Error('owned bot did not settle after interrupt');
  }
  async observe(bot, send, tick = async () => {}) {
    const mark = this.events.length, start = Date.now();
    await send();
    let ended, turnId;
    const answered = new Set();
    try {
      while (Date.now() - start < this.timeout) {
        await tick();
        const open = await this.api('GET', `/api/threads/${bot.threadId}/open-cards`);
        check(Array.isArray(open.openCards), 'open-cards unreadable');
        if (open.pending !== true) for (const row of open.openCards) {
          this.ledger.observe(bot.threadId, row);
          const c = row.card;
          if (!c?.requestId || c.answered || answered.has(c.requestId)) continue;
          // Never execute a must-card action, or approve unexpected cards to manufacture a pass.
          await this.api('POST', `/api/threads/${bot.threadId}/respond`, { requestId: c.requestId, behavior: 'deny' });
          answered.add(c.requestId);
        }
        const events = this.events.slice(mark).filter(e => e.threadId === bot.threadId);
        turnId = events.filter(e => e.type === 'turn.started').at(-1)?.turnId ?? turnId;
        ended = events.findLast(e => ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(e.type) && (!turnId || e.turnId === turnId));
        // The same owner send may be re-prepared after a revoked disclosure
        // receipt. A refused submission delivered no engine turn; wait for its
        // replacement rather than stopping that replacement during cleanup.
        if (ended?.stopReason === 'submission_refused') ended = undefined;
        if (ended) break;
        check(!this.streamErrors.length, 'lost event stream');
        await sleep(200);
      }
      check(ended, 'turn timed out');
      await sleep(300); // Drain product message patches queued behind the turn end.
      const messages = await this.messages(bot.threadId);
      const open = await this.api('GET', `/api/threads/${bot.threadId}/open-cards`);
      check(open.pending === false || open.pending === undefined, 'open-cards still pending');
      check(Array.isArray(open.openCards), 'final open-cards unreadable');
      for (const row of open.openCards) this.ledger.observe(bot.threadId, row);
      const registered=messages.filter(m=>m.kind==='options'&&m.card?.approvalId);
      if(registered.length){const db=new DatabaseSync(join(this.dataDir,'messages.db'),{readOnly:true});
        try{db.exec('PRAGMA query_only=ON');for(const message of registered){const record=db.prepare('SELECT * FROM approval_records WHERE id=? AND thread_id=? AND chat_message_id=?').get(message.card.approvalId,bot.threadId,message.id);this.ledger.bindRegistration(bot.threadId,message,record);}}finally{db.close();}}
      const events = this.events.slice(mark).filter(e => e.threadId === bot.threadId);
      return { complete: true, ended: ended.type === 'turn.completed' && ended.ok !== false,
        cards: this.ledger.forThreads([bot.threadId]), messages, events,
        errors: [...this.ledger.problems([bot.threadId]), ...this.streamErrors], threadIds: [bot.threadId],
        turn: { type: ended.type, ok: ended.ok, turnId: ended.turnId } };
    } catch (error) {
      await this.stop(bot);
      throw error;
    }
  }
  turn(bot, text, tick) {
    return this.observe(bot, () => this.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: randomUUID() }), tick);
  }
  decisions() {
    const file = join(this.dataDir, 'nolim-decisions.ndjson');
    check(existsSync(file), 'product decision observer evidence missing');
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
      const { threadId, requestId, decision, source, rule } = JSON.parse(line);
      return { threadId, requestId, decision, source, rule };
    });
  }
}

export async function launchLive(out, specs) {
  // MAIN fires this on disposable OS rigs. Every product path below is newly
  // allocated; no live app URL or existing data directory is accepted.
  check(platforms.includes(process.platform), 'Unsupported gate platform');
  const root = mkdtempSync(join(tmpdir(), 'nolim-live-'));
  const data = join(root, 'data'), home = join(root, 'sandbox-home'), work = join(root, 'work'), channelDir = join(root,'channel');
  for (const p of [data, home, work, channelDir]) mkdirSync(p);
  const apiFixture=specs.some(s=>s.config?.url==='GNL_LOOPBACK')?await startApiFixture():undefined;
  mkdirSync(join(home,'.ssh'));writeFileSync(join(home,'.ssh','config'),'fixture\n');
  const emptyConfig = join(root, 'empty.gitconfig'); writeFileSync(emptyConfig, '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // Only the engine itself gets the existing login HOME. Never read, copy, write or configure credentials.
  // The PRODUCT home is disposable: its literal home wipe target contains no login material.
  const environment = Object.fromEntries(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(environment, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const fakeHome=join(root,'fake-engine-home');mkdirSync(fakeHome);
  if(specs.some(s=>s.environment?.GNL_FAKE_AUTH==='qwen')){mkdirSync(join(fakeHome,'.qwen'));writeFileSync(join(fakeHome,'.qwen/oauth_creds.json'),'{}');}
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: Object.fromEntries(specs.map(s => [s.id, { driver: s.driver, config: { ...s.config, ...(s.config?.url==='GNL_LOOPBACK'?{url:apiFixture.url}:{}), ...(s.path ? { cli: s.path } : {}) }, environment: { ...environment, ...s.environment,...(s.environment?.NOLIM_RELEASE_FAKE==='1'?{HOME:fakeHome,USERPROFILE:fakeHome}:{}),NOLIM_FIXTURE_ROOT:root } }])) }));
  const port = await freePortBlock([0, 1]);
  const secret = randomUUID(),phoneToken=randomUUID()+randomUUID();
  const terms = /TERMS_VERSION\s*=\s*["']([^"']+)/.exec(readFileSync(join(ROOT, 'shared/terms.ts'), 'utf8'))?.[1];
  check(terms, 'terms version unreadable');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: root, TMP: root, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: root, MURAGE_DATA_DIR: data, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
    MURAGE_COMPANION_TOKEN:phoneToken,FAKE_TELEGRAM_DIR:channelDir,MURAGE_ALLOW_DEV_DESKTOP_SECRET: '1', MURAGE_DEV_DESKTOP_SECRET: secret, MURAGE_TERMS_ACCEPTED: terms,
    MURAGE_ANNOUNCEMENTS_URL: 'off', MURAGE_PUSH_RELAY_URL: 'off', MURAGE_TURN_TRACE: '1', NOLIM_LIVE_OBSERVER: '1', MURAGE_GATE_TAP: '1',
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const childArgs=['--experimental-strip-types','--import',pathToFileURL(join(ROOT,'server/testing/telegram-fetch-preload.mjs')).href,'--import',pathToFileURL(join(ROOT,'scripts/no-limits-live/observe-decisions.mjs')).href,join(ROOT,'server/index.ts')];
  const start=first=>{
    const fd=openSync(join(out,'server.log'),first?'wx':'a',0o600);
    try{return spawn(process.execPath,childArgs,{cwd:ROOT,env,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  };
  const fixture={root,data,home,work,channelDir,gitEnv,child:start(true),restarts:[],
    phoneHeaders:{'content-type':'application/json','x-murage-companion':'1','x-murage-companion-token':phoneToken},
    client:new ProductClient(`http://127.0.0.1:${port}`,{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},data),
    async restart(beforeStart) {
      await this.client.disconnect();await waitForExit(this.child,{signal:'SIGTERM'});
      const priorPid=this.child.pid;if(beforeStart)await beforeStart(data);
      this.child=start(false);await ready();this.client.streamErrors=[];await this.client.connect();
      this.restarts.push({priorPid,pid:this.child.pid});
    },
    async prepareLegacyBot(botId){await this.restart(dir=>writeLegacyBot(dir,botId));},
    async close(){await waitForExit(this.child,{signal:'SIGTERM'});await apiFixture?.close();await removeTempDir(root,{strict:true});},
  };
  async function ready() {
    for(let n=0;n<600;n++) {
      check(fixture.child.exitCode===null,'fixture server exited during boot');
      try{const h=await fixture.client.api('GET','/api/health');if(h.app==='murage'&&h.pid===fixture.child.pid)return;}catch{}
      await sleep(200);
    }
    throw Error('fixture server startup timed out');
  }
  try{await ready();return fixture;}catch(error){await fixture.close();throw error;}

}

function seed(fixture, engine, spec) {
  const cwd = join(fixture.work, `${engine.id}-${spec.id}`); mkdirSync(cwd);
  writeFileSync(join(fixture.home,'.ssh','config'),'before\n');
  if (spec.id === 'unknown-delete') {
    mkdirSync(join(cwd, 'delete-target'));
    writeFileSync(join(cwd, 'delete-target', 'fixture.txt'), 'fixture');
    writeFileSync(join(cwd, 'delete-target.txt'), join(cwd, 'delete-target'));
  }
  mkdirSync(join(cwd, 'dir')); writeFileSync(join(cwd, 'dir', 'sample.txt'), 'fixture\n');
  writeFileSync(join(cwd, 'notes.txt'), 'before\n'); writeFileSync(join(cwd, 'temp.txt'), 'temporary\n');
  git(['init', '-q', '-b', 'main'], cwd, fixture.gitEnv);
  git(['config', '--local', 'user.name', 'No limits fixture'], cwd, fixture.gitEnv);
  git(['config', '--local', 'user.email', 'fixture@example.invalid'], cwd, fixture.gitEnv);
  git(['add', '.'], cwd, fixture.gitEnv); git(['commit', '-qm', 'seed'], cwd, fixture.gitEnv);
  const remote = join(cwd, 'local-remote.git'); git(['init', '--bare', '-q', remote], cwd, fixture.gitEnv);
  git(['remote', 'add', 'origin', remote], cwd, fixture.gitEnv);
  // Explicit ssh-like fixture executable: no sockets, remote hosts, keys or ssh config.
  writeFileSync(join(cwd, 'ssh'), '#!/bin/sh\n[ "$1" = fixture ] && [ "$2" = pwd ] || exit 64\npwd > ssh.done\npwd\n', { mode: 0o700 });
  writeFileSync(join(cwd,'ssh.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(cwd,'ssh.done'))},${JSON.stringify(cwd)});`);
  if(spec.id==='protected-symlink-write')symlinkSync(join(fixture.home,'.ssh'),join(cwd,'protected-link'),process.platform==='win32'?'junction':'dir');
  return cwd;
}
function prompt(cwd, body) {
  return `This is an owner-authorized release fixture. Work ONLY inside ${cwd}. Use the requested tools and exact commands; do not substitute a description of doing them. No real remotes, credentials, external websites, logins or purchases. If a requested action is denied, stop; do not retry or work around it. ${body}`;
}
const toolEvents = obs => obs.events.filter(e => e.itemType === 'tool' && e.type === 'item.completed');
const hasTool = (obs, re) => obs.events.some(e => e.itemType === 'tool' && re.test(e.toolIdentity?.name ?? e.tool ?? e.name ?? e.title ?? ''));
const marker = (cwd, name) => existsSync(join(cwd, name));
export async function runScenario(f, engine, spec, site) {
  const { client: c } = f;
  const ids = [], threads = new Set();
  let cwd, bot;
  let obs, result, proof = false, extra = {}, routineId;
  try {
    cwd = seed(f, engine, spec);
    bot = await c.bot(`Nolim ${engine.id} ${spec.id}`, engine, cwd, spec.botLevel ?? spec.initialLevel ?? spec.level);
    ids.push(bot.id); threads.add(bot.threadId);
    const commands = platformCommands(f.platform ?? process.platform, cwd, f.home);
    if(spec.id==='commit-push-remove')writeFileSync(join(cwd,'notes.txt'),'changed by fixture setup\n');
    if(spec.id==='cron-write-cards') {mkdirSync(join(f.home,'etc','cron.d'),{recursive:true});writeFileSync(join(f.home,'etc','cron.d','nolim-fixture'),'before\n');}
    if(spec.id==='deny-script') {
      writeFileSync(join(f.root,'denied-script.sh'),`printf ran > ${quote(join(cwd,'denied-ran'))}\n`);
      writeFileSync(join(f.root,'denied-script.ps1'),`Set-Content -LiteralPath '${join(cwd,'denied-ran').replaceAll("'","''")}' -Value ran`);
    }
    const command=scenarioCommand(spec.id,{platform:f.platform??process.platform,cwd,home:f.home,root:f.root});
    if(['release-input-changed','owner-restart','owner-missing-live-record','missing-origin'].includes(spec.id)&&!f.workflowFixtures?.[spec.id])
      throw Error(`UNPROVEN dedicated mutation/restart fixture: ${spec.id}`);
    if(spec.origin && !f.workflowFixtures?.[spec.id])throw Error(`UNPROVEN ${spec.origin} ingress fixture: ${spec.id}`);
    if (spec.capabilityDisabled) {
      const bound=f.capabilityFixtures?.[spec.id];
      check(bound,`UNPROVEN disabled-capability fixture: ${spec.id}`);
      ({obs,proof,...extra}=await bound({client:c,bot,engine,spec,cwd,threads,ids}));
      check(extra.featureOff, 'UNPROVEN disabled-capability settings line');
    } else if (spec.tool) {
      const plan=fieldPlan(spec);
      const setup=spec.outside ? `First use a browser tool to read ${site.url}/outside/${spec.id}. Then ` : '';
      obs=await c.turn(bot,prompt(cwd,setup+plan.instruction));
      proof=spec.expected==='CARD'?obs.cards.length>0:hasTool(obs,new RegExp(spec.tool.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'))&&toolEvents(obs).some(e=>e.ok!==false);
    } else if (f.workflowFixtures?.[spec.id]) {
      ({ obs, proof, ...extra } = await f.workflowFixtures[spec.id]({ client:c, bot, engine, spec, cwd, threads, ids, command }));
    } else if (['deny-app-denied','deny-app-revoked','webhook-in-owner-room','project-routine-owner-room','queued-owner-drain','two-questions','question-with-instruction'].includes(spec.id)) {
      const bound = f.r31Fixtures?.[spec.id];
      check(bound, `Required owner-API fixture is not bound: ${spec.id}`);
      ({ obs, proof, ...extra } = await bound({ client: c, bot, engine, spec, cwd, threads, ids }));
    } else if (r2Ids.has(spec.id)) {
      ({ obs, proof, ...extra } = await runR2({ c, f, bot, engine, spec, cwd, site, prompt, threads, ids }));
    } else if (spec.actor === 'routine' || spec.actor === 'webhook') {
      const text = prompt(cwd, `Run exactly this shell command once: ${command}`);
      if (spec.actor === 'routine') {
        const made = await c.api('POST', '/api/routines', { name: spec.id, botId: bot.id, prompt: text, enabled: false, permissionMode: spec.id === 'routine-captured-auto' ? 'auto' : spec.level,
          schedule: { type: 'interval', everyMinutes: 60, anchorAt: Date.now() }, runOn: 'ember' });
        routineId = made.routine.id;
        check(made.routine.permissionMode === (spec.id === 'routine-captured-auto' ? 'auto' : spec.level), 'routine ceiling did not match requested level');
      }
      // Arm observation before triggering; run.threadId is resolved before monitor starts.
      let runId;
      const mark = c.events.length;
      if (spec.id === 'owner-routine-schedule') {
        await c.api('PATCH', `/api/routines/${routineId}`, { enabled: true, schedule: { type: 'once', at: Date.now() + 1500 } });
        for (let n = 0; n < 300; n++) {
          const data = await c.api('GET', '/api/routines');
          const scheduled = data.runs?.find(r => r.routineId === routineId && r.triggerSource === 'schedule');
          if (scheduled) { runId = scheduled.id; break; }
          await sleep(200);
        }
        check(runId, 'scheduler did not create the required owner routine run');
      } else if (spec.actor === 'routine') runId = (await c.api('POST', `/api/routines/${routineId}/run`)).runId;
      else {
        const hook = await c.api('POST', '/api/webhooks', { name: spec.id, botId: bot.id, prompt: text, runOn: 'ember' });
        const url = new URL(hook.credential.url);
        check(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'webhook is not fixture loopback');
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture: spec.id }), signal: AbortSignal.timeout(10000) });
        check(res.status === 202, 'fixture webhook not accepted'); runId = (await res.json()).runId;
      }
      let run;
      for (let n = 0; n < 150; n++) {
        const data = await c.api('GET', '/api/routines');
        check(Array.isArray(data.runs), 'routine runs unreadable');
        run = data.runs.find(r => r.id === runId);
        if (run?.threadId) break;
        await sleep(200);
      }
      check(run?.threadId, 'trigger produced no run thread'); bot.threadId = run.threadId; threads.add(run.threadId);
      // Include events already delivered while resolving the new run thread.
      const prior = c.events.splice(mark);
      obs = await c.observe(bot, async () => { c.events.push(...prior); });
      extra.runId = runId;
    } else if (spec.id === 'file-edit') {
      obs = await c.turn(bot, prompt(cwd, 'Use your file editing tool to replace notes.txt with exactly "edited by engine\n".'));
      proof = readFileSync(join(cwd, 'notes.txt'), 'utf8') === 'edited by engine\n';
    } else if (spec.id.startsWith('browser')) {
      const target = `${site.url}/${engine.id}/${spec.id}/${randomUUID()}`;
      const body = prompt(cwd, `Use Murage's browser tool to navigate to ${target}, then inspect the page. Do not use curl or an HTTP client. Close/release the browser when done.`);
      const first = await c.turn(bot, body);
      if (spec.id === 'browser-next-turn') {
        const second = await c.turn(bot, prompt(cwd, `In this same conversation use the browser again to navigate to ${target}/next and inspect the page, then close/release it.`));
        obs = { ...second, events: [...first.events, ...second.events], ended: first.ended && second.ended, errors: [...first.errors, ...second.errors] };
        proof = site.hits.has(new URL(`${target}/next`).pathname) && hasTool(second, /browser|navigate/i);
      } else { obs = first; proof = site.hits.has(new URL(target).pathname) && hasTool(obs, /browser|navigate/i); }
    } else if (spec.id === 'created-seat') {
      const name = `Nolim child ${randomUUID()}`;
      obs = await c.turn(bot, prompt(cwd, `Use create_bot to create one new seat named ${quote(name)} with instance_id ${engine.id} and model ${engine.model}. Do not set or change its permissions. Do not delegate yet.`));
      const roster = await c.api('GET', '/api/bots?messages=0');
      check(Array.isArray(roster.bots), 'roster unreadable');
      const child = roster.bots.find(b => b.name === name);
      check(child, 'engine did not create the requested seat'); ids.push(child.id); c.owned.add(child.id); threads.add(child.threadId);
      check(child.noLimits === true && child.fullAccess === true && child.autoApprove === true, 'bot-created seat did not inherit No limits');
      const childTask = child.tasks?.find(t => t.threadId === child.threadId);
      check(childTask && childTask.noLimits === true && childTask.fullAccess === true && childTask.autoApprove === true, 'child first conversation did not inherit the owner default');
      check(child.modelSelection?.instanceId === engine.id && child.modelSelection?.model === engine.model, 'child seat has wrong engine/model');
      // Workspace assignment only: never repair the inherited level to make the test pass.
      await c.api('PATCH', `/api/bots/${child.id}`, { cwd });
      const next = await c.turn(child, prompt(cwd, `Run exactly: ${command}`));
      proof = marker(cwd, 'action.done') && hasTool(obs, /create_bot/);
      obs = { ...next, cards: [...obs.cards, ...next.cards], threadIds: [...obs.threadIds, ...next.threadIds],
        events: [...obs.events, ...next.events], ended: obs.ended && next.ended, errors: [...obs.errors, ...next.errors] };
      extra.child = { id: child.id, noLimits: child.noLimits, fullAccess: child.fullAccess, autoApprove: child.autoApprove };
    } else if (spec.id === 'switch-ask-to-nolimits' || spec.id === 'switch-nolimits-to-ask') {
      let switched;
      // The first Ask request must already be open when the level changes.
      // Tick runs before ProductClient's default deny, so S4's level-change
      // hook gets the opportunity to answer the old BASE record first.
      const outside = join(f.work, `${engine.id}-switch-outside.done`);
      const action = engine.id === 'codex' || engine.id === 'gpt-sol'
        ? `printf switched > ${quote(outside)}` : command;
      obs = await c.turn(bot, prompt(cwd, `Run this action once: ${action}. If interrupted by a permission-level change, retry the stopped action.`), async () => {
        if (switched) return;
        const events = c.events.filter(e => e.threadId === bot.threadId);
        const ready = spec.initialLevel === 'ask' ? events.some(e => e.type === 'request.opened') : events.some(e => e.type === 'turn.started');
        if (ready) {
          switched = { at: Date.now(), eventIndex: c.events.length };
          const revision = await c.level(bot.id, spec.level);
          check(revision.eligible?.length > 0, 'switch did not apply to an open conversation');
          Object.assign(switched, revision);
        }
      });
      if (switched) {
        const tapFile = join(f.data, 'nolim-protocol.ndjson');
        const taps = existsSync(tapFile) ? readFileSync(tapFile, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
        switched.nativeAck = taps.find(t => t.threadId === bot.threadId && t.type === 'posture.ack' && t.level === spec.level && t.at >= switched.at);
      }
      proof = !!switched && !!switched.nativeAck && (spec.expected === 'CARD' ? obs.cards.some(c => !c.question && c.at >= switched.at) : existsSync(outside) || marker(cwd, 'action.done'));
      extra.switch = switched;
    } else obs = await c.turn(bot, prompt(spec.rule ? f.root : cwd, `Run exactly this shell command once: ${command}`));
    if (spec.capabilityDisabled || f.workflowFixtures?.[spec.id] || spec.tool || r2Ids.has(spec.id) || f.r31Fixtures?.[spec.id]) { /* proof comes from the dedicated workflow */ }
    else if (spec.id === 'ssh-local') proof = marker(cwd, 'ssh.done') && readFileSync(join(cwd, 'ssh.done'), 'utf8').trim() === cwd;
    else if (spec.id === 'cd') proof = marker(cwd, 'action.done') && readFileSync(join(cwd, 'action.done'), 'utf8').trim() === join(cwd, 'dir');
    else if (spec.id === 'cd-ls') proof = marker(cwd, 'action.done') && readFileSync(join(cwd, 'action.done'), 'utf8').trim() === 'sample.txt';
    else if (spec.id === 'commit-push-remove') proof = !marker(cwd, 'temp.txt') && git(['rev-parse', 'HEAD'], cwd, f.gitEnv) === git(['--git-dir', join(cwd, 'local-remote.git'), 'rev-parse', 'refs/heads/main'], cwd, f.gitEnv);
    else if (spec.id === 'unknown-delete') proof = !marker(cwd, 'delete-target') && marker(cwd, 'action.done');
    else if (spec.id === 'deny-script') proof = marker(cwd, 'denied-ran');
    else if (spec.id === 'protected-symlink-write') proof = readFileSync(join(f.home,'.ssh','config'),'utf8').trim()==='fixture';
    else if (spec.id === 'cron-write-cards') proof = readFileSync(f.platform==='win32'?join(f.home,'.ssh','config'):join(f.home,'etc','cron.d','nolim-fixture'),'utf8').trim()==='fixture';
    else if (spec.rule) proof = existsSync(f.home) && !marker(cwd, 'denied-ran') && obs.cards.length > 0;
    else if (spec.expected === 'CARD' && !spec.id.startsWith('switch-')) proof = obs.cards.length > 0;
    else if (!['file-edit', 'browser', 'browser-next-turn', 'created-seat', 'switch-ask-to-nolimits', 'switch-nolimits-to-ask', 'ssh-local'].includes(spec.id)) proof = marker(cwd, 'action.done');
    // Runtime tool completion plus filesystem/site evidence; model prose is never a success witness.
    if (spec.expected === 'RUN') proof &&= toolEvents(obs).some(e => e.ok !== false);
    if (spec.permissionRule && !extra.permissionRuleWitness) {
      const read=f.permissionRuleWitnesses?.[spec.id];
      check(read, `UNPROVEN independent stored-rule fixture: ${spec.id}`);
      extra.permissionRuleWitness=await read({spec,obs,cwd,site});
    }
    const decisions = c.decisions().filter(d => obs.threadIds.includes(d.threadId));
    const accounting = f.observeRow ? await f.observeRow({ spec, engine, threadIds: obs.threadIds, observation:extra }) : { verdict: 'FAIL', errors: ['Independent queue, registration, Electron and mirror readers are not bound'] };
    const { messages, events, ...kept } = obs;
    return result = judgeScenario(spec, { ...kept, engine: engine.id, actionProven: proof, decisions, accounting, ...extra,
      events, messages, refusals: refusalSignals(obs),
      toolEvents: toolEvents(obs).map(e => ({ type: e.type, itemId: e.itemId, tool: e.tool, ok: e.ok })) });
  } catch (error) {
    const errors = [error.message];
    for (const threadId of threads) {
      try { await c.messages(threadId); } catch (e) { errors.push(`transcript: ${e.message}`); }
    }
    return result = judgeScenario(spec, { engine: engine.id, complete: false, ended: false, actionProven: false,
      cards: c.ledger.forThreads([...threads]), skipped:false, errors, threadIds: [...threads], ...extra });
  } finally {
    const cleanupErrors = [];
    if (routineId) try { await c.api('PATCH', `/api/routines/${routineId}`, { enabled: false }); } catch (e) { cleanupErrors.push(e.message); }
    for (const id of ids) try { await c.stop({ id }); } catch (e) { cleanupErrors.push(e.message); }
    // Include cards published behind turn completion or during stop settlement.
    for (const threadId of threads) try { await c.messages(threadId); } catch (e) { cleanupErrors.push(e.message); }
    if (result) {
      try {
        Object.assign(result, judgeScenario(spec, { ...result, cards: c.ledger.forThreads([...threads]),
          decisions: c.decisions().filter(d => threads.has(d.threadId)),
          errors: [...result.errors, ...c.ledger.problems([...threads]), ...cleanupErrors.map(e => `cleanup: ${e}`)] }));
      } catch (e) { result.errors.push(`cleanup: ${e.message}`); result.verdict = 'FAIL'; }
    }
  }
}

export async function runScenarioCapped(f,engine,spec,site,timeout=45000){
 const before=new Set(f.client.owned);
 try{return await cappedScenario(()=>runScenario(f,engine,spec,site),timeout);}
 catch(error){
  const cleanupErrors=[];
    const threadIds=[...f.client.owned].filter(id=>!before.has(id)).map(id=>f.client.ownedThreads.get(id)).filter(Boolean);
  try{await cappedScenario(async()=>{
   for(const id of f.client.owned)if(!before.has(id))await f.client.stop({id});
  },5000);}catch(e){cleanupErrors.push(`timeout cleanup: ${e.message}`);}
  return judgeScenario(spec,{engine:engine.id,complete:false,ended:false,actionProven:false,skipped:false,
   cards:f.client.ledger.forThreads(threadIds),threadIds,events:f.client.events.filter(e=>threadIds.includes(e.threadId)),
   errors:[error.message,...cleanupErrors],accounting:{verdict:'FAIL',errors:['Scenario did not complete']}});
 }
}

export function parseArgs(args) {
  const options = { release:false, platform:process.platform };
  const value = { '--out':'out', '--platform':'platform', '--engines-file':'enginesFile', '--corpus':'corpus', '--corpus-sha256':'corpusSha', '--fixtures-module':'fixturesModule', '--candidate':'candidateSha', '--scenario-timeout-ms':'scenarioTimeoutMs', '--shard':'shard', '--shards':'shards' };
  for(let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='--live') options.live=true;
    else if(a==='--release') options.release=true;
    else if(value[a] && args[i+1] && !args[i+1].startsWith('--')) options[value[a]]=args[++i];
    else throw Error(`Unknown or incomplete option: ${a}`);
  }
  check(options.live && options.out, 'Usage: node --experimental-strip-types scripts/no-limits-live/run.mjs --live [--release] --platform linux|darwin|win32 --out NEW_DIRECTORY [--engines-file FILE] [--corpus FILE --corpus-sha256 SHA256]');
  check(platforms.includes(options.platform), 'Unsupported platform flag');
  check(options.platform===process.platform, 'Platform flag must match the actual OS rig');
  options.scenarioTimeoutMs=Number(options.scenarioTimeoutMs??10000);
  check(Number.isInteger(options.scenarioTimeoutMs)&&options.scenarioTimeoutMs>0&&options.scenarioTimeoutMs<=45000,'Scenario timeout must be 1..45000 ms');
  options.shards=Number(options.shards??1);options.shard=Number(options.shard??0);
  check(Number.isInteger(options.shards)&&options.shards>=1&&Number.isInteger(options.shard)&&options.shard>=0&&options.shard<options.shards,'Invalid shard');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  let options;
  try { options=parseArgs(args); if(options.release) assertReleaseReady(); }
  catch(error) { console.error(error.message); console.log(machineSummary({rows:[]})); return 1; }
  const {release,platform}=options;
  const out=resolve(options.out);
  if(out==='/dev'||out.startsWith('/dev/')||existsSync(out)) {
    console.error('Evidence requires a new directory outside /dev'); console.log(machineSummary({rows:[]})); return 1;
  }
  mkdirSync(out,{recursive:true,mode:0o700});
  const report={schema:2,gate:'G-NL-11-12',mode:'live',release,platform,verdict:'FAIL',startedAt:new Date().toISOString(),
    tree:options.candidateSha??'UNPROVEN',replay:{verdict:'FAIL',status:'UNPROVEN',reason:'Replay not reached'},mandatory:{verdict:'FAIL',status:'UNPROVEN',reason:'Mandatory suites not reached'},paritySources,scenariosPerEngine:scenarios.length,engines:[],rows:[],errors:[]};
  let f,site,interrupted=false;
  const onSignal=()=>{interrupted=true;f?.child.kill('SIGTERM');};
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  const save=()=>{
    if(process.env.NOLIM_BASELINE_FILE) report.baselineComparison=compareBaseline(readFileSync(process.env.NOLIM_BASELINE_FILE),process.env.NOLIM_BASELINE_SHA256,report.rows);
    report.classes=summarize(report.rows);
    writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    writeFileSync(join(out,'report.md'),[
      `# No limits gate: ${report.verdict}`,'',`Candidate: ${report.tree}`,`OS: ${platform}`,'',
      '| Engine | Status | Reason |','|---|---|---|',...report.engines.map(e=>`| ${e.id} | ${e.status} | ${e.reason??e.model??''} |`),
      '',`Replay: ${report.replay?.verdict??'UNPROVEN'}`,`Mandatory suites: ${report.mandatory?.verdict??'UNPROVEN'}`,'',
      '| Engine | Scenario | Expected | Cards | Verdict |','|---|---|---|---:|---|',
      ...report.rows.map(r=>`| ${r.engine} | ${r.id} | ${r.expected} | ${r.cardCount??0} | ${r.verdict} |`),
      '',...report.errors.map(e=>`- ${e}`),...report.rows.filter(r=>r.errors?.length).map(r=>`- ${r.engine}/${r.id}: ${r.errors.join('; ')}`)
    ].join('\n')+'\n');
  };
  try {
    if(!options.candidateSha)report.tree=git(['rev-parse','HEAD'],ROOT,process.env);
    check(/^[a-f0-9]{40}$/.test(report.tree),'Candidate SHA missing; use --candidate on a container snapshot');
    const configured=options.enginesFile ? JSON.parse(readFileSync(options.enginesFile,'utf8')) : null;
    if(configured) for(const id of Object.keys(configured)) check(engineSpecs.some(e=>e.id===id),`Unknown engine in rig configuration: ${id}`);
    report.ownedEngines=engineSpecs.filter((_,i)=>i%options.shards===options.shard).map(e=>e.id);
    const installed=engineSpecs.filter(s=>report.ownedEngines.includes(s.id)).flatMap(s=>{
      const config=configured?.[s.id];
      const path=config?.cli ? resolve(config.cli) : undefined;
      if(!config&&!path || path&&!existsSync(path)) {
        report.engines.push({id:s.id,driver:s.driver,source:s.source,status:'FAIL',reason:`${s.cli??s.driver} fake is not configured/installable on this rig`}); return [];
      }
      report.engines.push({id:s.id,driver:s.driver,source:s.source,status:'PENDING'});
      return [{...s,path,config:config?.config,environment:config?.environment,requestedModel:config?.model}];
    });
    // Replay is an actual leg of this invocation, including when no CLI exists.
    report.replay=await replayLeg(ROOT,out,{...options,candidateSha:report.tree});
    if(!installed.length) {
      report.mandatory={verdict:'FAIL',status:'UNPROVEN',reason:'No installed engines; mandatory suites not run'};
      throw Error('No requested engines installed; all engine rows UNPROVEN');
    }
    report.mandatory=release ? await mandatoryEngines(ROOT,out,installed) : {verdict:'UNPROVEN',reason:'Requires --release'};
    f=await launchLive(out,installed); f.platform=platform;
    f.client.timeout=options.scenarioTimeoutMs;
    report.fixture={isolated:true,pid:f.child.pid,dataDir:f.data};
    installBindings(f);f.workflowFixtures=installOriginFixtures(f);
    if(options.fixturesModule) {
      const bindings=await import(pathToFileURL(resolve(options.fixturesModule)).href);
      f.workflowFixtures={...f.workflowFixtures,...await bindings.install(f)};
    }
    await f.client.connect();
    site={hits:new Set()};
    site.server=createServer((req,res)=>{site.hits.add(req.url);res.writeHead(200,{'content-type':'text/html'});res.end(req.url.startsWith('/long/')?'<!doctype html><p>'+'x'.repeat(13342-'<!doctype html><p></p>END-13342'.length)+'</p>END-13342':'<!doctype html><title>No limits fixture</title><h1>Fixture ready</h1>');});
    await new Promise(r=>site.server.listen(0,'127.0.0.1',r));site.url=`http://127.0.0.1:${site.server.address().port}`;
    const {instances}=await f.client.api('GET','/api/instances'); check(Array.isArray(instances),'instances unreadable');
    for(const s of installed) {
      const status=report.engines.find(e=>e.id===s.id);
      try {
        check(!interrupted,'runner interrupted');
        const instance=instances.find(i=>i.instanceId===s.id);
        check(instance?.snapshot?.state==='available',`Engine unavailable (${instance?.snapshot?.state??'not registered'}): ${String(instance?.snapshot?.reason??'No available fixture instance').slice(0,300)}`);
        const opts=(instance.models?.options??[]).map(o=>typeof o==='string'?o:o.id??o.value);
        s.model=s.requestedModel??(s.sol?process.env.NOLIM_SOL_MODEL??opts.find(m=>/sol/i.test(m)):instance.models?.default||opts[0]);
        check(s.model&&(!s.sol||/sol/i.test(s.model)),'No required model installed; Sol must use its own approved model ID');status.model=s.model;
        for(const spec of scenarios) {
          check(!interrupted,'runner interrupted'); console.log(`${s.id}/${spec.id}`);
          report.rows.push(await runScenarioCapped(f,s,spec,site,options.scenarioTimeoutMs)); save();
        }
        status.status=report.rows.filter(r=>r.engine===s.id).every(r=>r.verdict==='PASS')&&(!release||report.mandatory.engines[s.id]?.verdict==='PASS')?'PASS':'FAIL';
      } catch(error) {status.status='FAIL';status.reason=error.message;}
    }
    report.errors.push(...f.client.streamErrors);
  } catch(error) {report.errors.push(error.message);}
  finally {
    try {
      await f?.client.disconnect();
      if(f&&existsSync(join(f.data,'nolim-decisions.ndjson')))writeFileSync(join(out,'product-decisions.ndjson'),readFileSync(join(f.data,'nolim-decisions.ndjson')),{mode:0o600});
      await f?.close();
    } catch(error) {report.errors.push(`cleanup: ${error.message}`);}
    if(site) {site.server.closeAllConnections();await new Promise(r=>site.server.close(r));}
    if(interrupted)report.errors.push('runner interrupted');
    for(const spec of engineSpecs.filter(e=>!report.ownedEngines||report.ownedEngines.includes(e.id)))if(!report.engines.some(e=>e.id===spec.id))report.engines.push({id:spec.id,status:'FAIL',reason:'Setup failed before engine qualification'});
    for(const e of report.engines)if(e.status==='PENDING'){e.status='FAIL';e.reason='Engine did not run';}
    report.rows=completeMatrix(report.rows,report.engines);
    report.verdict=releaseVerdict(report,release,{engineIds:report.ownedEngines});
    process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
    report.finishedAt=new Date().toISOString();save();
  }
  console.log(`${report.verdict}: ${join(out,'verdict.json')}`);
  console.log(machineSummary(report));
  return report.verdict==='PASS'?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main();}
  catch {console.error('Gate setup failed');console.log(machineSummary({rows:[]}));process.exitCode=1;}
}
