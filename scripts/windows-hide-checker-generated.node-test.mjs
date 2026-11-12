import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { promisify } from 'node:util';
const { inspectChildEntries } = await import(process.env.WINHIDE_CHECKER_URL ?? new URL('./check-windows-hide-entries.mjs', import.meta.url));
// Same Cartesian input table as the runtime differential. Node itself decides
// which shapes reach a native boundary; the checker must reject every selected
// nonliteral options value, including the second-slot fork witness.
test('checker rejects nonliteral inheritance overrides in every Node-accepted generated shape',async()=>{
 const absent=Symbol('absent');
 const kinds=[absent,undefined,null,[],()=>{},{env:{WINHIDE_WITNESS:'yes'},execArgv:[]},'arg',42];
 const texts=['undefined','undefined','null','[]','()=>{}','opts',"'arg'",'42'];
 const nativeAsync=cp.ChildProcess.prototype.spawn,binding=process.binding('spawn_sync'),nativeSync=binding.spawn;
 const stop=Error('native boundary');let selected=false;
 const capture=options=>{selected=options.envPairs?.includes('WINHIDE_WITNESS=yes');throw stop;};
 cp.ChildProcess.prototype.spawn=binding.spawn=capture;
 let accepted=0,checked=0;const missed=[];
 try {
  for(const name of ['spawn','exec','execFile','fork','spawnSync','execSync','execFileSync','promisify:exec','promisify:execFile']) for(let a=0;a<8;a++)for(let b=0;b<8;b++)for(let c=0;c<8;c++) {
   const slots=[a,b,c],args=[process.execPath],code=["'./child.cjs'"];
   for(let i=0;i<3;i++)if(kinds[slots[i]]!==absent){args[i+1]=structured(slots[i]);code[i+1]=texts[slots[i]];}
   for(let i=0;i<code.length;i++)code[i]??='undefined';
   selected=false;let reached=false;
   try{await (name.startsWith('promisify:')?promisify(cp[name.slice(10)]):cp[name])(...args);}catch(e){reached=e===stop;}
   if(!reached)continue;accepted++;
   if(!selected)continue;checked++;
   const api=name.replace('promisify:','');
   const call=name.startsWith('promisify:')?`promisify(${api})` : api;
   const source=`import {${api}} from 'node:child_process';import {promisify} from 'node:util';const opts={env:{},execArgv:[]};${call}(${code.join(',')});`;
   if(!inspectChildEntries('server/generated.ts',source).failures.length) missed.push(source);
  }
 } finally {cp.ChildProcess.prototype.spawn=nativeAsync;binding.spawn=nativeSync;}
 function structured(i){return i===3?[]:i===5?{env:{WINHIDE_WITNESS:'yes'},execArgv:[]}:kinds[i];}
 assert.ok(checked>100);console.log(`4608 shapes; ${accepted} Node-accepted; ${checked} selected nonliteral overrides; ${missed.length} missed`);
 assert.equal(missed.length,0,missed.slice(0,5).join("\n"));
});
