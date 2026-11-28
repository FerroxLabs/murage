// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSAVE-1024: the one bound of a save's capture step (32 slices, 250 ms with every lock wait inside it), through the shipped
// HTTP door on a started server (server/index.ts POST /api/internal/memory/save, authenticated with the turn's own memory
// credential). The in-process rows are server/memory/memsave-capture-bound-1024.test.ts; these two enter where the bot does.
// The memory worker never gets to claim a job (the field state, BG_DEFERRED), so nothing works the capture queue but the save.
//  W8-HTTP a save that ends on the owner's card ran the capture step, and the base path it then takes ran it again;
//  W9-HTTP a cited job that cannot be read was failed with the background lock wait and then claimed a second time.
// The fake engine sends exactly the save the test orders (a file in the data dir), once. No command text is executed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

/** The wall bound one save's capture step declares (authority.ts SAVE_CAPTURE_MS), and one 64 KiB capture slice. */
const BOUND_MS = 250, SLICE = 65536;
/** W9-HTTP: what every write lock of the capture step costs (a busy store), and how far two clock reads of one instant may lie
 * apart (the step reads the clock, then hands the wait to SQLite, where the fixture reads it again). */
const LOCK_COST_MS = 110, CLOCK_SLACK_MS = 10;

let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
const dataFile = (name: string) => join(fixture.info.dataDir, name);
function rows<T>(sql: string, ...args: Array<string | number>): T[] {
  const db = new DatabaseSync(dataFile('messages.db'), { readOnly: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}
/** The capture job of the owner line that starts with these words. */
const jobOf = (lead: string) => rows<{ status: string; cursor: number; lease_owner: string | null; error: string | null }>(
  `SELECT j.status,j.cursor,j.lease_owner,j.error FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
   JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
   WHERE j.stage='capture' AND s.speaker='owner' AND substr(json_extract(v.payload,'$.text'),1,?)=?`, lead.length, lead)[0];
/** The owner says a line; the turn it starts has ended when the fake engine has answered it (one line per turn in the turn log). */
async function say(bot: { id: string; threadId: string }, text: string, turns: number) {
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
  await expect.poll(() => existsSync(dataFile('memsave-bound-turns.log')) ? readFileSync(dataFile('memsave-bound-turns.log'), 'utf8').split('\n').filter(Boolean).length : 0, { timeout: 30000 }).toBe(turns);
}
/** Order the next turn's one save; returns what the HTTP door answered. */
async function orderedSave(bot: { id: string; threadId: string }, text: string, turns: number, order: Record<string, unknown>) {
  const out = `memsave-bound-${order.out}.json`;
  writeFileSync(dataFile('memsave-bound-order.json'), JSON.stringify({ bound: BOUND_MS, slack: CLOCK_SLACK_MS, ...order, out }));
  await say(bot, text, turns);
  return JSON.parse(readFileSync(dataFile(out), 'utf8')) as { status?: number; result?: Record<string, unknown>; error?: string; waits?: Array<{ granted: number; left: number }>; asks?: number[] };
}

beforeAll(async () => {
  const anchor = 'emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "Hello from late", threadId: turn.threadId, turnId });';
  // the turn log line is written when the turn's work is over; an ordered turn first sends its one save
  const replacement = `{
    const orderFile = savePath.join(process.env.MURAGE_DATA_DIR, 'memsave-bound-order.json'), turnLog = savePath.join(process.env.MURAGE_DATA_DIR, 'memsave-bound-turns.log');
    if (saveFs.existsSync(orderFile)) {
      const order = JSON.parse(saveFs.readFileSync(orderFile, 'utf8')); saveFs.rmSync(orderFile);
      const write = value => saveFs.writeFileSync(savePath.join(process.env.MURAGE_DATA_DIR, order.out), JSON.stringify(value));
      void (async () => {
        const env = turn.integrations?.memory?.env;
        if (!env) throw Error('fixture memory mount missing');
        const db = saveDb(), exec = db.exec.bind(db), waits = [];
        if (order.poison) {
          // a lone surrogate escape is valid JSON but does not decode as UTF-8 once the text is read as bytes (jobs-reliability.test.ts)
          const hit = db.prepare("UPDATE memory_source_versions SET payload=? WHERE json_extract(payload,'$.text')=?").run(order.poison.payload, order.poison.line);
          if (Number(hit.changes) !== 1) throw Error('fixture poison target missing');
        }
        // Each lock wait the save asks for is read where it is handed to SQLite (PRAGMA busy_timeout on the server's own handle; the
        // handle's own wait is not an ask). asks: every one. waits: those of the capture step, with what was left of its bound then;
        // the step starts at its first ask, which is its whole bound, and is over at the first transaction with the handle's own wait.
        // lockCostMs: every write lock the capture step takes costs that much real time (a busy store).
        const pause = new Int32Array(new SharedArrayBuffer(4)), asks = [];
        let start, budgeted = false, over = false;
        db.exec = sql => {
          const asked = /^PRAGMA busy_timeout=(\\d+)$/.exec(sql), now = performance.now(), granted = asked ? Number(asked[1]) : saveDefaultBusy;
          if (granted !== saveDefaultBusy) asks.push(granted);
          if (granted !== saveDefaultBusy && !over && (start !== undefined || granted >= order.bound - order.slack)) { start ??= now; budgeted = true; waits.push({granted, left: Math.max(0, order.bound - (now - start))}); }
          const result = exec(sql);
          if (sql === 'BEGIN IMMEDIATE' && start !== undefined && !over) { if (!budgeted) over = true; else if (order.lockCostMs) Atomics.wait(pause, 0, 0, order.lockCostMs); budgeted = false; }
          return result;
        };
        const sent = performance.now();
        try {
          const response = await fetch(new URL('/api/internal/memory/save', env.MURAGE_HARNESS_URL), {
            method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + saveSecret('MURAGE_MEMORY_TOKEN', env)},
            body: JSON.stringify(order.body)
          });
          write({status: response.status, result: await response.json(), waits, asks, ms: Math.round(performance.now() - sent)});
        } finally { db.exec = exec; }
      })().catch(error => write({error: String(error)})).finally(() => {
        emit({type:'item.completed',itemType:'assistant_text',origin:'engine',text:'save sent',threadId:turn.threadId,turnId});
        active.delete(turn.threadId);
        emit({type:'turn.completed',ok:true,threadId:turn.threadId,turnId});
        saveFs.appendFileSync(turnLog, turnId + '\\n');
      });
      return;
    }
    saveFs.appendFileSync(turnLog, turnId + '\\n');
  }
  ${anchor}`;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    registerHooks({load(url, context, next) {
      if (url.endsWith('/memory/worker-controller.ts')) {
        // the starved worker: its every claim of queued work finds no room, as the field log shows for capture (BG_DEFERRED)
        const source = fs.readFileSync(new URL(url),'utf8'), claim = 'claimMemoryJob(this.owner';
        if (source.split(claim).length - 1 < 5) throw Error('worker claim fixture anchor changed');
        return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(claim,'((..._starved:unknown[])=>null)(this.owner')};
      }
      if (!url.endsWith('/fake-late-terminal-driver.ts')) return next(url,context);
      let source = "import * as saveFs from 'node:fs'; import * as savePath from 'node:path'; import {turnSecret as saveSecret} from '../turn-credential.ts'; import {database as saveDb} from '../database.ts'; import {DEFAULT_BUSY_MS as saveDefaultBusy} from '../db-busy.ts';\\n" + fs.readFileSync(new URL(url),'utf8');
      if (!source.includes(${JSON.stringify(anchor)})) throw Error('fake engine fixture anchor changed');
      return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(${JSON.stringify(anchor)},${JSON.stringify(replacement)})};
    }});
    const {BUILT_IN_DRIVERS} = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    const {makeLateTerminalDriver} = await import(${JSON.stringify(new URL('./testing/fake-late-terminal-driver.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(makeLateTerminalDriver());
    const file = path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.memsave = {driver:'fakeLateTerminal',environment:{FAKE_LATE_MEMORY_MCP:'1'}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
}, 120000);

afterAll(async () => { await fixture?.close(); });

let turns = 0;
async function bot(name: string, level: Record<string, unknown>) {
  const created = await api('POST', '/api/bots', { name, modelSelection: { instanceId: 'memsave', model: 'late-1' } });
  expect(created.status).toBe(201);
  expect((await raiseLevel(api, created.body.bot.id, level)).status).toBe(200);
  return created.body.bot as { id: string; threadId: string };
}

it('W8-HTTP a save over HTTP that ends on the owner\'s card runs the capture step once: one bound, never a fresh one for the base path', async () => {
  const b = await bot('Memsave bound card', { fullAccess: true, acknowledgeFullAccess: true });
  // three owner lines of 15 slices each: more capture than one step can do (32 slices), so a second run of the step has work left
  const leads = ['Alpha prefers tea.', 'Bravo prefers coffee.', 'Charlie prefers water.'];
  for (const lead of leads) await say(b, lead + 'x'.repeat(15 * SLICE - Buffer.byteLength(lead)), ++turns);
  const before = leads.map(lead => jobOf(lead).cursor);
  const saved = await orderedSave(b, 'Save what I prefer.', ++turns, { out: 'w8', body: { text: 'Alpha prefers tea.', evidence: leads.map(quote => ({ quote })), idempotencyKey: 'three-large' } });
  // A run of the step starts by asking for its whole bound and then only ever asks for what is left of it. On a real clock the 250 ms
  // end a run before its 32 slices do, so a second run shows as a second whole bound asked for after the first was spent.
  const whole = (saved.asks ?? []).map(granted => granted >= BOUND_MS - CLOCK_SLACK_MS && granted <= BOUND_MS);
  expect({ error: saved.error, runs: whole.filter((fresh, index) => fresh && !whole[index - 1]).length }).toEqual({ error: undefined, runs: 1 });
  // the one run did capture for this save, and left work a second run would have taken
  const jobs = leads.map(lead => jobOf(lead));
  expect({ captured: jobs[0].cursor > before[0], open: jobs.some(job => job.status !== 'complete'), leased: jobs.map(job => job.lease_owner) }).toEqual({ captured: true, open: true, leased: [null, null, null] });
  // and this save did take the path that used to run it twice: the owner has its card, the record waits as a candidate
  expect(saved).toMatchObject({ status: 200, result: { candidateId: expect.any(String), state: 'candidate', pendingReview: true } });
}, 120000);

it('W9-HTTP a cited job that cannot be read costs a save over HTTP no lock wait beyond what is left of its bound, and is failed once', async () => {
  const b = await bot('Memsave bound poison', { noLimits: true, acknowledgeNoLimits: true });
  const line = 'abc is the fixture word.';
  const saved = await orderedSave(b, line, ++turns, { out: 'w9', lockCostMs: LOCK_COST_MS,
    poison: { line, payload: '{"text":"abc \\ud800 def"}' }, body: { text: 'abc', evidence: [{ quote: 'abc' }], idempotencyKey: 'poisoned' } });
  const waits = saved.waits ?? [];
  expect({ error: saved.error, status: saved.status, overBound: waits.filter(wait => wait.granted > wait.left + CLOCK_SLACK_MS) }).toEqual({ error: undefined, status: 200, overBound: [] });
  // the step did run and met the poisoned job: the reset, the claim, and the one transaction that failed the job
  expect(waits.map(wait => wait.granted >= BOUND_MS - CLOCK_SLACK_MS ? 'bound' : wait.granted <= BOUND_MS - LOCK_COST_MS ? 'rest' : 'other')).toEqual(['bound', 'rest', 'rest']);
  expect(rows("SELECT status,error FROM memory_jobs WHERE stage='capture' AND status='failed'")).toEqual([{ status: 'failed', error: 'INVALID_SOURCE_UTF8' }]);
}, 120000);
