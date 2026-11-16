import {expect,it} from 'vitest';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchVerificationServer,runControlMurage,controlResultSucceeded} from '../scripts/control-murage.ts';
it('D9 a truncated browser-modes.json boots, warns and retains saved 1.0.18 browser selections',async()=>{
 const damaged='{"version":';
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const fs=await import('node:fs'),path=await import('node:path'),data=process.env.MURAGE_DATA_DIR;
  const {Store}=await import(${JSON.stringify(new URL('./store.ts',import.meta.url).href)}),{flushCoalesced}=await import(${JSON.stringify(new URL('./atomic.ts',import.meta.url).href)});
  const seed=new Store();seed.createBot();await flushCoalesced();
  const file=path.join(data,'bots.json'),bots=JSON.parse(fs.readFileSync(file,'utf8'));
  delete bots[0].browserMode;
  Object.assign(bots[0],{useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:'offline-fixture'});fs.writeFileSync(file,JSON.stringify(bots));
  fs.writeFileSync(path.join(data,'browser-modes.json'),${JSON.stringify(damaged)});
 `});
 try {
  const {secret}=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  const response=await fetch(fixture.info.url+'/api/bots?messages=0',{headers:{'x-murage-surface':'desktop','x-murage-surface-secret':secret}}),body=await response.json() as any;
  expect(response.status).toBe(200);expect(body.bots[0]).toMatchObject({browserMode:'chrome-extension',browserExtensionProfileId:'offline-fixture'});
  expect(readFileSync(join(fixture.info.dataDir,'browser-modes.json.bad'),'utf8')).toBe(damaged);
  expect(readFileSync(fixture.info.logPath,'utf8')).toContain('damaged browser choice state kept as .bad');
  const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);expect(controlResultSucceeded('doctor',doctor)).toBe(true);
  const out=join(process.cwd(),'.data-fix-evidence');mkdirSync(out,{recursive:true});writeFileSync(join(out,'D9-fixture-flow.json'),JSON.stringify({fixture:fixture.info,booted:true,preservedBadFile:true,doctor},null,2));
 }finally{await fixture.close();}
},120000);
