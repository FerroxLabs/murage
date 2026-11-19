// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-e. Consumer owner: MAIN (R7 terminal ordering).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchMemoryVerificationServer, waitForMemoryFixtureWindow } from './testing/memory-verification-fixture.ts';
import { POWER_BLOCK_UNWRAP_SOURCE } from './testing/power-block-test.ts';

for (const engine of ['claude', 'acp', 'synchronous', 'duplicate', 'throwing', 'refused'] as const) for (const room of [false, true]) {
  it(`${engine} ${room ? 'room' : 'direct'}: terminal source commits under its live matched generation before revoke and idle`, async () => {
    const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
    const fixture = await launchMemoryVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      await import(${url('server/testing/fake-engine-env-preload.mjs')});
      await import(${url('server/testing/idle-load-preload.mjs')});
      if (${JSON.stringify(engine)}==='synchronous') {
        const {registerHooks}=await import('node:module');
        registerHooks({load(url,context,next){
          const result=next(url,context);
          if(!url.endsWith('/server/testing/fake-late-terminal-driver.ts'))return result;
          const source=String(result.source),start='            setTimeout(() => {',end='            }, 25);';
          if(!source.includes(start)||!source.includes(end))throw Error('synchronous fixture entry moved');
          return {...result,source:source.replace(start,'            (() => {').replace(end,'            })();')};
        }});
        const {BUILT_IN_DRIVERS}=await import(${url('server/drivers/builtIn.ts')});
        const {makeLateTerminalDriver}=await import(${url('server/testing/fake-late-terminal-driver.ts')});
        BUILT_IN_DRIVERS.push(makeLateTerminalDriver({fencedDefaults:true}));
      }
      const fs=await import('node:fs'),path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));
      if (${JSON.stringify(engine)}==='acp') config.instances.verification={driver:'grokAgent',config:{cli:${JSON.stringify(join(process.cwd(), 'server/testing/fake-acp-cli.ts'))}},environment:{
        FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized'}};
      if (${JSON.stringify(engine)}==='synchronous') config.instances.verification={driver:'fakeLateTerminal',config:{}};
      fs.writeFileSync(file,JSON.stringify(config));
      const {InternalCapabilities}=await import(${url('server/internal-capabilities.ts')});
      const {Store}=await import(${url('server/store.ts')});
      const {database}=await import(${url('server/database.ts')});
      const {IoBudget}=await import(${url('server/io-budget.ts')});
      let refusals=0;
      if (${JSON.stringify(engine)}==='refused') {
        const admit=IoBudget.prototype.admit;
        IoBudget.prototype.admit=function(...args){
          if(args[0]==='BG'&&this.currentSource()==='memory-terminal'){refusals++;return null;}
          return admit.apply(this,args);
        };
      }
      if (${JSON.stringify(engine)}==='duplicate') {
        const {EventBus}=await import(${url('server/harness/bus.ts')});
        const subscribe=EventBus.prototype.subscribeExecution;
        EventBus.prototype.subscribeExecution=function(listener,...args){
          if(String(listener).includes('observeOwnerLimitProvider(event)'))return subscribe.call(this,event=>{listener(event);if(event.type==='turn.completed')listener(event);},...args);
          return subscribe.call(this,listener,...args);
        };
      }
      const owners=new Map(),trace=row=>fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'terminal-order.jsonl'),JSON.stringify(row)+'\\n');
      const begin=InternalCapabilities.prototype.begin;
      InternalCapabilities.prototype.begin=function(bot,thread,...rest){const result=begin.call(this,bot,thread,...rest);owners.set(thread,this);return result;};
      const mark=Store.prototype.markTerminalAssistantMessage;
      const thrown=new Set();
      Store.prototype.markTerminalAssistantMessage=function(thread,turn,outcome,...rest){
        const registry=owners.get(thread),generation=registry?.activeGeneration(thread);
        const live=Boolean(generation&&registry.dispatchingGeneration(thread,turn)===generation);
        if (${JSON.stringify(engine)}==='throwing'&&!thrown.has(thread)) {
          thrown.add(thread);trace({step:'marker',thread,turn,outcome,live,source:false});throw Error('fixture terminal persistence failed');
        }
        const result=mark.call(this,thread,turn,outcome,...rest);
        const source=result?database().prepare('SELECT id,revision FROM memory_sources WHERE id=?').get('message:'+thread+':'+result.id):undefined;
        trace({step:'marker',thread,turn,outcome,live,source:Boolean(source)});return result;
      };
      const complete=InternalCapabilities.prototype.completeProviderTurn;
      InternalCapabilities.prototype.completeProviderTurn=function(thread,turn){
        const db=database(),job=db.prepare("SELECT j.id,j.status,j.cursor,j.coverage FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.stage_version='1' WHERE s.thread_id=? AND s.turn_id=? AND s.kind='text' AND s.message_id IS NOT NULL AND s.speaker!='owner'").get(thread,turn);
        const publication=job&&db.prepare('SELECT record_id FROM memory_checkpoint_publications WHERE job_id=?').get(job.id);
        complete.call(this,thread,turn);trace({step:'revoke',thread,turn,live:Boolean(this.activeGeneration(thread)),capture:job?.status,coverage:job?.coverage,checkpoint:Boolean(publication),refusals});
      };
    ` });
    try {
      const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
      const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret }, body: body === undefined ? undefined : JSON.stringify(body) });
        expect(response.ok).toBe(true); return await response.json() as any;
      };
      const { bot } = await api('POST', '/api/bots', { name: 'Terminal fixture' });
      await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false });
      const target = room ? (await api('POST', '/api/groups', { name: 'Terminal room', memberIds: [bot.id], setup: { bulletin: '', defaultResponder: { kind: 'member', botId: bot.id } } })).group : bot;
      await waitForMemoryFixtureWindow();
      await api('POST', room ? `/api/groups/${target.id}/messages` : `/api/bots/${bot.id}/messages`, { threadId: target.threadId, text: 'The fixture garden gate is green.' });
      const trace = () => {
        const file = join(fixture.info.dataDir, 'terminal-order.jsonl');
        return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.thread === target.threadId) : [];
      };
      await expect.poll(() => trace().some(row => row.step === 'marker'), { timeout: 45_000 }).toBe(true);
      await expect.poll(async () => {
        const state = await api('GET', '/api/bots?messages=0');
        return room ? Boolean(state.groups.find((g: any) => g.id === target.id)?.busyBotId) : Boolean(state.bots.find((b: any) => b.id === bot.id)?.busy);
      }, { timeout: 15_000 }).toBe(false);
      const rows = trace();
      expect(rows.map(row => row.step)).toEqual(engine === 'duplicate' ? ['marker', 'revoke', 'revoke'] : ['marker', 'revoke']);
      expect(rows[0]).toMatchObject({ outcome: 'completed', live: true, source: engine !== 'throwing' });
      expect(rows[1]).toMatchObject({ turn: rows[0].turn, live: false });
      if (engine !== 'throwing' && engine !== 'refused') {
        expect(rows[1], JSON.stringify(rows)).toMatchObject({ capture: 'complete', checkpoint: true });
        const coverage=JSON.parse(rows[1].coverage);
        expect(coverage.throughByte).toBe(coverage.totalBytes);
      }
      if (engine === 'refused') expect(rows[1]).toMatchObject({ capture: 'pending', checkpoint: false, refusals: 1 });
    } finally { await fixture.close(); }
  }, 90_000);
}
