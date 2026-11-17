// Q4 is the sole host-level qualification. Each run owns exactly two containers.
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {checkContainment} from '../observe.mjs';
const dir=resolve(process.argv[3]??'.afix-evidence/r3/egress');mkdirSync(dir,{recursive:true});
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const rows=[];
for(const [id,mutant]of [['Q4','none'],['M91','wildcard'],['M92','bridge'],['M94','unreachable'],['M95','dns']]){
 const report=join(dir,`${id}.json`);
 execFileSync('bash',[new URL('./provision.sh',import.meta.url).pathname,report,sha,mutant],{stdio:['ignore','pipe','pipe'],timeout:120000});
 const r=JSON.parse(readFileSync(report)),accepted=checkContainment(r,{candidateSha:sha}),pass=id==='Q4'?accepted:!accepted;
 rows.push({id,pass,accepted,evidence:report});
 if(!pass)throw Error(`${id} containment qualification failed`);
}
const timeout=JSON.parse(readFileSync(join(dir,'Q4.json')));timeout.direct.reason='timeout';
writeFileSync(join(dir,'M93.json'),JSON.stringify(timeout,null,2)+'\n');rows.push({id:'M93',pass:!checkContainment(timeout,{candidateSha:sha}),accepted:checkContainment(timeout,{candidateSha:sha})});
writeFileSync(join(dir,'summary.json'),JSON.stringify({candidateSha:sha,verdict:rows.every(r=>r.pass)?'PASS':'FAIL',rows},null,2)+'\n');
if(rows.some(r=>!r.pass))process.exitCode=1;
