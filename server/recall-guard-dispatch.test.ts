// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2 (prepared facts); consumer owner: recall-smoke (provider boundary).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';

for (const venue of ['bot','channel'] as const) for (const field of ['system','tools','history'] as const) {
  it(`S1-T10: ${venue} clearing only ${field} refuses before the provider`, async () => {
    const instrumentationSource = `
      const { registerHooks } = await import('node:module');
      registerHooks({load(url,context,next){
        const result=next(url,context);let text=String(result.source);
        if(url.endsWith('/server/index.ts')) {
          const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
          text=text.replace(needle,needle+\`
            if (built.prompt.text.includes('Fixture follow-up')) {
              built={...built,resumeCursor:undefined,sessionReset:true,recallPrepared:{...built.recallPrepared,historyPrepared:true,resumed:false}};
              ${field==='system' ? "built={...built,system:''};" : field==='tools' ? 'built={...built,integrations:{}};' : venue==='bot' ? 'built={...built,transcript:[]};' : "built={...built,prompt:buildPrompt(undefined,[promptPart('Fixture follow-up',[noneRef('owner-turn')])])};"}
              console.warn('fixture cleared ${field}');
            }
          \`);
        }
        return {...result,source:text};
      }});
    `;
    const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture first reply.','Fixture second reply.']},instrumentationSource});
    const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
    try {
      const bot=(await run(['new-bot','--name','Fixture persona'])).bot;
      const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id;
      const destination=[`--${venue}`,id];
      for(const message of ['Fixture first input','Fixture follow-up']) {
        const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
        expect((await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify({text:message})})).status).toBe(202);
        await run(['wait',...destination,'--timeout','20']);
      }
      const provider=existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim().split('\n'):[];
      const log=readFileSync(fixture.info.logPath,'utf8');
      expect(log).toContain(`fixture cleared ${field}`);
      expect(provider,log.slice(-12000)).toHaveLength(1);
      const rows=await run(['messages',...destination,'--limit','30']);
      expect(JSON.stringify(rows)).toContain('This reply is still being prepared, so this message was not sent. Send it again in a moment.');
      expect((log.match(/turn dispatch recall=/g)??[])).toHaveLength(1);
    } finally {await fixture.close();}
  },60_000);
}
