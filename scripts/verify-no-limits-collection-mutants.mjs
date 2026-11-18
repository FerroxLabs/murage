// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only inside the lane's isolated test container. Always restore the source.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const file='server/no-limits-collect.ts', original=readFileSync(file,'utf8');
const directory='evidence/nlsym/C1-mutants';mkdirSync(directory,{recursive:true});
const mutants=[
  ['M-NL-eval-legacy-null',"if(name==='eval'){","if(false && name==='eval'){"],
  ['M-NL-procsub-parent-separated',"if(p.kind==='subst'||p.kind==='procsub')","if(p.kind==='subst')"],
  ['M-NL-Windows-dispatch-missing','windows(body,inner,id,dialect);','void 0;'],
];
function run(label){
  const result=spawnSync('node_modules/.bin/vitest',['run','server/no-limits-collect.test.ts'],{encoding:'utf8',timeout:60000});
  writeFileSync(`${directory}/${label}.log`,`${result.stdout??''}${result.stderr??''}${result.error??''}`);
  return result.status;
}
if(run('baseline')!==0)throw new Error('Mutant baseline must pass');
const matrix=[];
try{
  for(const [name,from,to]of mutants){
    if(original.split(from).length!==2)throw new Error(`${name}: mutation site is not unique`);
    const modified=original.replace(from,to);
    writeFileSync(file,modified);
    writeFileSync(`${directory}/${name}.before`,original);
    const diff=spawnSync('diff',['-u',`${directory}/${name}.before`,file],{encoding:'utf8'});
    writeFileSync(`${directory}/${name}.patch`,diff.stdout??'');
    const status=run(name);
    matrix.push({name,status,killed:status===1});
    writeFileSync(file,original);
  }
}finally{writeFileSync(file,original);}
writeFileSync(`${directory}/matrix.json`,JSON.stringify(matrix,null,2)+'\n');
if(matrix.some(m=>!m.killed))process.exitCode=1;
