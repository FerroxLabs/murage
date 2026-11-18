// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdirSync,readFileSync,writeFileSync,statSync,utimesSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const directory='evidence/nlsym-A2/C5-mutants';mkdirSync(directory,{recursive:true});
const mutants=[
 ['M-NL-S1-destination-strings','server/decision/action.ts','decisions.push(...inspection.decisions.map(structuredOwnerDecision));', 'void inspection;'],
 ['M-NL-owner-class-reclassified','server/decision/action.ts','inspection.decisions.map(structuredOwnerDecision)', 'inspection.decisions.filter(d=>protectedClass(d.lexical)).map(structuredOwnerDecision)'],
 ['M-NL-Full-access-twin-diverging','server/decision/action.ts','targets:targets.slice(0,256),content});', 'targets:targets.slice(0,256),content,ownerDecisions:[]});'],
 ['M-NL-inode-check-optional','server/no-limits-fs.ts',"if (resolution.kind === 'known' && effect.followFinal && !['delete',", "if (false && resolution.kind === 'known' && effect.followFinal && !['delete',"],
 ['M-NL-code-language-erased','server/no-limits-inspection.ts'," if(operation.kind==='native')return inspectNoLimits(operation,context);", " if(operation.kind==='code')return inspectNoLimits({kind:'exec',dialect:'sh',text:operation.text,cwd:operation.cwd,cwdInvalid:operation.cwdInvalid},context);\n if(operation.kind==='native')return inspectNoLimits(operation,context);"],
];
function run(name,full=false){const r=spawnSync('node_modules/.bin/vitest',['run',full?'server/no-limits-symlink-r31.test.ts':'server/no-limits-owner-integration.test.ts'],{encoding:'utf8',timeout:120000,env:{...process.env,...(full?{NLSYM_FULL_ONLY:'1'}:{})}});const log=(r.stdout??'')+(r.stderr??'');writeFileSync(`${directory}/${name}.log`,log);return {status:r.status,assertion:/AssertionError/.test(log),invalid:/Transform failed|SyntaxError|Failed to resolve/.test(log)};}
if(run('baseline').status!==0||run('full-baseline',true).status!==0)throw new Error('baseline failed');
const matrix=[];
for(const [name,file,from,to]of mutants){const original=readFileSync(file,'utf8'),stamp=statSync(file);if(!original.includes(from))throw new Error('nonunique '+name);try{writeFileSync(file,original.replaceAll(from,to));writeFileSync(`${directory}/${name}.before`,original);writeFileSync(`${directory}/${name}.patch`,spawnSync('diff',['-u',`${directory}/${name}.before`,file],{encoding:'utf8'}).stdout);const r=run(name,name.includes('Full-access'));matrix.push({name,...r,killed:r.status===1&&r.assertion&&!r.invalid});}finally{writeFileSync(file,original);utimesSync(file,stamp.atime,stamp.mtime);}}
writeFileSync(`${directory}/matrix.json`,JSON.stringify(matrix,null,2)+'\n');if(matrix.some(m=>!m.killed))process.exitCode=1;
