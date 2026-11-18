// Public synthetic operations only. This worker never opens the private corpus.
import fs from 'node:fs';
import fsp,{writeFile as namedWriteFile,appendFile as namedAppendFile} from 'node:fs/promises';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerHooks} from 'node:module';
console.log=console.info=console.warn=console.error=()=>{};
const cleanup=fs.rmSync;
const root=mkdtempSync(join(tmpdir(),'gnl-private-check-')),home=join(root,'home'),data=join(root,'data');mkdirSync(home);mkdirSync(data);
Object.assign(process.env,{HOME:home,MURAGE_DATA_DIR:data,NODE_ENV:'test'});
const probeHook=registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/server/decision-log.ts'))return {...result,source:Buffer.from("import {writeFileSync as gnlCachedWriter} from 'node:fs';globalThis[Symbol.for('gnl.synthetic.cachedWriter')]=gnlCachedWriter;\n"+String(result.source)),shortCircuit:true};return result;}});
try{
 const {privateProductionAdapter}=await import('./private-production.mjs');
 const a=await privateProductionAdapter({home});
 const row={tool:'Bash',cardClass:{origin:'owner',unattended:0,automated:0},boundedToolInput:'{"command":"printf synthetic"}'};
 const run=await a.decide(row,{command:'printf synthetic'});
 // Public synthetic rows prove that historical hints cannot demote the
 // owner's replay. A protected destination distinguishes No limits from Ask.
 let ownerReplays=0;
 for(const origin of ['owner','routine','owner-channel','webhook','other','guest',undefined]){
  const input={command:`printf synthetic > '${join(home,'.ssh','config')}'`};
  const got=await a.decide({...row,cardClass:{origin,unattended:1,automated:1},boundedToolInput:JSON.stringify(input)},input);
  if(got.kind==='run'&&got.actionExecuted===true&&got.cards===0&&got.refusals===0)ownerReplays++;
 }
 const late=await a.decide({...row,updatedInput:{command:'rm -rf ~'}},{command:'printf synthetic'});
 const wipe=await a.decide(row,{command:'rm -rf ~'});
 let blocked=0;
 for(const write of [()=>fs.writeFileSync(join(data,'blocked'),'synthetic'),()=>fs.appendFileSync(join(data,'blocked'),'synthetic'),()=>fsp.writeFile(join(data,'blocked'),'synthetic'),()=>fsp.appendFile(join(data,'blocked'),'synthetic'),()=>namedWriteFile(join(data,'blocked'),'synthetic'),()=>namedAppendFile(join(data,'blocked'),'synthetic'),()=>globalThis[Symbol.for('gnl.synthetic.cachedWriter')](join(data,'blocked'),'synthetic'),()=>new Promise((resolve,reject)=>fs.open(join(data,'blocked-open'),'w',(error,fd)=>error?reject(error):fs.close(fd,resolve))),()=>fs.mkdtempSync(join(data,'synthetic-private-field-'))])try{await write();}catch{blocked++;}
 const report={run:run.kind==='run'&&run.actionExecuted===true?1:0,late:late.kind==='refuse'&&late.refusals===1?1:0,wipe:wipe.kind==='card'&&wipe.cards===1&&wipe.why==='wipe'?1:0,blocked,owner_replays:ownerReplays};
 await a.close();process.stdout.write(JSON.stringify(report)+'\n');process.exitCode=report.run+report.late+report.wipe===3&&blocked===9&&ownerReplays===7?0:1;
}catch{process.stdout.write('{"failed":1}\n');process.exitCode=1;}
finally{probeHook.deregister();cleanup(root,{recursive:true,force:true});}
