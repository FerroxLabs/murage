// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: MAIN (dispatch/terminal); consumer owner: recall-fix-h (native qualification).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';
import { waitForMemoryFixtureWindow } from './testing/memory-verification-fixture.ts';

for (const engine of ['claude', 'acp'] as const) for (const kind of ['direct', 'room', 'routine', 'delegation', 'peer', 'webhook', 'channel'] as const) {
  it(`${engine} ${kind}: the native terminal commits once under its original live generation and kills its tokens`, async () => {
    const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
    const w = await proofWorld(engine, 'none', `
      const {registerHooks:kindHooks}=await import('node:module');
      kindHooks({load(url,context,next){
        const result=next(url,context);if(!url.endsWith('/server/index.ts'))return result;
        const needle='function recordDecisionProvenance(provenance: TurnProvenance): void {';
        if(!String(result.source).includes(needle))throw Error('fixture provenance entry moved');
        return {...result,source:String(result.source).replace(needle,needle+'(globalThis.fixtureTerminalKinds??=new Map()).set(provenance.generation,provenance.initiator.k);')};
      }});
      const kindFs=await import('node:fs'),kindPath=await import('node:path');
      const configFile=kindPath.join(process.env.MURAGE_DATA_DIR,'config.json'),kindConfig=JSON.parse(kindFs.readFileSync(configFile,'utf8'));
      kindConfig.instances.delegator={driver:'grokAgent',config:{cli:${JSON.stringify(join(process.cwd(), 'server/testing/fake-acp-cli.ts'))}},environment:{FAKE_ACP_MODE:${JSON.stringify(kind === 'peer' ? 'ask-peer' : 'delegate-peer')},FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized'}};
      kindFs.writeFileSync(configFile,JSON.stringify(kindConfig));
      if (${JSON.stringify(kind)}==='channel') {
        process.env.FAKE_TELEGRAM_DIR=kindPath.join(process.env.MURAGE_DATA_DIR,'telegram-fixture');
        kindFs.mkdirSync(process.env.FAKE_TELEGRAM_DIR);
        await import(${url('server/testing/telegram-fetch-preload.mjs')});
      }
      const {InternalCapabilities:KindCapabilities}=await import(${url('server/internal-capabilities.ts')});
      const {Store:KindStore}=await import(${url('server/store.ts')});
      const {database:kindDatabase}=await import(${url('server/database.ts')});
      const owners=new Map(),tokens=new Map();
      const trace=row=>kindFs.appendFileSync(kindPath.join(process.env.MURAGE_DATA_DIR,'dispatch-terminals.jsonl'),JSON.stringify(row)+'\\n');
      const begin=KindCapabilities.prototype.begin;
      KindCapabilities.prototype.begin=function(bot,thread,...args){const generation=begin.call(this,bot,thread,...args);owners.set(thread,{registry:this,bot,generation});return generation;};
      const mint=KindCapabilities.prototype.mint;
      KindCapabilities.prototype.mint=function(input){const token=mint.call(this,input);const rows=tokens.get(input.generation)??[];rows.push(token);tokens.set(input.generation,rows);return token;};
      const mark=KindStore.prototype.markTerminalAssistantMessage;
      KindStore.prototype.markTerminalAssistantMessage=function(thread,turn,outcome,...args){
        const owner=owners.get(thread),live=Boolean(owner&&owner.registry.dispatchingGeneration(thread,turn)===owner.generation&&owner.registry.activeGeneration(thread)===owner.generation);
        const result=mark.call(this,thread,turn,outcome,...args);
        trace({step:'marker',bot:owner?.bot,thread,turn,outcome,live,message:result?.id});return result;
      };
      const complete=KindCapabilities.prototype.completeProviderTurn;
      KindCapabilities.prototype.completeProviderTurn=function(thread,turn){
        const owner=owners.get(thread),generation=this.dispatchingGeneration(thread,turn),db=kindDatabase();
        const job=db.prepare("SELECT j.status,j.coverage,j.id FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.stage_version='1' WHERE s.thread_id=? AND s.turn_id=? AND s.kind='text' AND s.speaker!='owner' AND s.message_id IS NOT NULL").get(thread,turn);
        const publication=job&&db.prepare('SELECT 1 FROM memory_checkpoint_publications WHERE job_id=?').get(job.id);
        const live=this.activeGeneration(thread)===generation;
        complete.call(this,thread,turn);
        const minted=tokens.get(generation)??[];
        trace({step:'revoke',bot:owner?.bot,thread,turn,kind:globalThis.fixtureTerminalKinds?.get(generation),live,dead:this.activeGeneration(thread)!==generation,minted:minted.length,survivors:minted.filter(token=>this.resolve('Bearer '+token)).length,status:job?.status,coverage:job?.coverage,checkpoint:Boolean(publication)});
      };
    `);
    try {
      for (const bot of (await w.api('GET', '/api/bots?messages=0')).bots) await w.api('PATCH', `/api/bots/${bot.id}`, { hidden: true });
      const target = await w.bot();
      await w.api('PATCH', `/api/bots/${target.id}`, { name: 'Helper' });
      await waitForMemoryFixtureWindow();
      if (kind === 'direct') await w.api('POST', `/api/bots/${target.id}/messages`, { text: 'Say the fixture garden gate is green.' });
      else if (kind === 'room') {
        const { group } = await w.api('POST', '/api/groups', { name: 'Terminal room', memberIds: [target.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: target.id } } });
        await w.api('POST', `/api/groups/${group.id}/messages`, { text: 'Say the fixture garden gate is green.' });
      } else if (kind === 'routine') {
        const { routine } = await w.api('POST', '/api/routines', { botId: target.id, name: 'Terminal fixture', prompt: 'Say the fixture garden gate is green.', enabled: false, permissionMode: 'ask', schedule: { type: 'interval', everyMinutes: 60, anchorAt: Date.now() } });
        await w.api('POST', `/api/routines/${routine.id}/run`, {});
      } else if (kind === 'webhook') {
        const { credential } = await w.api('POST', '/api/webhooks', { name: 'Terminal event', prompt: 'Say the fixture garden gate is green.', botId: target.id, runOn: 'ember' });
        const response = await fetch(credential.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'fixture' }) });
        expect(response.status).toBe(202);
      } else if (kind === 'channel') {
        await w.api('PATCH', `/api/bots/${target.id}`, { chiefOfStaff: true, chiefScope: 'workspace' });
        await w.api('PATCH', '/api/config', { telegram: { botToken: '123:' + 'a'.repeat(32) } });
        const pair = await w.api('POST', '/api/telegram/pair', { targetBotId: target.id });
        const updates: unknown[] = [];
        const arrives = (id: number, text: string) => {
          updates.push({ update_id: id, message: { message_id: id, date: 1_700_000_000 + id, text, from: { id: 777, is_bot: false }, chat: { id: 777, type: 'private' } } });
          const file = join(w.fixture.info.dataDir, 'telegram-fixture', 'updates.json');
          writeFileSync(file + '.tmp', JSON.stringify(updates)); renameSync(file + '.tmp', file);
        };
        arrives(1, `/pair ${pair.code}`);
        await expect.poll(async () => (await w.api('GET', '/api/telegram/status')).paired, { timeout: 15_000 }).toBe(true);
        const { bindings } = await w.api('POST', '/api/memory/action', { action: 'humans' });
        expect(bindings).toHaveLength(1);
        await w.api('POST', '/api/memory/action', { action: 'human-link', bindingId: bindings[0].id, expectedRevision: bindings[0].revision, as: 'owner' });
        arrives(2, 'Say the fixture garden gate is green.');
      } else {
        const instance = (await w.api('GET', '/api/instances')).instances.find((row: any) => row.instanceId === 'delegator');
        const { bot: sender } = await w.api('POST', '/api/bots', { name: 'Sender', modelSelection: { instanceId: 'delegator', model: instance.models.options[0].id } });
        await w.api('PATCH', `/api/bots/${sender.id}`, { computer: 'off', browser: false, composio: false });
        await w.api('POST', `/api/bots/${sender.id}/messages`, { text: 'Hey @Helper please pick this up.' });
      }
      const rows = () => {
        const file = join(w.fixture.info.dataDir, 'dispatch-terminals.jsonl');
        return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.bot === target.id) : [];
      };
      await expect.poll(() => rows().filter(row => row.step === 'revoke').length, { timeout: 45_000 }).toBe(1);
      const trace = rows();
      expect(trace.map(row => row.step)).toEqual(['marker', 'revoke']);
      expect(trace[0]).toMatchObject({ outcome: 'completed', live: true });
      expect(trace[0].message).toBeTruthy();
      const initiator = kind === 'routine' ? 'routine-run' : kind === 'channel' ? 'owner-channel-dm' : kind === 'direct' || kind === 'room' ? 'owner-typed' : kind;
      expect(trace[1]).toMatchObject({ turn: trace[0].turn, kind: initiator, live: true, dead: true, survivors: 0, status: 'complete', checkpoint: true });
      expect(trace[1].minted).toBeGreaterThan(0);
      const coverage = JSON.parse(trace[1].coverage);
      expect(coverage.throughByte).toBe(coverage.totalBytes);
      console.log(JSON.stringify({ engine, kind, trace }));
    } finally { await w.fixture.close(); }
  }, 90_000);
}
