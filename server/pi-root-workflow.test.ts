// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: registry authority — wipe-fable / wg-final; inventory producer and verification consumer — pi-roots-b.
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {launchVerificationServer,runControlMurage} from '../scripts/control-murage.ts';

it('an isolated fake-engine conversation dispatches with a complete current inventory',async()=>{
 const session=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  import {inventoryPath} from ${JSON.stringify(new URL('./pi-root-inventory.ts',import.meta.url).href)};
  import {writeFileSync} from 'node:fs';
  import {join} from 'node:path';
  writeFileSync(join(process.env.MURAGE_DATA_DIR,'fixture-inventory-path'),inventoryPath());
 `});
 try{
  const path=readFileSync(join(session.info.dataDir,'fixture-inventory-path'),'utf8');
  const before=readFileSync(path,'utf8');expect(before.split('\n')[0]).toContain(' R ');
  const env={MURAGE_URL:session.info.url};
  const doctor=await runControlMurage(['doctor'],{env}) as any;expect(doctor.ok).toBe(true);expect(doctor.availableEngines).toEqual(['verification']);
  const {bot}=await runControlMurage(['new-bot','--name','Fixture'],{env}) as any;
  const sent=await runControlMurage(['send','--bot',bot.id,'--text','Reply with the fixture result.'],{env});
  const settled=await runControlMurage(['wait','--bot',bot.id,'--timeout','20'],{env}) as any;expect(settled.status).toBe('settled');
  const transcript=await runControlMurage(['messages','--bot',bot.id,'--limit','10'],{env}) as any;expect(transcript.messages.some((message:{role?:string})=>message.role==='bot')).toBe(true);
  const after=readFileSync(path,'utf8');expect(after.split('\n')[0]).toContain(' R ');expect(after.split('\n')[0]).not.toBe(before.split('\n')[0]);
  const roots=JSON.parse(after.split('\n').slice(1).join('\n')) as string[];expect(roots.length).toBeGreaterThan(0);
  console.info('pi-roots isolated workflow',JSON.stringify({sent,settled,transcript,inventoryRoots:roots.length}));
 }finally{await session.close();}
 expect(existsSync(session.info.dataDir)).toBe(false);
},120_000);
