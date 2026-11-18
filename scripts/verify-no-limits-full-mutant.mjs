// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated-container Full access byte-isolation mutant. Restore exact source.
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const file='server/decision/action.ts',original=readFileSync(file,'utf8'),stamp=statSync(file);
const directory='evidence/nlsym/C1-full-mutant';mkdirSync(directory,{recursive:true});
function run(label){
  const result=spawnSync('node_modules/.bin/vitest',['run','server/no-limits-symlink-r31.test.ts'],{
    encoding:'utf8',timeout:60000,env:{...process.env,NLSYM_FULL_ONLY:'1'},
  });
  writeFileSync(`${directory}/${label}.log`,`${result.stdout??''}${result.stderr??''}${result.error??''}`);
  return result.status;
}
if(run('baseline')!==0)throw new Error('Full access baseline must pass');
const from='return freeze({tool,codeIdentity:',to='return freeze({ownerNoLimitsDecisions:[],tool,codeIdentity:';
if(original.split(from).length!==2)throw new Error('Full access mutation site is not unique');
let status;
try{
  writeFileSync(file,original.replace(from,to));
  writeFileSync(`${directory}/M-NL-Full-access-twin-diverging.before`,original);
  const diff=spawnSync('diff',['-u',`${directory}/M-NL-Full-access-twin-diverging.before`,file],{encoding:'utf8'});
  writeFileSync(`${directory}/M-NL-Full-access-twin-diverging.patch`,diff.stdout??'');
  status=run('M-NL-Full-access-twin-diverging');
}finally{writeFileSync(file,original);utimesSync(file,stamp.atime,stamp.mtime);}
writeFileSync(`${directory}/matrix.json`,JSON.stringify({name:'M-NL-Full-access-twin-diverging',status,killed:status===1},null,2)+'\n');
if(status!==1)process.exitCode=1;
