import { assertExternalEvidencePath, evidencePath } from './evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run inside the network-disabled test container. Mutate only a temp copy.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const out=assertExternalEvidencePath(resolve(process.argv[2]??evidencePath('evidence/wipe-final-r7/mutant')));
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'wipe-stage-mutant-'));
const source=readFileSync('shared/no-limits-raw-wipe.ts','utf8');
const mutant=source.replace('if(piped&&unsafeStage(normalized,start,i))return true;','if(false)return true;')
 .replace('return piped&&unsafeStage(normalized,start,normalized.length);','return false;');
if(mutant===source||mutant.includes('return piped&&unsafeStage'))throw Error('Stage mutation anchor missing');
const hash=s=>createHash('sha256').update(s).digest('hex');
const proof={sourceSha256:hash(source),mutantSha256:hash(mutant),runs:[],killed:false};
try{
 mkdirSync(join(root,'shared'));
 symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
 writeFileSync(join(root,'package.json'),'{"type":"module"}');
 writeFileSync(join(root,'vitest.config.mjs'),'export default {test:{environment:"node",include:["shared/*.test.ts"],fileParallelism:false}};');
 writeFileSync(join(root,'shared/no-limits-raw-wipe.test.ts'),readFileSync('shared/no-limits-raw-wipe.test.ts'));
 for(const [id,text]of [['baseline',source],['stage-disabled',mutant],['restored',source]]){
  writeFileSync(join(root,'shared/no-limits-raw-wipe.ts'),text);
  writeFileSync(join(out,id+'-source.txt'),text);
  const report=join(out,id+'.json');
  const result=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--reporter=json','--outputFile='+report],{cwd:root,env:process.env,encoding:'utf8',timeout:120000});
  writeFileSync(join(out,id+'.log'),(result.stdout??'')+(result.stderr??''));
  const data=existsSync(report)?JSON.parse(readFileSync(report,'utf8')):null;
  const failures=data?.testResults.flatMap(file=>file.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName))??[];
  proof.runs.push({id,status:result.status,passed:data?.numPassedTests,failed:data?.numFailedTests,failures});
 }
 const [base,red,restored]=proof.runs;
 proof.killed=base.status===0&&red.status===1&&red.failures.some(name=>name.includes('N2 reviews hold independently'))&&restored.status===0;
 if(!proof.killed)throw Error('Invalid mutation proof');
 process.stdout.write(JSON.stringify(proof,null,2)+'\n');
}finally{
 writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
 safeWipeSync(root,{reason:'isolated wipe stage mutation fixture'});
}
