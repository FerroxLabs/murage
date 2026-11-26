import { archivedEvidencePath } from './evidence-path.mjs';
// Observer-only capture in disposable copies; original snapshot assertions still run.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
const source=process.cwd(),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const roots=[];
try{
 const jobs=['baseline','final'].map(mode=>{
  const root=mkdtempSync(join(tmpdir(),'gnl-r3-capture-'));roots.push(root);const dir=join(out,mode);mkdirSync(dir,{recursive:true});
  for(const file of JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod/fixture-files.json'),'utf8'))){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));}
  symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
  if(mode==='baseline')for(const [file,row]of Object.entries(JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod-r3/baseline-runtime.json'),'utf8')).files))writeFileSync(join(root,file),row.bytes);
  const tests=['server/decision/no-limits-x2-full-access.test.ts','server/decision/no-limits-y3b-full-access.test.ts'];
  for(const [i,file]of tests.entries()){
   let code=readFileSync(join(root,file),'utf8');const capture=join(dir,i?'y3b':'x2');mkdirSync(capture,{recursive:true});
   code="import {writeFileSync as captureWrite} from 'node:fs'; let captureIndex=0;\n"+code;
   const anchor=i?' expect({bytes:JSON.stringify(captured),sha256:hash(captured)}).toMatchSnapshot();':' expect(hash(captured)).toMatchSnapshot();';
   if(!code.includes(anchor))throw Error('capture anchor missing');
   code=code.replace(anchor,` captureWrite(${JSON.stringify(capture)}+'/'+(++captureIndex)+'.json',JSON.stringify(captured));\n`+anchor);writeFileSync(join(root,file),code);
  }
  return new Promise(resolve=>{const child=spawn('pnpm',['exec','vitest','run',...tests,'--testNamePattern','unproven','--maxWorkers=1','--reporter=json','--outputFile='+join(dir,'results.json')],{cwd:root,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);child.on('exit',(code,signal)=>{writeFileSync(join(dir,'run.log'),log);resolve({mode,code,signal});});});
 });
 writeFileSync(join(out,'runs.json'),JSON.stringify(await Promise.all(jobs),null,2));
}finally{for(const root of roots){if(!root.startsWith(join(tmpdir(),'gnl-r3-capture-')))throw Error('unexpected root');safeWipeSync(root);}}
