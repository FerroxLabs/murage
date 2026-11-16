// Isolated comparable runs. Historical runtime bytes are restored, assertions retained.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const mode=process.argv[2],out=resolve(process.argv[3]);mkdirSync(out,{recursive:true});
const source=process.cwd(),root=mkdtempSync(join(tmpdir(),'gnl-r3-compare-'));
try {
 const files=JSON.parse(readFileSync('evidence/gnl-prod/fixture-files.json','utf8'));
 for(const file of files)if(existsSync(file)){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));}
 // Include current new regressions without dropping any historical fixture input.
 for(const file of ['server/decision/product-origin.test.ts','server/routine-permissions.test.ts'])cpSync(join(source,file),join(root,file));
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const baseline=JSON.parse(readFileSync('evidence/gnl-prod/baseline-files.json','utf8'));
 if(mode==='baseline'||mode==='red-start'||mode==='baseline-reconcile'||mode==='baseline-extra')for(const [file,content]of Object.entries(baseline.files))if(content!==null&&!file.endsWith('.test.ts'))writeFileSync(join(root,file),content);
 const runtime=JSON.parse(readFileSync('evidence/gnl-prod-r3/baseline-runtime.json','utf8'));
 if(mode.startsWith('baseline')||mode==='red-start')for(const [file,record]of Object.entries(runtime.files))writeFileSync(join(root,file),record.bytes);
 const runtimeHashes=Object.fromEntries(Object.keys(runtime.files).map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
 if(mode.startsWith('baseline')||mode==='red-start')for(const [file,record]of Object.entries(runtime.files))if(runtimeHashes[file]!==record.sha256)throw Error('Historical bytes mismatch: '+file);
 const tests=mode.endsWith('-hooks')?['server/decision/no-limits-answer-key-1019.test.ts','server/decision/production-claude-shell-wiring.test.ts','server/decision-wiring/server-fixture.test.ts']:mode==='baseline-extra'?['server/routine-authority.test.ts','server/peer-approval.test.ts','server/routine-run-permissions.test.ts']:mode==='baseline-reconcile'?['server/decision/no-limits-merge-rulings.test.ts']:mode==='red-start'?['server/drivers/antigravity.test.ts','server/drivers/antigravity-auto.test.ts','server/drivers/boxagent.test.ts','server/drivers/muse-code.test.ts','server/drivers/codex.test.ts','server/drivers/pi.test.ts','server/drivers/openai-chat.test.ts','server/no-limits-inheritance.test.ts','server/product-permission-wire-api.test.ts','server/decision/product-origin.test.ts']:JSON.parse(readFileSync('evidence/gnl-prod-r3/decision-tests.json','utf8'));
 // Final and baseline use exactly the same test bytes, list, flags, and frozen proof assets.
 writeFileSync(join(out,'manifest.json'),JSON.stringify({mode,base:baseline.base,runtimeHashes,testHashes:Object.fromEntries(tests.map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])),tests,restored:Object.keys(baseline.files).filter(f=>!f.endsWith('.test.ts'))},null,2));
 const r=spawnSync('pnpm',['exec','vitest','run',...tests,...(process.argv[4]?['--shard='+process.argv[4]]:[]),'--maxWorkers=2',...(mode.endsWith('-hooks')?['--reporter=default']:[]),'--reporter=json','--outputFile='+join(out,'results.json')],{cwd:root,encoding:'utf8',timeout:40*60_000,maxBuffer:100*1024*1024});
 if(mode.endsWith('-hooks')){
  const logs=[...new Set(((r.stdout??'')+(r.stderr??'')).match(/\/tmp\/murage-verification-evidence\/server-[0-9-]+\.log/g)??[])];
  mkdirSync(join(out,'server-logs'),{recursive:true});
  for(const file of logs)if(existsSync(file))cpSync(file,join(out,'server-logs',file.split('/').at(-1)));
  writeFileSync(join(out,'failed-server-logs.json'),JSON.stringify(logs));
 }
 writeFileSync(join(out,'run.log'),(r.stdout??'')+(r.stderr??''));writeFileSync(join(out,'rc.json'),JSON.stringify({status:r.status,error:r.error?.message}));
 process.exitCode=r.status??1;
}finally{if(!root.startsWith(join(tmpdir(),'gnl-r3-compare-')))throw Error('Unexpected root');rmSync(root,{recursive:true,force:true});}
