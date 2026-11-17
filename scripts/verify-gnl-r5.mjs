// Comparable complete decision runs in disposable source/data fixtures.
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [mode, shard, total = '6'] = process.argv.slice(2);
const source=process.cwd(), out=resolve(`evidence/gnl-prod-r5/${mode}/${shard}`);
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-r5-'));
try {
 const files=JSON.parse(readFileSync('evidence/gnl-prod-r5/files.json'));
 for(const file of files)if(existsSync(file)&&!file.startsWith('evidence/gnl-prod-r5/')){
  mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(file,join(root,file));
 }
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const baseline=JSON.parse(readFileSync('evidence/gnl-prod-r5/baseline-runtime.json'));
 if(mode.startsWith('baseline')){
  for(const [file,record]of Object.entries(baseline.files))writeFileSync(join(root,file),record.bytes);
  for(const [file,bytes]of Object.entries(JSON.parse(readFileSync('evidence/gnl-prod-r5/original-assertions.json'))))writeFileSync(join(root,file),bytes);
 }
 const hashes=Object.fromEntries(Object.keys(baseline.files).map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
 if(mode.startsWith('baseline'))for(const [file,record]of Object.entries(baseline.files))if(hashes[file]!==record.sha256)throw Error('Baseline bytes differ: '+file);
 const all=JSON.parse(readFileSync(`evidence/gnl-prod-r5/${process.env.GNL_TEST_LIST??'tests.json'}`));
 const tests=all.filter((_,i)=>i%Number(total)===Number(shard));
 mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'manifest.json'),JSON.stringify({mode,shard,total,base:baseline.base,runtimeHashes:hashes,testHashes:Object.fromEntries(tests.map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])),tests},null,2));
 const r=spawnSync('pnpm',['exec','vitest','run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')],{cwd:root,encoding:'utf8',timeout:65*60_000,maxBuffer:100*1024*1024});
 writeFileSync(join(out,'run.log'),(r.stdout??'')+(r.stderr??''));
 if(existsSync(join(root,'.gnl-proof/evidence')))cpSync(join(root,'.gnl-proof/evidence'),join(out,'workflow'),{recursive:true});
 writeFileSync(join(out,'rc.json'),JSON.stringify({status:r.status,error:r.error?.message}));
 process.exitCode=r.status??1;
}finally{if(!root.startsWith(join(tmpdir(),'gnl-r5-')))throw Error('Unexpected root');rmSync(root,{recursive:true,force:true});}
